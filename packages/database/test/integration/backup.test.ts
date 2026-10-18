import { generateIdentity, identityToRecipient } from 'age-encryption';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBackup,
  dropScratchDatabase,
  restoreBackup,
  verifyBackupFile,
  verifyRestored,
  type BackupResult,
} from '../../src/backup/backup.js';
import { tableRowCounts } from '../../src/backup/catalog.js';
import { pgToolsFromEnv, withDatabase } from '../../src/backup/pg-tools.js';
import { expectedMigrationHead, runMigrations } from '../../src/migrate.js';
import { createTenant } from '../../src/platform.js';
import { TEST_DATABASE_MIGRATOR_URL, TEST_DATABASE_URL } from './env.js';

/**
 * ADR-0016 slice 4: a backup is encrypted, describes exactly what it holds, restores into a scratch
 * database that verifies clean, and the verification catches a restore that differs (rows,
 * migrations, grants, RLS, policies, triggers), a changed file and the wrong key.
 *
 * The source is a database of its own (`onepos_drill_src_*`: set up like init/01-roles.sql, migrated,
 * a few businesses), not onepos_test, which grows with every run and would make this test slower
 * each time (it reached 564 MB and a 120 s restore).
 */
const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for the backup tests (see .env.example)`);
  return v;
};
const ADMIN_URL = need('DRILL_ADMIN_URL');
const tools = pgToolsFromEnv();
const run = Date.now().toString(36);
const source = `onepos_drill_src_${run}`;
const BACKUP_URL = withDatabase(need('TEST_BACKUP_DATABASE_URL'), source);

let dir = '';
let identity = '';
let backup: BackupResult;
const scratch = `onepos_drill_t${run}`;
const scratchUrl = withDatabase(ADMIN_URL, scratch);
const backupPool = new pg.Pool({ connectionString: BACKUP_URL, max: 1 });
const appPool = new pg.Pool({ connectionString: withDatabase(TEST_DATABASE_URL, source), max: 1 });
const testAdmin = new pg.Pool({ connectionString: withDatabase(ADMIN_URL, source), max: 1 });

/** A small, migrated database with a few businesses, set up the way init/01-roles.sql sets up onepos. */
async function createSource() {
  await sql(ADMIN_URL, `CREATE DATABASE ${source} OWNER onepos_migrator TEMPLATE template0 ENCODING 'UTF8'`);
  await sql(withDatabase(ADMIN_URL, source), `ALTER SCHEMA public OWNER TO onepos_migrator;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO onepos_app, onepos_worker, onepos_readonly;`);
  await runMigrations(withDatabase(TEST_DATABASE_MIGRATOR_URL, source));
  for (const name of ['Alpha Mart', 'Bravo Cafe', 'Carinderia ni Cora']) {
    await createTenant(appPool, { slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${run}`, name });
  }
}

async function sql<T extends pg.QueryResultRow>(url: string, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await createSource();
  dir = await mkdtemp(join(tmpdir(), 'onepos-backup-'));
  identity = await generateIdentity();
  backup = await createBackup({ url: BACKUP_URL, recipients: [await identityToRecipient(identity)], dir, tools });
}, 120_000);

