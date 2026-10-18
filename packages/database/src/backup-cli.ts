import { generateIdentity, identityToRecipient } from 'age-encryption';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBackup, latestManifest, pruneBackups, readManifest, verifyBackupFile } from './backup/backup.js';
import { pgToolsFromEnv } from './backup/pg-tools.js';

const USAGE = `Tilvara backups (ADR-0016 slice 4). Runbook: docs/operations/backup-restore.md

  backup keygen --out <file>      new age key pair: writes the SECRET key to <file> (keep it off the
                                  database and app hosts) and prints the public key for BACKUP_AGE_RECIPIENT
  backup run [--keep-days N]      encrypted pg_dump + manifest into BACKUP_DIR, recorded for the
                                  backup-age alert; then deletes backups older than N days (default
                                  BACKUP_KEEP_DAYS or 30; the newest 3 are always kept)
  backup verify [<manifest>]      checks a backup file against its manifest (size, SHA-256); default: the newest

Environment: BACKUP_DATABASE_URL (the onepos_backup login), BACKUP_AGE_RECIPIENT (age1…, comma-separated
for several), BACKUP_DIR, and PG_TOOLS_DOCKER=<container> to run pg_dump inside a container.
The restore drill is \`pnpm drill:restore\`.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'keep-days': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (command === 'keygen') {
    if (!values.out) {
      console.error('keygen needs --out <file> for the secret key');
      return 2;
    }
    const identity = await generateIdentity();
    // 'wx': never overwrite an existing key (that would orphan every backup made for it).
    await writeFile(values.out, `# Tilvara backup key, created ${new Date().toISOString()}\n${identity}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Secret key written to ${values.out}. Move it to the ops vault; the database host never needs it.`);
    console.log(`BACKUP_AGE_RECIPIENT=${await identityToRecipient(identity)}`);
    return 0;
  }
  if (!process.env.BACKUP_DIR) {
    console.error('BACKUP_DIR is not set');
    return 2;
  }
  // pnpm runs this from packages/database: a relative BACKUP_DIR means the repository root.
  const dir = resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.BACKUP_DIR);
  if (command === 'run') {
    const url = process.env.BACKUP_DATABASE_URL;
    const recipients = (process.env.BACKUP_AGE_RECIPIENT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!url) {
      console.error('BACKUP_DATABASE_URL is not set');
      return 2;
    }
    const keepDays = Number(values['keep-days'] ?? process.env.BACKUP_KEEP_DAYS ?? 30);
    if (!Number.isInteger(keepDays) || keepDays < 1) {
      console.error('--keep-days must be a whole number of days, at least 1');
      return 2;
    }
    const r = await createBackup({ url, recipients, dir, tools: pgToolsFromEnv() });
    const removed = await pruneBackups(dir, keepDays);
    const m = r.manifest;
    console.log(JSON.stringify({
      file: r.filePath,
      manifest: r.manifestPath,
      sizeBytes: m.sizeBytes,
      sha256: m.sha256,
      migrations: m.migrations.count,
      tables: Object.keys(m.rowCounts).length,
      rows: m.totalRows,
      durationMs: m.durationMs,
      removed,
    }, null, 2));
    return 0;
  }
  if (command === 'verify') {
    const path = arg ?? (await latestManifest(dir));
    if (!path) {
      console.error(`No backup manifest in ${dir}`);
      return 1;
    }
    const m = await readManifest(path);
    const file = await verifyBackupFile(path, m);
    console.log(`${file}: ${m.sizeBytes} bytes, SHA-256 matches the manifest (${m.finishedAt}, ${m.migrations.count} migrations, ${m.totalRows} rows)`);
    return 0;
  }
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
