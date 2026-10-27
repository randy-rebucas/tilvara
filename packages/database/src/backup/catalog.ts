import { createHash } from 'node:crypto';
import type pg from 'pg';

/** Anything that runs a query: a pool, a client, a client inside a transaction. */
export type Queryable = Pick<pg.ClientBase, 'query'>;

/** Schemas the application owns; everything else (pg_catalog, information_schema) is Postgres'. */
export const APP_SCHEMAS = ['public', 'drizzle'] as const;

/** Tables that are deliberately not keyed by tenant_id, with the reason (reviewed in rls-catalog.test.ts). */
export const NON_TENANT_TABLES: Record<string, string> = {
  tenants: 'the tenant itself; policy tenant_self (id = current tenant)',
  users: 'global identities; policies users_visible / users_self_update',
  user_sessions: 'no runtime access at all; only auth_* SECURITY DEFINER functions',
  user_mfa_factors: 'per-user TOTP secret (encrypted); no runtime access, only auth_mfa_* functions',
  user_mfa_recovery_codes: 'per-user recovery code hashes; no runtime access, only auth_mfa_* functions',
  password_reset_tokens: 'per-user reset token hashes; no runtime access, only auth_password_reset_* functions',
  email_change_tokens: 'per-user email change link hashes and the new address; no runtime access, only auth_email_change_* functions',
  permissions: 'global read-only permission catalog',
  plans: 'global read-only plan catalog',
  extensions: 'global read-only extension catalog (ADR-0026)',
  discount_schemes: 'global statutory discount schemes (SC/PWD), platform-maintained, read-only to tenants',
  worker_heartbeats: 'one row per outbox worker; no runtime access, only worker_heartbeat* and platform_metrics()',
  backup_runs: 'successful backups and restore drills; no runtime access, only platform_record_backup() and platform_metrics()',
  platform_staff: 'Tilvara support staff; no runtime access, only the support_* / auth_staff_active / auth_resolve_support functions',
  billing_provider_events: 'payment provider webhook events, once each (ADR-0027); no runtime access, only billing_apply_provider_payment()',
  billing_seller: 'Tilvara as issuer of receipts to the businesses, one row (ADR-0027); no runtime access, only billing_issue_receipt() and the support CLI',
};

/** Tenant tables whose tenant_id may be NULL; such rows match no tenant policy (fail closed). */
export const NULLABLE_TENANT_TABLES: Record<string, string> = {
  audit_logs: 'NULL tenant = platform-level event, visible to no tenant',
};

/** Non-tenant tables that must still have RLS enabled and forced (reached through functions or self policies). */
export const FORCED_NON_TENANT_TABLES = [
  'tenants',
  'users',
  'worker_heartbeats',
  'backup_runs',
  'platform_staff',
  'billing_provider_events',
  'billing_seller',
  'user_sessions',
  'user_mfa_factors',
  'user_mfa_recovery_codes',
  'password_reset_tokens',
  'email_change_tokens',
] as const;

const CANONICAL_POLICY = '(tenant_id = app_current_tenant_id())';

export interface PublicTable {
  name: string;
  rls: boolean;
  forced: boolean;
  has_tenant: boolean;
  tenant_not_null: boolean;
  has_id: boolean;
}