afterAll(async () => {
  await Promise.all([backupPool.end(), appPool.end(), testAdmin.end()]);
  for (const db of [scratch, `${scratch}_c`, source]) await dropScratchDatabase(ADMIN_URL, db).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('backup', () => {
  it('writes an age-encrypted archive (no schema or data in clear) and its manifest, nothing else', async () => {
    const bytes = await readFile(backup.filePath);
    expect(bytes.subarray(0, 32).toString('latin1')).toMatch(/^age-encryption\.org\/v1\n-> X25519 /);
    // pg_dump's custom format carries table names and DDL in clear: none may survive encryption.
    for (const clear of ['PGDMP', 'CREATE TABLE', 'tenant_memberships', 'app_current_tenant_id']) {
      expect([clear, bytes.includes(Buffer.from(clear))]).toEqual([clear, false]);
    }
    expect((await readdir(dir)).sort()).toEqual([backup.manifest.file, backup.manifest.file.replace('.dump.age', '.manifest.json')]);
    expect(backup.manifest.dumpBytes).toBeGreaterThan(20_000);
  });

  it('describes the database at the dump snapshot: every table count, the migration head, the posture', async () => {
    const m = backup.manifest;
    expect(m.database).toBe(source);
    expect(m.migrations.count).toBe(expectedMigrationHead().count);
    // The run is recorded after the snapshot, so the live table holds one row more than the archive.
    const live = await tableRowCounts(backupPool);
    expect(m.rowCounts).toEqual({ ...live, 'public.backup_runs': live['public.backup_runs']! - 1 });
    expect(Object.keys(m.rowCounts)).toEqual(expect.arrayContaining(['public.sales', 'public.audit_logs', 'drizzle.__drizzle_migrations']));
    expect(m.rowCounts['public.tenants']).toBeGreaterThan(0);
    expect(m.posture.relations!.length).toBeGreaterThan(80);
    expect(m.postureSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is recorded for the backup-age gauge', async () => {
    const { rows: [row] } = await testAdmin.query('SELECT kind, sha256, size_bytes, migrations FROM backup_runs WHERE id = $1', [backup.recordId]);
    expect(row).toEqual({ kind: 'BACKUP', sha256: backup.manifest.sha256, size_bytes: String(backup.manifest.sizeBytes), migrations: backup.manifest.migrations.count });
    const { rows: [g] } = await appPool.query<{ value: number }>(
      `SELECT value FROM platform_metrics() WHERE metric = 'backup_last_success_timestamp_seconds'`,
    );
    expect(Math.abs(g!.value - Date.parse(backup.manifest.finishedAt) / 1000)).toBeLessThan(5);
  });

  it('refuses a login that RLS applies to (it would back up no tenant rows)', async () => {
    await expect(createBackup({ url: TEST_DATABASE_URL, recipients: ['age1zzzz'], dir, tools })).rejects.toThrow(/subject to RLS/);
    await expect(createBackup({ url: BACKUP_URL, recipients: ['not-a-key'], dir, tools })).rejects.toThrow(/age public keys/);
    expect((await readdir(dir)).length).toBe(2);
  });

  it('the backup login reads but writes nothing, and its records cannot be changed', async () => {
    await expect(backupPool.query(`INSERT INTO plans DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
    await expect(backupPool.query(`UPDATE backup_runs SET size_bytes = 0`)).rejects.toMatchObject({ code: '42501' });
    await expect(backupPool.query(`DELETE FROM tenants`)).rejects.toMatchObject({ code: '42501' });
    await expect(testAdmin.query(`UPDATE backup_runs SET size_bytes = 0 WHERE id = $1`, [backup.recordId])).rejects.toThrow(/append-only/);
    await expect(appPool.query(`SELECT platform_record_backup('BACKUP', now(), 'x', 1, repeat('a', 64), 1, '{}')`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('restore', () => {
  it('a changed file or the wrong key is refused before anything is restored', async () => {
    const mPath = backup.manifestPath;
    const copyDir = await mkdtemp(join(tmpdir(), 'onepos-tamper-'));
    try {
      const copy = join(copyDir, backup.manifest.file);
      await writeFile(join(copyDir, 'm.manifest.json'), '{}');
      await copyFile(backup.filePath, copy);
      const bytes = await readFile(copy);
      bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
      await writeFile(copy, bytes);
      await expect(verifyBackupFile(join(copyDir, 'm.manifest.json'), backup.manifest)).rejects.toThrow(/SHA-256/);
      await writeFile(copy, bytes.subarray(0, bytes.length - 10));
      await expect(verifyBackupFile(join(copyDir, 'm.manifest.json'), backup.manifest)).rejects.toThrow(/bytes, the manifest says/);
      await expect(verifyBackupFile(mPath, backup.manifest)).resolves.toBe(backup.filePath);

      const other = await generateIdentity();
      await expect(restoreBackup({ filePath: backup.filePath, manifest: backup.manifest, identity: other, adminUrl: ADMIN_URL, database: scratch, tools })).rejects.toThrow();
      expect(await sql(ADMIN_URL, 'SELECT 1 FROM pg_database WHERE datname = $1', [scratch])).toEqual([]);
      await expect(restoreBackup({ filePath: backup.filePath, manifest: backup.manifest, identity, adminUrl: ADMIN_URL, database: 'onepos_test', tools })).rejects.toThrow(/refusing/);

      // A flipped bit inside the encrypted payload: age's authentication stops the stream, so
      // pg_restore never commits a silently corrupted database.
      const flipped = await readFile(backup.filePath);
      flipped[flipped.length - 100]! ^= 0x01;
      await writeFile(copy, flipped);
      const corrupt = `${scratch}_c`;
      try {
        await expect(restoreBackup({ filePath: copy, manifest: backup.manifest, identity, adminUrl: ADMIN_URL, database: corrupt, tools })).rejects.toThrow();
        const left = await sql(withDatabase(ADMIN_URL, corrupt), `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace`).catch(() => [{ n: 0 }]);
        expect(left).toEqual([{ n: 0 }]);
      } finally {
        await dropScratchDatabase(ADMIN_URL, corrupt);
      }
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('restores into a new database that equals the backup', async () => {
    await restoreBackup({ filePath: backup.filePath, manifest: backup.manifest, identity, adminUrl: ADMIN_URL, database: scratch, tools });
    const v = await verifyRestored(scratchUrl, backup.manifest);
    expect(v.problems).toEqual([]);
    expect(v.rows).toBe(backup.manifest.totalRows);
    expect(v.postureSha256).toBe(backup.manifest.postureSha256);
    // The runtime role works on it, under RLS: no tenant set → no tenant rows.
    const appUrl = withDatabase(TEST_DATABASE_URL, scratch);
    expect(await sql(appUrl, 'SELECT count(*)::int AS n FROM sales')).toEqual([{ n: 0 }]);
  }, 120_000);

  it('verification catches rows, migrations, grants, RLS, policies and triggers that differ', async () => {
    const [{ tgname }] = (await sql<{ tgname: string }>(
      scratchUrl,
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'sales'::regclass AND NOT tgisinternal ORDER BY 1 LIMIT 1`,
    )) as [{ tgname: string }];
    await sql(scratchUrl, `
      ALTER TABLE sales NO FORCE ROW LEVEL SECURITY;
      GRANT DELETE ON stock_movements TO onepos_app;
      CREATE POLICY wide ON products FOR SELECT USING (true);
      DROP TRIGGER ${pg.escapeIdentifier(tgname)} ON sales;
      DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);`);
    const { problems } = await verifyRestored(scratchUrl, backup.manifest);
    const expected = [
      /^migration head /,
      /^rows in drizzle\.__drizzle_migrations: \d+ restored, \d+ backed up$/,
      /^posture: relations public\.sales: differs/,
      /^posture: relations public\.stock_movements: differs .*onepos_app:DELETE/,
      /^posture: policies public\.products\.wide: not in the backup$/,
      new RegExp(`^posture: triggers public\\.sales\\.${tgname}: missing after restore$`),
      /^isolation: sales: RLS not enabled\+forced$/,
      /^isolation: products: non-canonical policy/,
    ];
    for (const re of expected) expect([re.source, problems.some((p) => re.test(p))]).toEqual([re.source, true]);
  });
});
