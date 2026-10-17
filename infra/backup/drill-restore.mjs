// Restore drill (ADR-0016 slice 4). Proves a backup can be brought back, and measures how long it takes.
//
//   pnpm build && pnpm drill:restore [<manifest>] [--keep] [--no-record]
//
// 1. checks the encrypted file against its manifest (size, SHA-256);
// 2. decrypts it (age secret key from BACKUP_AGE_IDENTITY_FILE) straight into pg_restore, into a new
//    scratch database onepos_drill_<time> on the DRILL_ADMIN_URL cluster;
// 3. verifies the restore: migration head, row counts of every table equal to the manifest, the same
//    catalog posture (owners, grants, RLS, policies, SECURITY DEFINER functions, triggers) and the
//    tenant-isolation rules;
// 4. boots the built API on it as the runtime role (RLS on) and waits for /v1/health/ready: the
//    restore time objective (RTO) is measured from the start to this point;
// 5. smoke: a new business rings up a cash sale through the API (sign-up, branch, register, item, stock,
//    shift, checkout, reading it back);
// 6. runs the traceability audit (apps/api/test/dev-audit.ts) over the restored data and the smoke sale;
// 7. records the passed drill in the SOURCE database (platform_record_backup, feeds the drill-age gauge)
//    and writes a report next to the backup; drops the scratch database unless --keep.
// Exit code 0 only when every step passed. Runbook: docs/operations/backup-restore.md.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dropScratchDatabase,
  latestManifest,
  pgToolsFromEnv,
  readManifest,
  recordRestoreDrill,
  restoreBackup,
  verifyBackupFile,
  verifyRestored,
  withDatabase,
} from '../../packages/database/dist/backup/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
// A real restore (docs/operations/backup-restore.md): the source database may be gone.
const record = !args.includes('--no-record');
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example, "Backups and the restore drill")`);
  return v;
};

const t0 = performance.now();
const phases = {};
const timed = async (name, fn) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    phases[name] = Math.round(performance.now() - start);
  }
};
const log = (msg) => console.log(`[drill ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${msg}`);

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function startApi(databaseUrl) {
  const port = await freePort();
  const env = { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(port), API_HOST: '127.0.0.1', API_METRICS_PORT: '0', LOG_LEVEL: 'warn', NODE_ENV: 'development' };
  delete env.REDIS_URL; // the drill's API must not share rate-limit counters with the live one
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: join(ROOT, 'apps/api'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (output = (output + d).slice(-4000)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the API exited (${child.exitCode}) before it was ready:\n${output}`);
    const ready = await fetch(`${base}/v1/health/ready`).then((r) => (r.ok ? r.json() : null), () => null);
    if (ready?.status === 'ok') return { base, child, ready };
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the API was not ready within 60 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function smoke(base) {
  const call = async (method, path, token, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`smoke: ${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const key = () => ({ 'idempotency-key': randomUUID() });
  const slug = `drill-${Date.now().toString(36)}`;
  const owner = await call('POST', '/v1/auth/signup', null, { email: `${slug}@example.ph`, password: 'correct horse battery staple', displayName: 'Drill Owner', businessName: 'Restore Drill Store', tenantSlug: slug });
  const tk = owner.tokens.accessToken;
  const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Restore Drill Trading', vatStatus: 'VAT' });
  const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'DR-01', name: 'Drill' });
  const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
  const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
  const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
  const product = await call('POST', '/v1/products', tk, { name: 'Drill Cola 290ml', taxCategoryId: taxes.VAT, uomId: pc, variants: [{ sku: 'DR-COLA', barcodes: [], price: '22.40' }] }, key());
  const variantId = product.variants[0].id;
  await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId, quantity: '10' }] }, key());
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' }, key());
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '50.00' }] }, key());
  const back = await call('GET', `/v1/sales/${sale.id}`, tk);
  if (back.id !== sale.id || back.amountDue !== '44.80') throw new Error(`smoke: the sale reads back wrong: ${JSON.stringify({ id: back.id, amountDue: back.amountDue })}`);
  return { tenantSlug: slug, saleNumber: back.saleNumber, amountDue: back.amountDue };
}

function runAudit(url) {
  return new Promise((ok, fail) => {
    // Under `pnpm drill:restore`, npm_execpath is pnpm's own script: run it with this node, no shell.
    const argv = ['--filter', '@1pos/api', 'exec', 'tsx', 'test/dev-audit.ts'];
    const viaPnpm = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath);
    const [cmd, cmdArgs, shell] = viaPnpm ? [process.execPath, [process.env.npm_execpath, ...argv], false] : ['pnpm', argv, process.platform === 'win32'];
    const child = spawn(cmd, cmdArgs, {
      cwd: ROOT,
      env: { ...process.env, AUDIT_DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', fail);
    child.on('close', (code) => {
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      let result = null;
      try {
        result = JSON.parse(json);
      } catch {
        /* reported below */
      }
      if (code === 0 && result) ok(result);
      else fail(new Error(`traceability audit failed (exit ${code}):\n${out.slice(-3000)}`));
    });
  });
}

const report = { ok: false, startedAt: new Date().toISOString(), phasesMs: phases };
let scratch = null;
let api = null;
let exitCode = 1;
let adminUrl = null;
let manifestPath = null;
try {
  const backupDir = resolve(ROOT, need('BACKUP_DIR'));
  manifestPath = args.find((a) => !a.startsWith('--')) ?? (await latestManifest(backupDir));
  if (!manifestPath) throw new Error(`no backup manifest in ${backupDir}; run \`pnpm --filter @1pos/database backup run\` first`);
  manifestPath = resolve(manifestPath);
  const identityText = await readFile(resolve(ROOT, need('BACKUP_AGE_IDENTITY_FILE')), 'utf8');
  const identity = identityText.split(/\r?\n/).find((l) => l.startsWith('AGE-SECRET-KEY-'));
  if (!identity) throw new Error('BACKUP_AGE_IDENTITY_FILE holds no AGE-SECRET-KEY- line');
  adminUrl = need('DRILL_ADMIN_URL');
  const appUrl = need('DATABASE_URL');
  const tools = pgToolsFromEnv();

  const manifest = await readManifest(manifestPath);
  report.backup = { file: manifest.file, finishedAt: manifest.finishedAt, sizeBytes: manifest.sizeBytes, sha256: manifest.sha256, migrations: manifest.migrations.count, rows: manifest.totalRows };
  log(`backup ${manifest.file} (${(manifest.sizeBytes / 1e6).toFixed(1)} MB, ${manifest.totalRows} rows, taken ${manifest.finishedAt})`);

  const filePath = await timed('verifyFile', () => verifyBackupFile(manifestPath, manifest));
  log('file matches its manifest (size, SHA-256)');

  scratch = `onepos_drill_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  report.database = scratch;
  await timed('restore', () => restoreBackup({ filePath, manifest, identity, adminUrl, database: scratch, tools }));
  log(`decrypted and restored into ${scratch}`);

  const verification = await timed('verify', () => verifyRestored(withDatabase(adminUrl, scratch), manifest));
  report.verification = verification;
  if (verification.problems.length) throw new Error(`the restored database differs from the backup:\n- ${verification.problems.join('\n- ')}`);
  log(`verified: ${verification.migrations.count} migrations, ${verification.tables} tables, ${verification.rows} rows equal to the manifest; posture and isolation rules hold`);

  api = await timed('apiReady', () => startApi(withDatabase(appUrl, scratch)));
  report.rtoSeconds = Math.round(performance.now() - t0) / 1000;
  log(`API ready on the restored database (${JSON.stringify(api.ready.checks)}): RTO ${report.rtoSeconds} s`);

  report.smoke = await timed('smoke', () => smoke(api.base));
  log(`smoke sale recorded and read back (₱${report.smoke.amountDue})`);
  api.child.kill();
  api = null;

  const audit = await timed('audit', () => runAudit(withDatabase(adminUrl, scratch)));
  report.audit = { tenants: audit.tenants, sales: audit.sales, entries: audit.entries, beforeLedger: audit.beforeLedger, violations: Object.keys(audit.violations).length };
  log(`traceability audit clean: ${audit.tenants} businesses, ${audit.sales} sales, ${audit.entries} journal entries`);

  report.totalSeconds = Math.round(performance.now() - t0) / 1000;
  report.ok = true;
  if (record) {
    report.recordId = await recordRestoreDrill(need('BACKUP_DATABASE_URL'), manifest, new Date(report.startedAt), {
      rtoSeconds: report.rtoSeconds,
      totalSeconds: report.totalSeconds,
      phasesMs: phases,
      tables: verification.tables,
      rows: verification.rows,
    });
    log('drill recorded in the source database');
  } else log('not recorded (--no-record)');
  exitCode = 0;
} catch (e) {
  report.error = e.message;
  console.error(`[drill] FAILED: ${e.message}`);
} finally {
  if (api) api.child.kill();
  if (scratch && adminUrl && !keep) await dropScratchDatabase(adminUrl, scratch).catch((e) => console.error(`[drill] could not drop ${scratch}: ${e.message}`));
  else if (scratch && keep) log(`kept ${scratch} (--keep): drop it with DROP DATABASE ${scratch} WITH (FORCE)`);
  report.finishedAt = new Date().toISOString();
  if (manifestPath) {
    const out = join(dirname(manifestPath), `${basename(manifestPath, '.manifest.json')}.drill-${report.finishedAt.replace(/\D/g, '').slice(0, 14)}.json`);
    await writeFile(out, JSON.stringify(report, null, 2)).then(() => log(`report: ${out}`), () => undefined);
  }
  console.log(JSON.stringify({ ok: report.ok, rtoSeconds: report.rtoSeconds, totalSeconds: report.totalSeconds, phasesMs: phases, error: report.error }, null, 2));
}
process.exit(exitCode);
