import { Decrypter, Encrypter } from 'age-encryption';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import {
  canonicalJson,
  catalogPosture,
  isolationProblems,
  migrationHead,
  postureDiff,
  sha256Hex,
  tableRowCounts,
  type Queryable,
} from './catalog.js';
import { pgToolVersion, startPgTool, type PgTools } from './pg-tools.js';

export const MANIFEST_FORMAT = 'onepos-backup/1';
const BACKUP_FILE = /^onepos-[a-z0-9_]+-\d{8}T\d{6}Z\.dump\.age$/;

/** Written next to every backup. Counts and catalog facts only, never row contents. */
export interface BackupManifest {
  format: typeof MANIFEST_FORMAT;
  file: string;
  database: string;
  databaseOwner: string;
  serverVersion: string;
  pgDump: string;
  /** DB clock: the snapshot the dump and the counts share. */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  encryption: { scheme: 'age'; recipients: string[] };
  /** Encrypted file. */
  sizeBytes: number;
  sha256: string;
  /** Plain pg_dump custom-format archive, before encryption (never written to disk). */
  dumpBytes: number;
  migrations: { count: number; lastCreatedAt: number | null };
  rowCounts: Record<string, number>;
  totalRows: number;
  postureSha256: string;
  posture: Record<string, unknown[]>;
}

export interface BackupResult {
  manifest: BackupManifest;
  filePath: string;
  manifestPath: string;
  recordId: string;
}

export const manifestPathFor = (filePath: string) => filePath.replace(/\.dump\.age$/, '.manifest.json');

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** A pass-through that hashes and counts what flows by. */
function tap() {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

async function assertBypassesRls(db: Queryable, what: string) {
  const { rows: [who] } = await db.query<{ bypass: boolean; name: string }>(
    'SELECT current_user AS name, rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = current_user',
  );
  if (!who?.bypass) throw new Error(`${who?.name ?? 'This role'} is subject to RLS and would ${what} no tenant rows; use the backup login (onepos_backup)`);
}

/**
 * One encrypted logical backup (ADR-0016 slice 4).
 *
 * The counts, the catalog posture and the migration head are read in one REPEATABLE READ
 * transaction whose snapshot pg_dump then imports (`--snapshot`), so the manifest describes exactly
 * what the archive holds even while tills keep selling. The archive streams from pg_dump through
 * age (X25519 recipient: the server holds only the public key) to `<file>.partial`, which is renamed
 * only after pg_dump exits cleanly; plaintext never touches the disk. The run is then recorded with
 * `platform_record_backup()`, which feeds the backup-age gauge.
 */
export async function createBackup(opts: { url: string; recipients: string[]; dir: string; tools?: PgTools }): Promise<BackupResult> {
  if (opts.recipients.length === 0 || opts.recipients.some((r) => !r.startsWith('age1'))) {
    throw new Error('BACKUP_AGE_RECIPIENT must list age public keys (age1…); generate one with `backup keygen`');
  }
  await mkdir(opts.dir, { recursive: true });
  const client = new pg.Client({ connectionString: opts.url, application_name: 'onepos-backup' });
  await client.connect();
  let partial: string | null = null;
  try {
    await assertBypassesRls(client, 'dump');
    const pgDump = await pgToolVersion('pg_dump', opts.tools);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [snap] } = await client.query<{ snapshot: string; started: Date; db: string; owner: string; version: string }>(`
      SELECT pg_export_snapshot() AS snapshot, now() AS started, current_database() AS db,
             pg_get_userbyid(d.datdba) AS owner, current_setting('server_version') AS version
        FROM pg_database d WHERE d.datname = current_database()`);
    const startedAt = snap!.started;
    const file = `onepos-${snap!.db.toLowerCase().replace(/[^a-z0-9_]/g, '_')}-${stamp(startedAt)}.dump.age`;
    const filePath = join(opts.dir, file);
    partial = `${filePath}.partial`;

    const rowCounts = await tableRowCounts(client);
    const posture = await catalogPosture(client);
    const migrations = await migrationHead(client);

    const dump = startPgTool('pg_dump', opts.url, ['--format=custom', `--snapshot=${snap!.snapshot}`, '--dbname', snap!.db], opts.tools);
    dump.child.stdin!.end();
    const plain = tap();
    const cipher = tap();
    const encrypter = new Encrypter();
    for (const r of opts.recipients) encrypter.addRecipient(r);
    const plainWeb = Readable.toWeb(dump.child.stdout!.pipe(plain.stream)) as unknown as ReadableStream<Uint8Array>;
    const encrypted = await encrypter.encrypt(plainWeb);
    await Promise.all([
      pipeline(Readable.fromWeb(encrypted as unknown as WebReadableStream<Uint8Array>), cipher.stream, createWriteStream(partial, { mode: 0o600 })),
      dump.done,
    ]);
    await client.query('COMMIT');

    const { rows: [fin] } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const enc = cipher.result();
    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      file,
      database: snap!.db,
      databaseOwner: snap!.owner,
      serverVersion: snap!.version,
      pgDump,
      startedAt: startedAt.toISOString(),
      finishedAt: fin!.now.toISOString(),
      durationMs: fin!.now.getTime() - startedAt.getTime(),
      encryption: { scheme: 'age', recipients: opts.recipients },
      sizeBytes: enc.bytes,
      sha256: enc.sha256,
      dumpBytes: plain.result().bytes,
      migrations,
      rowCounts,
      totalRows: Object.values(rowCounts).reduce((a, b) => a + b, 0),
      postureSha256: sha256Hex(canonicalJson(posture)),
      posture,
    };
    await rename(partial, filePath);
    partial = null;
    const manifestPath = manifestPathFor(filePath);
    await writeFile(`${manifestPath}.partial`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(`${manifestPath}.partial`, manifestPath);

    const { rows: [rec] } = await client.query<{ id: string }>('SELECT platform_record_backup($1, $2, $3, $4, $5, $6, $7) AS id', [
      'BACKUP',
      startedAt,
      file,
      manifest.sizeBytes,
      manifest.sha256,
      migrations.count,
      { tables: Object.keys(rowCounts).length, rows: manifest.totalRows, dumpBytes: manifest.dumpBytes, durationMs: manifest.durationMs },
    ]);
    return { manifest, filePath, manifestPath, recordId: rec!.id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (partial) await rm(partial, { force: true });
    throw e;
  } finally {
    await client.end();
  }
}

export async function readManifest(manifestPath: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  if (m.format !== MANIFEST_FORMAT) throw new Error(`${basename(manifestPath)} is not a ${MANIFEST_FORMAT} manifest`);
  if (!BACKUP_FILE.test(m.file)) throw new Error(`${basename(manifestPath)} names an unexpected file: ${m.file}`);
  return m;
}

/** The newest backup manifest in a directory, or null. */
export async function latestManifest(dir: string): Promise<string | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^onepos-.*\.manifest\.json$/.test(n)).sort();
  return names.length ? join(dir, names[names.length - 1]!) : null;
}

