// Client bundle secret scan (THREAT_MODEL T11, ADR-0016 slice 2). Fails when a built bundle that
// ships to browsers or tills contains a server secret, a private connection string, or the name
// of a server-only setting (which would mean server code was bundled for the client).
//
// Usage (after `pnpm build` and the app builds):
//   node scripts/security/scan-bundles.mjs            scan the admin, POS and desktop bundles
//   node scripts/security/scan-bundles.mjs --self-test plant secrets in a temp bundle and expect failure
//   node scripts/security/scan-bundles.mjs --live [adminUrl] [apiUrl]
//       The admin's pages are server-rendered per request (cookies), so the build holds no HTML to
//       scan: sign up a throwaway owner, sign in through the BFF and scan what each page sends to the
//       browser (HTML with its embedded RSC payload). Needs the API and `next start` running.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** What browsers and tills download. Server output (.next/server, API dist) is not in scope. */
const BUNDLES = [
  { name: 'admin-web (browser)', dir: 'apps/admin-web/.next/static' },
  { name: 'pos (browser + desktop webview)', dir: 'apps/pos-desktop/dist' },
];

/** Server-only settings: their names must never appear in client code, nor their values. */
const SERVER_ONLY = [
  'DATABASE_URL', 'TEST_DATABASE_URL', 'WORKER_DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'REDIS_URL',
  'JWT_ACCESS_SECRET', 'MFA_ENCRYPTION_KEY', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET',
  'ONEPOS_API_URL', 'POSTGRES_OWNER_PASSWORD',
];

/** Shapes of secrets regardless of where they came from. */
const PATTERNS = [
  { what: 'PayMongo secret key', re: /\bsk_(?:test|live)_[A-Za-z0-9]{8,}/ },
  { what: 'PayMongo webhook secret', re: /\bwhsk_[A-Za-z0-9]{8,}/ },
  { what: 'database connection string', re: /\bpostgres(?:ql)?:\/\/[^\s"'`]+@/ },
  { what: 'Redis connection string', re: /\brediss?:\/\/[^\s"'`]*@?[\w.-]+:\d+/ },
  { what: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { what: 'dev database password', re: /onepos_(?:app|migrator|worker|readonly|owner)_dev/ },
];

const TEXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.txt', '.svg']);

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.has(extname(p))) yield p;
  }
}

/** Secret values from the environment worth searching for (long enough to be meaningful). */
function secretValues(env) {
  const values = [];
  for (const name of SERVER_ONLY) {
    const v = env[name];
    if (!v || v.length < 12) continue;
    values.push({ name, value: v });
    const password = /:\/\/[^:/]+:([^@]+)@/.exec(v)?.[1];
    if (password && password.length >= 8) values.push({ name: `${name} password`, value: password });
  }
  return values;
}

/** Every check on one text that reaches a browser. */
function checkText(bundle, file, text, values, findings) {
  for (const n of SERVER_ONLY) if (new RegExp(`\\b${n}\\b`).test(text)) findings.push({ bundle, file, what: `server-only setting name ${n}` });
  for (const p of PATTERNS) if (p.re.test(text)) findings.push({ bundle, file, what: p.what });
  for (const v of values) if (text.includes(v.value)) findings.push({ bundle, file, what: `value of ${v.name}` });
}

export function scan(dirs, env) {
  const values = secretValues(env);
  const findings = [];
  let scanned = 0;
  for (const { name, dir } of dirs) {
    if (!existsSync(dir)) {
      findings.push({ bundle: name, file: dir, what: 'bundle not built (run the app build first)' });
      continue;
    }
    for (const file of files(dir)) {
      scanned++;
      checkText(name, relative(ROOT, file), readFileSync(file, 'utf8'), values, findings);
    }
  }
  return { scanned, findings };
}

function report({ scanned, findings }) {
  for (const f of findings) console.log(`FAIL  ${f.bundle}: ${f.file} — ${f.what}`);
  console.log(`${scanned} files scanned, ${findings.length} finding(s)`);
  return findings.length === 0;
}

const env = { ...process.env };
try {
  loadEnvFile(join(ROOT, '.env'));
  Object.assign(env, process.env);
} catch {
  // No .env (CI): scan with the process environment only.
}

if (process.argv.includes('--self-test')) {
  // A bundle with planted leaks must fail on each kind; a clean one must pass.
  const dir = mkdtempSync(join(tmpdir(), 'bundle-scan-'));
  try {
    writeFileSync(join(dir, 'clean.js'), 'export const api = "/v1"; const x = "sk_" + "test";');
    const clean = scan([{ name: 'clean', dir }], { JWT_ACCESS_SECRET: 'a-very-long-planted-secret-value-123' });
    writeFileSync(join(dir, 'leak.js'), [
      'const a = process.env.DATABASE_URL;',
      'const b = "sk_test_abcdefgh1234";',
      'const c = "postgres://onepos_app:onepos_app_dev@db:5432/onepos";',
      'const d = "a-very-long-planted-secret-value-123";',
    ].join('\n'));
    const leaky = scan([{ name: 'leaky', dir }], { JWT_ACCESS_SECRET: 'a-very-long-planted-secret-value-123' });
    const kinds = new Set(leaky.findings.map((f) => f.what));
    const expected = ['server-only setting name DATABASE_URL', 'PayMongo secret key', 'database connection string', 'dev database password', 'value of JWT_ACCESS_SECRET'];
    const missing = expected.filter((k) => !kinds.has(k));
    const ok = clean.findings.length === 0 && missing.length === 0;
    console.log(ok ? 'PASS  self-test: clean bundle passes, every planted leak is found' : `FAIL  self-test: clean=${clean.findings.length} missing=${missing.join(', ')}`);
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pages an owner sees, server-rendered with a real session. */
const LIVE_PAGES = ['/', '/products', '/prices', '/inventory', '/purchasing', '/books', '/restaurant', '/reports/sales', '/offline-sales',
  '/locations', '/team', '/subscription', '/audit', '/account', '/security'];

async function scanLive(adminUrl, apiUrl, env) {
  const values = secretValues(env);
  const findings = [];
  const stamp = Date.now().toString(36);
  const email = `bundle-scan-${stamp}@example.ph`;
  const password = 'bundle scan password long enough';
  const signup = await fetch(`${apiUrl}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'Bundle Scan', businessName: `Bundle scan ${stamp}`, tenantSlug: `bundle-scan-${stamp}` }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status}`);
  const login = await fetch(`${adminUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: adminUrl, 'x-onepos-request': '1' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`sign-in through the admin failed: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  let scanned = 0;
  for (const page of LIVE_PAGES) {
    const res = await fetch(adminUrl + page, { headers: { cookie }, redirect: 'manual' });
    scanned++;
    // A redirect (e.g. to sign-in) would scan the wrong page: count it as a finding, not a pass.
    if (res.status !== 200) {
      findings.push({ bundle: 'admin-web (server-rendered)', file: page, what: `page answered ${res.status}, not scanned` });
      continue;
    }
    checkText('admin-web (server-rendered)', page, await res.text(), values, findings);
  }
  return { scanned, findings };
}

if (process.argv.includes('--live')) {
  const args = process.argv.slice(process.argv.indexOf('--live') + 1);
  process.exit(report(await scanLive(args[0] ?? 'http://127.0.0.1:3320', args[1] ?? 'http://127.0.0.1:4320', env)) ? 0 : 1);
}

process.exit(report(scan(BUNDLES.map((b) => ({ ...b, dir: join(ROOT, b.dir) })), env)) ? 0 : 1);