export async function publicTables(db: Queryable): Promise<PublicTable[]> {
  const { rows } = await db.query<PublicTable>(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull) AS tenant_not_null,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped) AS has_id
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND c.relname <> '__drizzle_migrations'
     ORDER BY 1`);
  return rows;
}

/**
 * The tenant-isolation rules every database must satisfy (CLAUDE.md checklist): each table is
 * tenant-keyed or allow-listed, each tenant table has ENABLE + FORCE RLS and only the canonical
 * policy, and the allow-listed tables that need it are forced too. Returns the problems, [] when sound.
 * Shared by the schema guard (rls-catalog.test.ts) and the restore drill.
 */
export async function isolationProblems(db: Queryable): Promise<string[]> {
  const tables = await publicTables(db);
  const problems: string[] = [];
  for (const t of tables) {
    if (t.name in NON_TENANT_TABLES) continue;
    if (!t.has_tenant) problems.push(`${t.name}: no tenant_id and not allow-listed`);
    else if (!t.tenant_not_null && !(t.name in NULLABLE_TENANT_TABLES)) problems.push(`${t.name}: tenant_id is nullable`);
  }
  const { rows: policies } = await db.query<{ table: string; cmd: string; permissive: boolean; roles: string; qual: string | null; check: string | null }>(`
    SELECT c.relname AS table, p.polcmd AS cmd, p.polpermissive AS permissive, p.polroles::text AS roles,
           pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS check
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace`);
  const tenantTables = tables.filter((t) => t.has_tenant);
  if (tenantTables.length <= 15) problems.push(`only ${tenantTables.length} tenant tables: wrong database?`);
  for (const t of tenantTables) {
    if (!t.rls || !t.forced) problems.push(`${t.name}: RLS not enabled+forced`);
    const own = policies.filter((p) => p.table === t.name);
    if (own.length === 0) problems.push(`${t.name}: no policy`);
    for (const p of own) {
      // A second permissive policy would OR-widen visibility; anything non-canonical needs review.
      if (!p.permissive || p.cmd !== '*' || p.roles !== '{0}' || p.qual !== CANONICAL_POLICY || p.check !== CANONICAL_POLICY) {
        problems.push(`${t.name}: non-canonical policy ${JSON.stringify(p)}`);
      }
    }
  }
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const name of FORCED_NON_TENANT_TABLES) {
    const t = byName.get(name);
    if (!t) problems.push(`${name}: missing`);
    else if (!t.rls || !t.forced) problems.push(`${name}: RLS not enabled+forced`);
  }
  return problems;
}

/** Applied migrations, as drizzle records them. */
export async function migrationHead(db: Queryable): Promise<{ count: number; lastCreatedAt: number | null }> {
  const { rows: [head] } = await db.query<{ count: number; last: string | null }>(
    'SELECT count(*)::int AS count, max(created_at)::text AS last FROM drizzle.__drizzle_migrations',
  );
  return { count: head!.count, lastCreatedAt: head!.last === null ? null : Number(head!.last) };
}

/** Exact row count of every application table (schema-qualified name → rows), in the caller's snapshot. */
export async function tableRowCounts(db: Queryable): Promise<Record<string, number>> {
  const { rows: tables } = await db.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY ($1) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY 1`,
    [APP_SCHEMAS],
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const { rows: [r] } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${name}`);
    counts[name] = Number(r!.n);
  }
  return counts;
}

/** Privileges of an ACL as sorted `grantee:PRIVILEGE[*]` strings; NULL means the owner's defaults. */
const acl = (expr: string, kindSql: string, owner: string) => `(
  SELECT coalesce(array_agg(g ORDER BY g), '{}') FROM (
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type
           || CASE WHEN a.is_grantable THEN '*' ELSE '' END AS g
      FROM aclexplode(coalesce(${expr}, acldefault(${kindSql}, ${owner}))) a) x)`;

/**
 * Everything about the schema that decides who can see and do what: owners and privileges of
 * schemas, tables, sequences, columns and functions; RLS flags and policies; SECURITY DEFINER and
 * pinned search paths; triggers (append-only guards, costing); default privileges; extensions.
 * A restored database must reproduce it exactly. Grantors are left out (a restore may re-grant as
 * another role); privileges are compared as sets.
 */
export async function catalogPosture(db: Queryable): Promise<Record<string, unknown[]>> {
  const q = async (sql: string) => (await db.query(sql, sql.includes('$1') ? [APP_SCHEMAS] : [])).rows;
  const inApp = (col: string) => `${col} = ANY ($1::text[])`;
  return {
    schemas: await q(`
      SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner, ${acl('n.nspacl', "'n'", 'n.nspowner')} AS acl
        FROM pg_namespace n WHERE ${inApp('n.nspname')} ORDER BY 1`),
    relations: await q(`
      SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner,
             ${acl('c.relacl', `(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char"`, 'c.relowner')} AS acl,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${inApp('n.nspname')} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') ORDER BY 1`),
    columns: await q(`
      SELECT n.nspname || '.' || c.relname || '.' || a.attname AS name,
             (SELECT array_agg(g ORDER BY g) FROM (
                SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type AS g
                  FROM aclexplode(a.attacl) x) y) AS acl
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${inApp('n.nspname')} AND a.attacl IS NOT NULL AND NOT a.attisdropped AND a.attnum > 0 ORDER BY 1`),
    policies: await q(`
      SELECT n.nspname || '.' || c.relname || '.' || p.polname AS name, p.polcmd::text AS cmd, p.polpermissive AS permissive,
             (SELECT array_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY 1) FROM unnest(p.polroles) r) AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${inApp('n.nspname')} ORDER BY 1`),
    functions: await q(`
      SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
             pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.proconfig AS config,
             ${acl('p.proacl', "'f'", 'p.proowner')} AS acl, md5(p.prosrc) AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${inApp('n.nspname')} ORDER BY 1`),
    triggers: await q(`
      SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${inApp('n.nspname')} AND NOT t.tgisinternal ORDER BY 1`),
    defaultPrivileges: await q(`
      SELECT pg_get_userbyid(d.defaclrole) AS role, coalesce(n.nspname, '') AS schema, d.defaclobjtype::text AS type,
             (SELECT array_agg(g ORDER BY g) FROM (
                SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type AS g
                  FROM aclexplode(d.defaclacl) x) y) AS acl
        FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE n.nspname IS NULL OR ${inApp('n.nspname')} ORDER BY 1, 2, 3`),
    extensions: await q(`SELECT e.extname AS name, e.extversion AS version FROM pg_extension e ORDER BY 1`),
  };
}

/** Canonical JSON (sorted keys) so equal postures always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The entries that differ between two postures, by section and object name (at most `limit`). */
export function postureDiff(expected: Record<string, unknown[]>, actual: Record<string, unknown[]>, limit = 20): string[] {
  const out: string[] = [];
  for (const section of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const index = (rows: unknown[] = []) =>
      new Map(rows.map((r) => [String((r as { name?: unknown }).name ?? canonicalJson(r)), canonicalJson(r)]));
    const a = index(expected[section]);
    const b = index(actual[section]);
    for (const [name, row] of a) {
      if (!b.has(name)) out.push(`${section} ${name}: missing after restore`);
      else if (b.get(name) !== row) out.push(`${section} ${name}: differs (${row} → ${b.get(name)})`);
    }
    for (const name of b.keys()) if (!a.has(name)) out.push(`${section} ${name}: not in the backup`);
  }
  return out.slice(0, limit);
}