/** The encrypted file is the one the manifest describes (size and SHA-256): a copy that rotted or was swapped is refused. */
export async function verifyBackupFile(manifestPath: string, manifest: BackupManifest): Promise<string> {
  const filePath = join(dirname(manifestPath), manifest.file);
  const { size } = await stat(filePath);
  if (size !== manifest.sizeBytes) throw new Error(`${manifest.file}: ${size} bytes, the manifest says ${manifest.sizeBytes}`);
  const t = tap();
  await pipeline(createReadStream(filePath), t.stream, devNull());
  const { sha256 } = t.result();
  if (sha256 !== manifest.sha256) throw new Error(`${manifest.file}: SHA-256 ${sha256} differs from the manifest's ${manifest.sha256}`);
  return filePath;
}

const devNull = () => new Writable({ write: (_chunk, _enc, cb) => cb() });

const SCRATCH_DB = /^onepos_drill_[a-z0-9_]{1,40}$/;

/**
 * Decrypt a backup and restore it into a NEW database (`onepos_drill_*`, created here from template0
 * and owned like the original). The identity (age secret key) stays in this process; the plaintext
 * archive streams from the decrypter into pg_restore and is never written to disk. Needs a superuser
 * login (owners, SECURITY DEFINER functions and grants are restored as they were); the roles must
 * already exist in the cluster (init/01-roles.sql).
 */
