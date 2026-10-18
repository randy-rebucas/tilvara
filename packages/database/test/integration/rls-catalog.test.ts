import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { isolationProblems, NON_TENANT_TABLES, NULLABLE_TENANT_TABLES } from '../../src/backup/catalog.js';
import { EXPORT_EXCLUDED_TABLES, EXPORT_SECRET_COLUMNS } from '../../src/export/data-export.js';
import { TEST_DATABASE_MIGRATOR_URL } from './env.js';

/**
 * Schema-wide isolation guard: inspects the system catalog so that any table, foreign key or
 * SECURITY DEFINER function added later without the tenant-isolation checklist (CLAUDE.md)
 * fails here instead of in production. Data-level probes live in the API isolation suite.
 */
const pool = new pg.Pool({ connectionString: TEST_DATABASE_MIGRATOR_URL, max: 2 });

afterAll(async () => {
  await pool.end();
});

// NON_TENANT_TABLES (deliberately not keyed by tenant_id, with the reason) and NULLABLE_TENANT_TABLES
// live in src/backup/catalog.ts: the restore drill applies the same rules to a restored database.

/**
 * High-write leaf tables that nothing references, so UNIQUE(tenant_id, id) would only add index
 * cost. Add the constraint (and drop the entry) before any table references one of these.
 */
const UNREFERENCED_LEAF_TABLES: Record<string, string> = {
  audit_logs: 'append-only log',
  idempotency_records: 'request replay cache, purged',
  outbox_events: 'delivery queue',
  subscriptions: 'one row per tenant (UNIQUE tenant_id)',
};

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await pool.query<T>(sql, params)).rows;

