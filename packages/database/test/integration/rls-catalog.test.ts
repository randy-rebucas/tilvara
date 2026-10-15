import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
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

/** Tables that are deliberately not keyed by tenant_id, with the reason. */
const NON_TENANT_TABLES: Record<string, string> = {
  tenants: 'the tenant itself; policy tenant_self (id = current tenant)',
  users: 'global identities; policies users_visible / users_self_update',
  user_sessions: 'no runtime access at all; only auth_* SECURITY DEFINER functions',
  permissions: 'global read-only permission catalog',
  plans: 'global read-only plan catalog',
};

/** Tenant tables whose tenant_id may be NULL; such rows match no tenant policy (fail closed). */
const NULLABLE_TENANT_TABLES: Record<string, string> = {
  audit_logs: 'NULL tenant = platform-level event, visible to no tenant',
};

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

  it('allow-listed non-tenant tables keep their reviewed posture', async () => {
    const byName = Object.fromEntries((await publicTables()).map((t) => [t.name, t]));
    for (const name of ['tenants', 'users', 'user_sessions']) {
      expect([name, byName[name]?.rls, byName[name]?.forced]).toEqual([name, true, true]);
    }
    const writes = await q<{ table: string; priv: string }>(`
      SELECT table_name AS table, privilege_type AS priv FROM information_schema.table_privileges
       WHERE grantee = 'onepos_app' AND table_schema = 'public'
         AND table_name IN ('permissions', 'plans', 'user_sessions', 'tenants', 'users')
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
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN ('onepos_app', 'onepos_readonly') ORDER BY 1`);
    expect(roles).toEqual([
      { rolname: 'onepos_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
      { rolname: 'onepos_readonly', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
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
  });
});
