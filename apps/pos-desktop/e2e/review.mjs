// Design-review capture pass for the POS counter: every screen and state not covered by
// smoke.mjs — sign-in error, business picker, a register in use, float validation, empty cart,
// name search, not found, unpriced item, SC/PWD form, card payment with no answer / declined,
// shift history with the void form, close with a variance, Filipino — each at 1440px and 390px
// (state kept: the counter is a single page with tokens in memory, so no reloads).
// Usage: node e2e/review.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false, PAYMENT_TIMEOUT_MS=2000 keeps the lost-answer
// case short), the POS (vite preview, port 3330) and .env at the repo root (memberships are
// arranged with the migrator role, as in the admin review).
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos/screens';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg');
const PASSWORD = 'correct horse battery staple';

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Give an existing user a system role in a tenant (the invitation flow needs email). */
async function member(tenantId, roleKey, userId) {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const m = await c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [tenantId, userId]);
    await c.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'TENANT', NULL FROM roles WHERE tenant_id = $1 AND key = $3`,
      [tenantId, m.rows[0].id, roleKey],
    );
    await c.query('COMMIT');
    return userId;
  } finally {
    c.release();
    await owner.end();
  }
}

// ---- arrange
const slug = `posrev-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Aling Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Aling Nena', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
const r2 = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R2', name: 'Counter 2' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = (name, sku, price, tax = 'VAT') =>
  call('POST', '/v1/products', tk, { name, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku, ...(price ? { price } : {}) }] }, { 'idempotency-key': randomUUID() });
await product('Coke Mismo 290ml', 'CK-290', '22.40');
await product('Pancit Canton Chilimansi', 'PC-CHILI', '16.50');
await product('Pancit Canton Kalamansi', 'PC-KAL', '16.50');
await product('Dinorado Rice 1kg', 'RICE-1', '56.00', 'VAT_EXEMPT');
await product('Itlog (tray)', 'EGG-30', null);
// Dev payment simulator amounts: .52 = provider charged but the answer was lost, .51 = declined.
await product('Load ₱22.52 (test)', 'T-LOST', '22.52');
await product('Load ₱22.51 (test)', 'T-DECL', '22.51');
// Another cashier is on Counter 2; the owner also belongs to a second business (picker).
const benEmail = `ben-${slug}@example.ph`;
const benSignup = await call('POST', '/v1/auth/signup', null, { email: benEmail, password: PASSWORD, displayName: 'Ben Santos', businessName: 'Ben Sari-sari', tenantSlug: `${slug}-ben` });
await member(owner.activeTenantId, 'cashier', benSignup.user.id);
const ben = (await call('POST', '/v1/auth/login', null, { email: benEmail, password: PASSWORD, tenantId: owner.activeTenantId })).tokens.accessToken;
await call('POST', '/v1/cashier-sessions', ben, { registerId: r2.id, openingFloat: '500.00' }, { 'idempotency-key': randomUUID() });
const other = await call('POST', '/v1/auth/signup', null, { email: `owner2-${slug}@example.ph`, password: PASSWORD, displayName: 'Ramon Cruz', businessName: 'Cruz Hardware & Trading', tenantSlug: `${slug}-b` });
await member(other.activeTenantId, 'cashier', owner.user.id);

// ---- capture
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9337 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const submitVisible = () => evaluate(`[...document.querySelectorAll('form .btn-primary')].find((e) => e.getClientRects().length).click()`);
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(600);
};
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);

/** Capture the current state at 1440 and 390 (no reload), checking sideways scroll at 390. */
async function both(name) {
  await viewport(1440, 900);
  await sleep(250);
  await shot(`${name}-1440.png`);
  await viewport(390, 844, true);
  await sleep(300);
  check(`${name}: no horizontal scroll at 390px`, await noHorizontalScroll());
  await shot(`${name}-390.png`);
  await viewport(1440, 900);
  await sleep(150);
}

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', 'wrong password here');
  await submitVisible();
  check('sign-in error shown', await waitFor(`document.querySelector('[role=alert]')`).then(() => true, () => false));
  await both('signin-error');

  await fill('password', PASSWORD);
  await submitVisible();
  check('two businesses → picker', await shown('Choose a business'));
  await both('business-picker');
  await clickText('Tindahan ni Aling Nena');
  check('register list: Counter 2 in use by another cashier', await shown('In use by another cashier'));
  await both('registers');

  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', 'isang libo');
  await submitVisible();
  check('float validation message', await shown('Enter an amount'));
  await both('open-shift-invalid');
  await fill('float', '1000');
  await submitVisible();
  await waitFor(`document.getElementById('scan')`);
  await both('sell-empty');

  await scan('Pancit');
  check('name search lists matches', await shown('PC-KAL'));
  await both('sell-search');
  await clickText('PC-CHILI');
  await sleep(600);
  await scan('walang-ganito');
  check('not-found notice', await shown('No item matches'));
  await both('sell-not-found');
  await scan('EGG-30');
  check('unpriced item refused with a reason', await shown('has no price'));
  await both('sell-unpriced');

  await scan('CK-290');
  await scan('RICE-1');
  await clickText('SC/PWD');
  await waitFor(`document.querySelector('input[name="name"]')`);
  await both('sell-sc-form');
  await fill('name', 'Corazon Dela Cruz');
  await fill('idNumber', 'OSCA-0001');
  await clickText('Apply');
  await sleep(800);
  await evaluate(`document.getElementById('cash').focus()`);
  await clickText('₱100.00');
  await sleep(200);
  await both('sell-sc-cash');
  await clickText('Complete sale');
  check('receipt', await shown('NOT AN OFFICIAL INVOICE'));
  await both('receipt-sc');
  await clickText('New sale');

  await scan('T-LOST');
  await clickText('Card');
  check('lost provider answer → UNKNOWN with "Check payment"', await shown('Check payment', 20000));
  await both('sell-card-unknown');
  await clickText('Check payment');
  check('reconciled → Approved', await shown('Approved'));
  await both('sell-card-reconciled');
  await clickText('Complete sale');
  await shown('NOT AN OFFICIAL INVOICE');
  await clickText('New sale');

  await scan('T-DECL');
  await clickText('Card');
  check('declined card', await shown('Declined'));
  await both('sell-card-declined');
  await clickText('₱22.51');
  await clickText('Complete sale');
  await shown('NOT AN OFFICIAL INVOICE');
  await clickText('New sale');

  await clickText('This shift');
  await shown('#000001');
  await clickText('#000001');
  await shown('Void sale');
  await clickText('Void sale');
  await sleep(300);
  await both('history-void-form');

  await clickText('Sell');
  await scan('CK-290');
  const lang = (code) => evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim().toLowerCase() === '${code}').click()`);
  await lang('fil');
  await sleep(300);
  check('Filipino counter', await shown('Kabuuang babayaran'));
  await both('sell-fil');
  await lang('en');
  await sleep(300);

  await clickText('Close shift');
  await waitFor(`document.getElementById('counted')`);
  await fill('counted', '1000.00');
  await submitVisible();
  check('variance shown as Short with manager approval', (await shown('Short')) && (await shown('manager must approve')));
  await both('close-variance');
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