async function publicTables() {
  return q<{ name: string; rls: boolean; forced: boolean; has_tenant: boolean; tenant_not_null: boolean; has_id: boolean }>(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull) AS tenant_not_null,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped) AS has_id
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND c.relname <> '__drizzle_migrations'
     ORDER BY 1`);
}

describe('schema isolation catalog', () => {
  it('every table is either tenant-keyed (NOT NULL tenant_id) or explicitly allow-listed', async () => {
    const offenders = (await publicTables())
      .filter((t) => !(t.name in NON_TENANT_TABLES))
      .filter((t) => !t.has_tenant || (!t.tenant_not_null && !(t.name in NULLABLE_TENANT_TABLES)))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('every tenant table has ENABLE + FORCE RLS and only the canonical tenant_id policy', async () => {
    const tables = (await publicTables()).filter((t) => t.has_tenant);
    expect(tables.length).toBeGreaterThan(15);
    const policies = await q<{ table: string; cmd: string; permissive: boolean; roles: string; qual: string | null; check: string | null }>(`
      SELECT c.relname AS table, p.polcmd AS cmd, p.polpermissive AS permissive, p.polroles::text AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace`);
    const canonical = '(tenant_id = app_current_tenant_id())';
    const problems: string[] = [];
    for (const t of tables) {
      if (!t.rls || !t.forced) problems.push(`${t.name}: RLS not enabled+forced`);
      const own = policies.filter((p) => p.table === t.name);
      if (own.length === 0) problems.push(`${t.name}: no policy`);
      for (const p of own) {
        // A second permissive policy would OR-widen visibility; anything non-canonical needs review here.
        if (!p.permissive || p.cmd !== '*' || p.roles !== '{0}' || p.qual !== canonical || p.check !== canonical) {
          problems.push(`${t.name}: non-canonical policy ${JSON.stringify(p)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the shared isolation rules (also run by the restore drill) find nothing', async () => {
    expect(await isolationProblems(pool)).toEqual([]);
  });

  it('allow-listed non-tenant tables keep their reviewed posture', async () => {
    const byName = Object.fromEntries((await publicTables()).map((t) => [t.name, t]));
    const credentialTables = ['user_sessions', 'user_mfa_factors', 'user_mfa_recovery_codes', 'password_reset_tokens', 'email_change_tokens'];
    for (const name of ['tenants', 'users', 'worker_heartbeats', 'backup_runs', 'platform_staff', ...credentialTables]) {
      expect([name, byName[name]?.rls, byName[name]?.forced]).toEqual([name, true, true]);
    }
    // Platform-only tables: reached through SECURITY DEFINER functions, never by a login role
    // (the backup login reads everything through pg_read_all_data, asserted below).
    const platformOnly = await q(
      `SELECT table_name, grantee, privilege_type FROM information_schema.table_privileges
        WHERE grantee IN ('onepos_app', 'onepos_readonly', 'onepos_worker', 'onepos_backup')
          AND table_name IN ('worker_heartbeats', 'backup_runs', 'platform_staff')`,
    );
    expect(platformOnly).toEqual([]);
    // Credential tables: no privilege of any kind for the runtime or read-only roles.
    const credentialAccess = await q(
      `SELECT table_name, grantee, privilege_type FROM information_schema.table_privileges
        WHERE grantee IN ('onepos_app', 'onepos_readonly') AND table_name = ANY ($1)`,
      [credentialTables],
    );
    expect(credentialAccess).toEqual([]);
    const secretColumns = await q(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee IN ('onepos_app', 'onepos_readonly') AND table_name = 'users'
          AND column_name IN ('password_hash', 'privileged_since', 'failed_login_count', 'locked_until', 'closed_at')`,
    );
    expect(secretColumns).toEqual([]);
    const writes = await q<{ table: string; priv: string }>(`
      SELECT table_name AS table, privilege_type AS priv FROM information_schema.table_privileges
       WHERE grantee = 'onepos_app' AND table_schema = 'public'
         AND table_name IN ('permissions', 'plans', 'discount_schemes', 'user_sessions', 'tenants', 'users')
         AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')`);
    expect(writes).toEqual([]);
    const sessionReads = await q(`SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'onepos_app' AND table_name = 'user_sessions'`);
    expect(sessionReads).toEqual([]);
    const hashRead = await q(`SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'onepos_app' AND table_name = 'users' AND column_name = 'password_hash' AND privilege_type = 'SELECT'`);
    expect(hashRead).toEqual([]);
  });

  it('every tenant table exposes UNIQUE(tenant_id, id) for composite foreign keys', async () => {
    const tables = (await publicTables()).filter((t) => t.has_tenant && t.has_id).map((t) => t.name);
    const withKey = await q<{ table: string }>(`
      SELECT DISTINCT c.relname AS table
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indpred IS NULL
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['id', 'tenant_id']`);
    const missing = tables.filter((t) => !withKey.some((w) => w.table === t) && !(t in UNREFERENCED_LEAF_TABLES));
    expect(missing).toEqual([]);
    const referenced = await q<{ to: string }>(
      `SELECT confrelid::regclass::text AS to FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    );
    expect(referenced.map((r) => r.to).filter((t) => t in UNREFERENCED_LEAF_TABLES)).toEqual([]);
  });

  it('foreign keys between tenant tables always include tenant_id (no cross-tenant references)', async () => {
    const fks = await q<{ name: string; from: string; to: string; cols: string[] }>(`
      SELECT k.conname AS name, k.conrelid::regclass::text AS from, k.confrelid::regclass::text AS to,
             (SELECT array_agg(a.attname::text) FROM pg_attribute a WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) AS cols
        FROM pg_constraint k
       WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`);
    const tenantTables = new Set((await publicTables()).filter((t) => t.has_tenant).map((t) => t.name));
    const bad = fks.filter((f) => tenantTables.has(f.from) && tenantTables.has(f.to) && !f.cols.includes('tenant_id'));
    expect(bad).toEqual([]);
  });

  it('the runtime role owns nothing and cannot TRUNCATE, TRIGGER or REFERENCES around RLS', async () => {
    const owned = await q(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND pg_get_userbyid(relowner) = 'onepos_app'`);
    expect(owned).toEqual([]);
    const dangerous = await q(`
      SELECT table_name, privilege_type FROM information_schema.table_privileges
       WHERE grantee IN ('onepos_app', 'onepos_readonly', 'PUBLIC') AND table_schema = 'public'
         AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')`);
    expect(dangerous).toEqual([]);
    const roles = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN ('onepos_app', 'onepos_readonly', 'onepos_worker') ORDER BY 1`);
    expect(roles).toEqual([
      { rolname: 'onepos_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
      { rolname: 'onepos_readonly', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
      { rolname: 'onepos_worker', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
    ]);
  });

  it('the worker role (ADR-0016) owns nothing, writes no table directly and reads only what handlers need', async () => {
    const owned = await q(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND pg_get_userbyid(relowner) = 'onepos_worker'`);
    expect(owned).toEqual([]);
    const tableWrites = await q(`SELECT table_name, privilege_type FROM information_schema.table_privileges
       WHERE grantee = 'onepos_worker' AND table_schema = 'public' AND privilege_type <> 'SELECT'`);
    expect(tableWrites).toEqual([]);
    const columnWrites = await q(`SELECT table_name, column_name FROM information_schema.column_privileges
       WHERE grantee = 'onepos_worker' AND table_schema = 'public' AND privilege_type <> 'SELECT'`);
    expect(columnWrites).toEqual([]);
    // Reads: the welcome mail's users/tenants columns, and every tenant table a data export writes
    // (ADR-0016 slice 6), always under RLS inside the event's tenant. Nothing internal, nothing platform.
    const tenantTables = (await publicTables()).filter((t) => t.has_tenant).map((t) => t.name);
    const readable = await q<{ t: string }>(`SELECT DISTINCT table_name AS t FROM information_schema.column_privileges
       WHERE grantee = 'onepos_worker' AND table_schema = 'public' AND privilege_type = 'SELECT' ORDER BY 1`);
    const expected = [...tenantTables.filter((t) => !(t in EXPORT_EXCLUDED_TABLES)), 'tenants', 'users'].sort();
    expect(readable.map((r) => r.t)).toEqual(expected);
    // Every exported table is readable in full, except the secret columns, which never are.
    const { rows: gaps } = await pool.query<{ t: string; c: string }>(`
      SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = ANY ($1)
         AND NOT has_column_privilege('onepos_worker', format('public.%I', c.table_name), c.column_name, 'SELECT')`, [tenantTables.filter((t) => !(t in EXPORT_EXCLUDED_TABLES))]);
    const byName = (x: { t: string; c: string }, y: { t: string; c: string }) => `${x.t}.${x.c}`.localeCompare(`${y.t}.${y.c}`);
    const secret = Object.entries(EXPORT_SECRET_COLUMNS).flatMap(([t, cols]) => cols.map((c) => ({ t, c })));
    expect(gaps.sort(byName)).toEqual(secret.sort(byName));
    for (const t of Object.keys(EXPORT_EXCLUDED_TABLES)) expect([t, tenantTables.includes(t)]).toEqual([t, true]);
    const userSecrets = await q(`SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'onepos_worker' AND table_name = 'users' AND column_name IN ('password_hash', 'failed_login_count', 'locked_until', 'privileged_since')`);
    expect(userSecrets).toEqual([]);
    // Only the worker may drive the outbox.
    const [claim] = await q<{ app: boolean; worker: boolean }>(`SELECT
       has_function_privilege('onepos_app', 'outbox_claim(text, int, int)', 'EXECUTE') AS app,
       has_function_privilege('onepos_worker', 'outbox_claim(text, int, int)', 'EXECUTE') AS worker`);
    expect(claim).toEqual({ app: false, worker: true });
    const [extend] = await q<{ app: boolean; worker: boolean }>(`SELECT
       has_function_privilege('onepos_app', 'outbox_extend(uuid, text, int)', 'EXECUTE') AS app,
       has_function_privilege('onepos_worker', 'outbox_extend(uuid, text, int)', 'EXECUTE') AS worker`);
    expect(extend).toEqual({ app: false, worker: true });
    // Monitoring (ADR-0016 slice 3): the API reads the gauges; the worker beats and replays DEAD rows.
    const { rows: monitoring } = await pool.query<{ fn: string; app: boolean; worker: boolean; readonly: boolean }>(`
      SELECT f AS fn, has_function_privilege('onepos_app', f, 'EXECUTE') AS app,
             has_function_privilege('onepos_worker', f, 'EXECUTE') AS worker,
             has_function_privilege('onepos_readonly', f, 'EXECUTE') AS readonly
        FROM unnest(ARRAY['platform_metrics()', 'platform_migration_head()', 'worker_heartbeat(text, timestamptz, text)',
                          'worker_heartbeat_stop(text)', 'outbox_dead_list(int, text)', 'outbox_dead_replay(uuid, text, text)']) AS f`);
    expect(monitoring).toEqual([
      { fn: 'platform_metrics()', app: true, worker: false, readonly: false },
      { fn: 'platform_migration_head()', app: true, worker: false, readonly: false },
      { fn: 'worker_heartbeat(text, timestamptz, text)', app: false, worker: true, readonly: false },
      { fn: 'worker_heartbeat_stop(text)', app: false, worker: true, readonly: false },
      { fn: 'outbox_dead_list(int, text)', app: false, worker: true, readonly: false },
      { fn: 'outbox_dead_replay(uuid, text, text)', app: false, worker: true, readonly: false },
    ]);
  });

  it('the backup login (ADR-0016 slice 4) reads every row but owns and writes nothing', async () => {
    const [role] = await q<{ login: boolean; su: boolean; bypass: boolean; createdb: boolean; createrole: boolean; readall: boolean; writeall: boolean }>(`
      SELECT rolcanlogin AS login, rolsuper AS su, rolbypassrls AS bypass, rolcreatedb AS createdb, rolcreaterole AS createrole,
             pg_has_role('onepos_backup', 'pg_read_all_data', 'member') AS readall,
             pg_has_role('onepos_backup', 'pg_write_all_data', 'member') AS writeall
        FROM pg_roles WHERE rolname = 'onepos_backup'`);
    // BYPASSRLS is the point: a dump under FORCE RLS would otherwise hold no tenant rows.
    expect(role).toEqual({ login: true, su: false, bypass: true, createdb: false, createrole: false, readall: true, writeall: false });
    const owned = await q(`SELECT relname FROM pg_class WHERE pg_get_userbyid(relowner) = 'onepos_backup'`);
    expect(owned).toEqual([]);
    const granted = await q(`SELECT table_name, privilege_type FROM information_schema.table_privileges WHERE grantee = 'onepos_backup'`);
    expect(granted).toEqual([]);
    const fns = await q<{ fn: string; app: boolean; worker: boolean; backup: boolean }>(`
      SELECT f AS fn, has_function_privilege('onepos_app', f, 'EXECUTE') AS app, has_function_privilege('onepos_worker', f, 'EXECUTE') AS worker,
             has_function_privilege('onepos_backup', f, 'EXECUTE') AS backup
        FROM unnest(ARRAY['platform_record_backup(text, timestamptz, text, bigint, text, int, jsonb)', 'platform_metrics()']) AS f`);
    expect(fns).toEqual([
      { fn: 'platform_record_backup(text, timestamptz, text, bigint, text, int, jsonb)', app: false, worker: false, backup: true },
      { fn: 'platform_metrics()', app: true, worker: false, backup: false },
    ]);
  });

  it('SECURITY DEFINER functions are platform-owned, pin search_path and are not PUBLIC-executable', async () => {
    const fns = await q<{ name: string; owner: string; config: string[] | null; public_exec: boolean }>(`
      SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`);
    expect(fns.length).toBeGreaterThan(10);
    const bad = fns.filter(
      (f) => f.owner !== 'onepos_platform' || !(f.config ?? []).some((c) => c.startsWith('search_path=')) || f.public_exec,
    );
    expect(bad).toEqual([]);
    // Subscription changes are billing-only: tenants must not be able to upgrade themselves.
    const [setSub] = await q<{ ok: boolean }>(
      `SELECT has_function_privilege('onepos_app', 'platform_set_subscription(uuid, text, text, timestamptz, timestamptz)', 'EXECUTE') AS ok`,
    );
    expect(setSub!.ok).toBe(false);
    // MFA resets (session 10): the business resets its own members; support resets need ops credentials.
    const resets = await q<{ fn: string; app: boolean; worker: boolean; readonly: boolean; migrator: boolean }>(`
      SELECT f AS fn, has_function_privilege('onepos_app', f, 'EXECUTE') AS app, has_function_privilege('onepos_worker', f, 'EXECUTE') AS worker,
             has_function_privilege('onepos_readonly', f, 'EXECUTE') AS readonly, has_function_privilege('onepos_migrator', f, 'EXECUTE') AS migrator
        FROM unnest(ARRAY['auth_mfa_admin_reset(uuid, uuid, text, text)', 'auth_members_mfa()', 'auth_mfa_support_reset(text, text, text, text)']) AS f`);
    // Support access and exports (ADR-0016 slice 6): staff are managed with ops credentials; the API
    // uses grants; only the worker finishes and expires exports.
    const slice6 = await q<{ fn: string; app: boolean; worker: boolean; readonly: boolean }>(`
      SELECT f AS fn, has_function_privilege('onepos_app', f, 'EXECUTE') AS app, has_function_privilege('onepos_worker', f, 'EXECUTE') AS worker,
             has_function_privilege('onepos_readonly', f, 'EXECUTE') AS readonly
        FROM unnest(ARRAY['support_staff_add(text, text, text)', 'support_staff_disable(text, text, text)', 'support_staff_list()',
                          'auth_staff_active(uuid)', 'support_list_grants(uuid)', 'support_open_grant(uuid, uuid, uuid, text)', 'auth_resolve_support(uuid, uuid, uuid)',
                          'data_export_finish(uuid, text, bigint, text, jsonb, timestamptz)', 'data_export_fail(uuid, text)',
                          'data_export_due_expiry(int)', 'data_export_mark_expired(uuid, uuid)']) AS f`);
    const none = { app: false, worker: false, readonly: false };
    const app = { app: true, worker: false, readonly: false };
    const worker = { app: false, worker: true, readonly: false };
    expect(slice6.map(({ fn, ...r }) => [fn.split('(')[0], r])).toEqual([
      ['support_staff_add', none], ['support_staff_disable', none], ['support_staff_list', none],
      ['auth_staff_active', app], ['support_list_grants', app], ['support_open_grant', app], ['auth_resolve_support', app],
      ['data_export_finish', worker], ['data_export_fail', worker], ['data_export_due_expiry', worker], ['data_export_mark_expired', worker],
    ]);
    const [staffMigrator] = await q<{ ok: boolean }>(`SELECT has_function_privilege('onepos_migrator', 'support_staff_add(text, text, text)', 'EXECUTE') AS ok`);
    expect(staffMigrator!.ok).toBe(true);
    // (The migrator inherits the runtime role's rights, so only the support reset's "migrator only" is asserted.)
    expect(resets.map(({ migrator, ...r }) => (r.fn.startsWith('auth_mfa_support_reset') ? { ...r, migrator } : r))).toEqual([
      { fn: 'auth_mfa_admin_reset(uuid, uuid, text, text)', app: true, worker: false, readonly: false },
      { fn: 'auth_members_mfa()', app: true, worker: false, readonly: false },
      { fn: 'auth_mfa_support_reset(text, text, text, text)', app: false, worker: false, readonly: false, migrator: true },
    ]);
  });
});
