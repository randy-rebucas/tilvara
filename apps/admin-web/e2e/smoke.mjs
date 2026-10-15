// End-to-end smoke test for the admin web, driven over the Chrome DevTools Protocol with a
// locally installed Edge/Chrome (no Playwright download needed on this machine).
// Usage: node e2e/smoke.mjs [baseUrl] [screenshotDir]
// Requires the API (4320) and admin web (3320) to be running.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const PORT = 9333;
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = BROWSERS.find((b) => existsSync(b));
if (!exe) throw new Error('No Edge/Chrome found');
mkdirSync(OUT, { recursive: true });

const browser = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), '1pos-e2e-'))}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { await sleep(200); }
}
if (!target) throw new Error('browser did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else listeners.forEach((l) => l(msg));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
};
const viewport = (width, height, mobile = false) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
async function go(path) {
  await send('Page.navigate', { url: BASE + path });
  await waitFor(`document.readyState === 'complete'`);
  await sleep(400);
}
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(`Boolean(${expr})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${expr}`);
}
/** Fill a React-controlled input by name. */
const fill = (name, value) => evaluate(`(() => {
  const el = document.querySelector('[name="${name}"]');
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const clickText = (text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim().includes(${JSON.stringify(text)}));
  if (!b) throw new Error('no button: ${text}');
  b.click();
})()`);
const shot = async (file, full = true) => {
  const metrics = await send('Page.getLayoutMetrics');
  const height = full ? Math.ceil(metrics.cssContentSize.height) : undefined;
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
    ...(full ? { clip: { x: 0, y: 0, width: metrics.cssLayoutViewport.clientWidth, height, scale: 1 } } : {}),
  });
  writeFileSync(join(OUT, file), Buffer.from(r.data, 'base64'));
};
/** Call the BFF from the page (same origin, CSRF header) — exercises the real proxy. */
const bff = (method, path, body, idem = false) => evaluate(`fetch(${JSON.stringify(path)}, {
  method: ${JSON.stringify(method)},
  headers: { 'content-type': 'application/json', 'x-onepos-request': '1' ${idem ? ", 'idempotency-key': crypto.randomUUID()" : ''} },
  body: ${JSON.stringify(JSON.stringify(body))},
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

const checks = [];
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await viewport(1440, 900);

  // 1. Unauthenticated visit redirects to sign-in
  await go('/products');
  check('signed-out visitor is sent to sign-in', (await evaluate('location.pathname')) === '/sign-in');
  await shot('sign-in.png', false);

  // 2. Sign up through the real form
  const slug = `smoke-${Date.now().toString(36)}`;
  await go('/sign-up');
  await fill('businessName', 'Sari-Sari Smoke Test');
  await fill('tenantSlug', slug);
  await fill('displayName', 'Maria Santos');
  await fill('email', `${slug}@example.ph`);
  await fill('password', 'correct horse battery staple');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`location.pathname === '/' || document.querySelector('[role=alert]')`);
  const signupError = await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`);
  if (signupError) throw new Error(`sign-up failed: ${signupError}`);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('sign-up lands on overview', true);
  check('tokens are not readable by page JS', !(await evaluate(`document.cookie.includes('onepos_at') || document.cookie.includes('onepos_rt')`)));
  await shot('overview-empty.png');

  // 3. CSRF: a mutation without the custom header is refused by the BFF
  const csrf = await evaluate(`fetch('/api/v1/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' }).then((r) => r.status)`);
  check('BFF refuses mutation without CSRF header (403)', csrf === 403);

  // 4. Add a legal entity through the UI form
  await go('/locations');
  await clickText('Add legal entity');
  await waitFor(`document.querySelector('[name="registeredName"]')`);
  await fill('registeredName', 'Sari-Sari Smoke Trading Corp');
  await fill('tin', '123-456-789');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('123-456-789')`);
  check('legal entity created via UI with formatted TIN', true);

  // 5. Rest of the setup through the BFF proxy
  const entities = await bff('GET', '/api/v1/legal-entities');
  const entityId = (await evaluate(`fetch('/api/v1/legal-entities').then((r) => r.json())`)).data[0].id;
  void entities;
  const br = await bff('POST', '/api/v1/branches', { legalEntityId: entityId, code: 'MKT-01', name: 'Makati Main' }, true);
  if (br.status !== 201) console.log('branch response:', JSON.stringify(br));
  check('branch created through BFF (201)', br.status === 201);
  const reg = await bff('POST', '/api/v1/registers', { branchId: br.body.id, code: 'R1', name: 'Counter 1' }, true);
  check('register created (201)', reg.status === 201);
  const term = await bff('POST', '/api/v1/terminals', { registerId: reg.body.id, name: 'iPad Counter 1' });
  check('terminal paired, one-time credential returned', term.status === 201 && term.body.credential.startsWith('tpk_'));
  const uoms = await evaluate(`fetch('/api/v1/uoms').then((r) => r.json())`);
  const taxes = await evaluate(`fetch('/api/v1/tax-categories').then((r) => r.json())`);
  const pc = uoms.data.find((u) => u.code === 'PC').id;
  const vat = taxes.data.find((x) => x.code === 'VAT').id;
  const items = [
    ['Lucky Me Pancit Canton Chilimansi', 'LM-PC-CHILI', '4807770270017', '16.50'],
    ['Coke Mismo 290ml', 'CK-290', '4801981116072', '22.00'],
    ['Bear Brand Powdered Milk 33g', 'BB-33', '4800361001234', '12.75'],
    ['Gift wrap', 'SV-WRAP', null, null],
  ];
  for (const [name, sku, code, price] of items) {
    const r = await bff('POST', '/api/v1/products', {
      name, taxCategoryId: vat, uomId: pc,
      variants: [{ sku, barcodes: code ? [code] : [], ...(price ? { price } : {}) }],
    }, true);
    check(`product ${sku} created`, r.status === 201);
  }

  // 6. Pages render with data
  await go('/');
  check('overview shows priced product in ₱', await evaluate(`document.body.innerText.includes('₱16.50')`));
  check('overview flags the unpriced item', await evaluate(`document.body.innerText.toLowerCase().includes('without a price: 1')`));
  await shot('desktop.png');
  await go('/locations'); await shot('locations.png');
  await go('/products?q=coke');
  check('product search finds Coke', await evaluate(`document.body.innerText.includes('Coke Mismo')`) && !(await evaluate(`document.body.innerText.includes('Lucky Me')`)));
  await go('/products'); await shot('products.png');
  await go('/prices'); await shot('prices.png');
  await go('/team'); await shot('team.png');
  await go('/subscription');
  check('subscription shows trial and limits', await evaluate(`document.body.innerText.includes('Growth trial') && document.body.innerText.includes('1 / 30')`));
  await shot('subscription.png');

  // 7. Filipino
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await go('/');
  check('Filipino UI renders', await evaluate(`document.body.innerText.includes('Buod') && document.documentElement.lang === 'fil'`));
  await shot('overview-fil.png', false);
  await bff('POST', '/api/auth/lang', { lang: 'en' });

  // 8. Mobile
  await viewport(390, 844, true);
  await go('/');
  check('no horizontal page scroll at 390px', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await shot('mobile.png');
  await viewport(1440, 900);

  // 9. Sign out revokes the session
  await bff('POST', '/api/auth/logout', {});
  await go('/');
  check('after sign-out, app redirects to sign-in', (await evaluate('location.pathname')) === '/sign-in');
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  ws.close();
  browser.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