export async function restoreBackup(opts: {
  filePath: string;
  manifest: BackupManifest;
  identity: string;
  adminUrl: string;
  database: string;
  tools?: PgTools;
}): Promise<void> {
  if (!SCRATCH_DB.test(opts.database)) throw new Error(`refusing to restore into ${opts.database}: drills restore only into onepos_drill_* databases`);
  // The header is checked (the right key?) before anything is created.
  const decrypter = new Decrypter();
  decrypter.addIdentity(opts.identity);
  const plain = await decrypter.decrypt(Readable.toWeb(createReadStream(opts.filePath)) as unknown as ReadableStream<Uint8Array>);
  const admin = new pg.Client({ connectionString: opts.adminUrl, application_name: 'onepos-restore-drill' });
  await admin.connect();
  try {
    const { rows: [who] } = await admin.query<{ su: boolean }>('SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user');
    if (!who?.su) throw new Error('The restore needs a superuser login (DRILL_ADMIN_URL)');
    const { rows: missing } = await admin.query<{ role: string }>(
      `SELECT r AS role FROM unnest($1::text[]) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`,
      [[opts.manifest.databaseOwner, 'onepos_migrator', 'onepos_app', 'onepos_worker', 'onepos_readonly', 'onepos_platform', 'onepos_backup']],
    );
    if (missing.length) throw new Error(`roles missing in this cluster: ${missing.map((m) => m.role).join(', ')} (run infra/docker/postgres/init/01-roles.sql first)`);
    await admin.query(`CREATE DATABASE ${opts.database} OWNER ${pg.escapeIdentifier(opts.manifest.databaseOwner)} TEMPLATE template0 ENCODING 'UTF8'`);
  } catch (e) {
    await plain.cancel().catch(() => undefined);
    throw e;
  } finally {
    await admin.end();
  }
  const restore = startPgTool('pg_restore', opts.adminUrl, ['--exit-on-error', '--single-transaction', '--dbname', opts.database], opts.tools);
  await Promise.all([pipeline(Readable.fromWeb(plain as unknown as WebReadableStream<Uint8Array>), restore.child.stdin!), restore.done]);
}

export interface RestoreVerification {
  problems: string[];
  tables: number;
  rows: number;
  migrations: { count: number; lastCreatedAt: number | null };
  postureSha256: string;
}

/**
 * The restored database is the backed-up one: same migration head, the same rows in every table,
 * the same catalog posture (owners, grants, RLS, policies, SECURITY DEFINER functions, triggers),
 * and it still satisfies the tenant-isolation rules. Connect as a role that bypasses RLS.
 */
export async function verifyRestored(url: string, manifest: BackupManifest): Promise<RestoreVerification> {
  const c = new pg.Client({ connectionString: url, application_name: 'onepos-restore-drill' });
  await c.connect();
  try {
    await assertBypassesRls(c, 'count');
    const problems: string[] = [];
    const migrations = await migrationHead(c);
    if (migrations.count !== manifest.migrations.count || migrations.lastCreatedAt !== manifest.migrations.lastCreatedAt) {
      problems.push(`migration head ${JSON.stringify(migrations)} ≠ backup ${JSON.stringify(manifest.migrations)}`);
    }
    const counts = await tableRowCounts(c);
    for (const t of new Set([...Object.keys(manifest.rowCounts), ...Object.keys(counts)])) {
      if (counts[t] !== manifest.rowCounts[t]) problems.push(`rows in ${t}: ${counts[t] ?? 'missing'} restored, ${manifest.rowCounts[t] ?? 'none'} backed up`);
    }
    const posture = await catalogPosture(c);
    const postureSha256 = sha256Hex(canonicalJson(posture));
    if (postureSha256 !== manifest.postureSha256) problems.push(...postureDiff(manifest.posture, posture).map((d) => `posture: ${d}`));
    problems.push(...(await isolationProblems(c)).map((p) => `isolation: ${p}`));
    problems.push(...(await runtimeRoleProblems(c)).map((p) => `roles: ${p}`));
    return { problems, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), migrations, postureSha256 };
  } finally {
    await c.end();
  }
}

/**
 * Role attributes live in the cluster, not in the dump: a cluster rebuilt for a restore must still keep
 * the runtime roles under RLS (2026-10-27). Then, as the API's role, a business's context sees none of the
 * others' rows (one business is enough: an unknown business sees nothing at all).
 */
async function runtimeRoleProblems(c: pg.Client): Promise<string[]> {
  const problems: string[] = [];
  const { rows } = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('onepos_app', 'onepos_worker', 'onepos_readonly')`,
  );
  for (const name of ['onepos_app', 'onepos_worker', 'onepos_readonly']) {
    const r = rows.find((x) => x.rolname === name);
    if (!r) problems.push(`${name} is missing`);
    else if (r.rolsuper || r.rolbypassrls) problems.push(`${name} bypasses row-level security`);
    else if (name === 'onepos_readonly' && r.rolcanlogin) problems.push('onepos_readonly can log in');
  }
  const { rows: [can] } = await c.query<{ v: boolean }>(`SELECT pg_has_role(current_user, 'onepos_app', 'MEMBER') AS v`);
  if (!can?.v) return [...problems, 'cannot act as onepos_app to probe isolation'];
  const { rows: [t] } = await c.query<{ id: string | null }>('SELECT (SELECT id FROM tenants ORDER BY id LIMIT 1) AS id');
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE onepos_app');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t?.id ?? '00000000-0000-0000-0000-000000000000']);
    const { rows: [n] } = await c.query<{ tenants: string; sales: string; customers: string }>(
      `SELECT (SELECT count(*) FROM tenants WHERE id <> app_current_tenant_id()) AS tenants,
              (SELECT count(*) FROM sales WHERE tenant_id <> app_current_tenant_id()) AS sales,
              (SELECT count(*) FROM customers WHERE tenant_id <> app_current_tenant_id()) AS customers`,
    );
    if (Number(n!.tenants) + Number(n!.sales) + Number(n!.customers) !== 0) problems.push(`one business's context sees another's rows (${JSON.stringify(n)})`);
  } finally {
    await c.query('ROLLBACK');
  }
  return problems;
}

/**
 * Record a passed restore drill of `manifest`'s backup in the database that was backed up (where
 * the drill-age alert looks), through the backup login. Refuses when the URL names another database.
 */
export async function recordRestoreDrill(backupUrl: string, manifest: BackupManifest, startedAt: Date, detail: Record<string, unknown>): Promise<string> {
  const c = new pg.Client({ connectionString: backupUrl, application_name: 'onepos-restore-drill' });
  await c.connect();
  try {
    // The drill's start by the host clock may be ahead of the DB clock; never after "finished".
    const { rows: [db] } = await c.query<{ name: string; started: Date }>(
      'SELECT current_database() AS name, least(now(), $1::timestamptz) AS started',
      [startedAt],
    );
    if (db!.name !== manifest.database) throw new Error(`BACKUP_DATABASE_URL points at ${db!.name}; the backup is of ${manifest.database}`);
    const { rows: [rec] } = await c.query<{ id: string }>('SELECT platform_record_backup($1, $2, $3, $4, $5, $6, $7) AS id', [
      'RESTORE_DRILL',
      db!.started,
      manifest.file,
      manifest.sizeBytes,
      manifest.sha256,
      manifest.migrations.count,
      detail,
    ]);
    return rec!.id;
  } finally {
    await c.end();
  }
}

export async function dropScratchDatabase(adminUrl: string, database: string): Promise<void> {
  if (!SCRATCH_DB.test(database)) throw new Error(`refusing to drop ${database}`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Delete backups (file + manifest) older than `keepDays`, never the newest `keepAtLeast`. Only
 * files this tool names are touched. Off-site copies follow the storage's own retention (D1).
 */
export async function pruneBackups(dir: string, keepDays: number, keepAtLeast = 3, now = new Date()): Promise<string[]> {
  const manifests = (await readdir(dir)).filter((n) => /^onepos-.*\.manifest\.json$/.test(n)).sort();
  const removable = manifests.slice(0, Math.max(0, manifests.length - keepAtLeast));
  const removed: string[] = [];
  for (const name of removable) {
    const m = await readManifest(join(dir, name)).catch(() => null);
    if (!m || now.getTime() - Date.parse(m.finishedAt) < keepDays * 86_400_000) continue;
    await rm(join(dir, m.file), { force: true });
    await rm(join(dir, name), { force: true });
    removed.push(m.file);
  }
  return removed;
}
