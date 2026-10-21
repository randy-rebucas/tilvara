// End-to-end test of the counter controls (session 20) in a retail shop:
// - a cashier asks for another price; a branch manager approves it on the spot with their own
//   email and password (a wrong password is refused); the line and the server carry the approval;
// - a cart is held under a name, the next customer is served, the cart is resumed and paid;
//   Close shift mentions a held cart;
// - the manager finds a sale of another register (register picker), previews the refund of an
//   exchange, rings up the new item and completes the exchange; the receipt names the credit;
// - customers (ADR-0018): the manager puts a customer on a sale, refunds it as store credit, and the
//   customer spends the credit on the next sale;
// - a manager's line discount (10 %), priced by the server; Filipino; phone width.
// The cashier and the manager are arranged in the dev database as the migrator (DATABASE_MIGRATOR_URL
// from .env), as invitation links never leave the API process.
// Usage: node apps/pos-desktop/e2e/counter-controls.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `ctl-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const r1 = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const r2 = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R2', name: 'Side' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = async (name, sku, price, tax = 'VAT') => (await call('POST', '/v1/products', tk, { name, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku, price }] }, idem())).variants[0].id;
const cola = await product('Coke Mismo 290ml', `CK-${slug}`, '22.40');
const rice = await product('Dinorado Rice 1kg', `RICE-${slug}`, '56.00', 'VAT_EXEMPT');
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '24', unitCost: '12.00' }, { variantId: rice, quantity: '24', unitCost: '40.00' }] }, idem());
// Yesterday at the side register: two Cokes on sale #1 of R2, shift closed.
const earlier = await call('POST', '/v1/cashier-sessions', tk, { registerId: r2.id, openingFloat: '0.00' });
const oldSale = await call('POST', '/v1/sales', tk, { cashierSessionId: earlier.id, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '44.80' }] }, idem());
await call('POST', `/v1/cashier-sessions/${earlier.id}/close`, tk, { countedCash: '44.80' });

const member = async (who, name, roleKey) => {
  const { PasswordService } = await import('../../api/dist/auth/password.service.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [owner.activeTenantId]);
    const u = await db.query('SELECT auth_register_user($1, $2, $3) AS id', [who, name, await new PasswordService().hash(PASSWORD)]);
    const m = await db.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [owner.activeTenantId, u.rows[0].id]);
    await db.query(`INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'BRANCH', $3 FROM roles WHERE tenant_id = $1 AND key = $4`, [owner.activeTenantId, m.rows[0].id, br.id, roleKey]);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
};
const rosa = await call('POST', '/v1/customers', tk, { displayName: 'Rosa Lim', phone: '0917 555 0101' });
const cashierEmail = `${slug}-cash@example.ph`;
const managerEmail = `${slug}-mgr@example.ph`;
await member(cashierEmail, 'Ana Cruz', 'cashier');
await member(managerEmail, 'Jun Santos', 'branch_manager');

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9343 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const tab = (label) => evaluate(`void [...document.querySelectorAll('nav[aria-label=Counter] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(600);
};
const totalShows = (amount) => waitFor(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`, 8000).then(() => true, () => false);
/** Click the visible primary button of the form that holds this field. */
const submitFormOf = (name) => evaluate(`void [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length).form.querySelector('.btn-primary').click()`);
const signIn = async (who, register) => {
  await go('/');
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(register)})`);
  // The register's card on the picker: its name is the card's first line.
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === ${JSON.stringify(register)}).querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '500');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
};
const setById = (id, value) =>
  evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const pay = async (cash) => {
  await setById('cash', cash);
  await waitFor(`!document.getElementById('pay-submit').disabled`, 8000);
  await evaluate(`document.getElementById('pay-submit').click()`);
};

try {
  await viewport(1440, 900);

  // ---- the cashier: a price change approved by the manager ----
  await signIn(cashierEmail, 'Front');
  await scan(`CK-${slug}`);
  check('a cashier sees no discount button (no sales.discount)', await totalShows('₱22.40') && !(await evaluate(`[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Discount' && x.getClientRects().length)`)));
  await clickText('Change price');
  check('the price form asks for the manager to sign in', await shown('Manager email'));
  await fill('price', '20');
  await fill('priceReason', 'Dented can');
  await fill('approverEmail', managerEmail);
  await fill('approverPassword', 'not the password');
  await submitFormOf('approverEmail');
  check('a wrong manager password is refused, the cashier stays signed in', await shown('Email or password is incorrect', 10000) && (await evaluate(`document.getElementById('scan') !== null`)));
  await fill('approverPassword', PASSWORD);
  await submitFormOf('approverEmail');
  check('the approved price is on the line, with who approved it', await shown('approved by Jun Santos', 10000) && await totalShows('₱20.00'));
  await shot('price-override.png', false);
  await pay('20');
  check('the sale completes', await shown('New sale', 10000));
  const sales = (await call('GET', `/v1/sales?registerId=${r1.id}`, tk)).data;
  const sold = await call('GET', `/v1/sales/${sales[0].id}`, tk);
  check('the server recorded the approved price on the line', sold.lines[0].unitPrice === '20' && Boolean(sold.lines[0].priceOverrideId) && sold.amountDue === '20.00');
  await clickText('New sale');

  // ---- hold a cart, serve the next customer, resume ----
  await scan(`CK-${slug}`);
  await scan(`RICE-${slug}`);
  await totalShows('₱78.40');
  await clickText('Hold sale');
  await fill('holdLabel', 'Lady in blue');
  await submitFormOf('holdLabel');
  check('the cart is held and the counter is empty', await shown('Held “Lady in blue”', 10000) && await shown('Held carts (1)'));
  await tab('Close shift');
  check('Close shift mentions the held cart', await shown('1 held carts are still open at this register', 10000));
  await tab('Sell');
  await scan(`CK-${slug}`);
  await totalShows('₱22.40');
  await pay('22.40');
  await shown('New sale', 10000);
  await clickText('New sale');
  await clickText('Held carts (1)');
  check('the held cart lists its items', await shown('Lady in blue') && (await text()).includes('1 × Dinorado Rice 1kg'));
  await shot('held-carts.png', false);
  await clickText('Resume');
  check('resumed: both lines back and re-priced', await totalShows('₱78.40'));
  check('the server shows no cart held any more', (await call('GET', `/v1/held-carts?registerId=${r1.id}`, tk)).data.length === 0);
  await pay('100');
  check('the resumed cart is paid', await shown('New sale', 10000));

  // ---- the manager at the side register: an exchange of yesterday's sale, found by register ----
  await signIn(managerEmail, 'Side');
  await tab('This shift');
  await shown('Find an earlier sale');
  check('the finder lets the manager pick the register', await waitFor(`document.querySelector('select[name=findRegister]')?.options.length === 2`, 10000).then(() => true, () => false));
  await fill('findRegister', r2.id);
  await fill('findNumber', String(oldSale.saleNumber));
  await clickText('Find');
  check('the earlier sale of R2 opens', await shown('R2-000001', 10000));
  await clickText('Exchange items');
  await waitFor(`[...document.querySelectorAll('input')].some((i) => i.name.startsWith('qty-') && i.getClientRects().length)`);
  await evaluate(`(() => { const el = [...document.querySelectorAll('input')].find((i) => i.name.startsWith('qty-') && i.getClientRects().length); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill('reason', 'Wanted rice instead');
  await clickText('Show the refund');
  check('the refund is shown before any money moves', await shown('Refund towards the new items: ₱22.40', 10000));
  await clickText('Choose the new items');
  check('Sell shows the exchange with its credit', await shown('Exchange for sale #000001', 10000));
  await scan(`RICE-${slug}`);
  check('the customer pays the difference', await totalShows('₱56.00') && await shown('Customer pays') && (await text()).includes('₱33.60'));
  await shot('exchange.png', false);
  await setById('cash', '40');
  await waitFor(`!document.getElementById('pay-submit').disabled`, 8000);
  check('the button says Complete exchange', await evaluate(`document.getElementById('pay-submit').textContent.includes('Complete exchange')`));
  await evaluate(`document.getElementById('pay-submit').click()`);
  check('the receipt names the exchange credit', await shown('EXCHANGE CREDIT (RETURN #000001)', 10000));
  const back = (await call('GET', `/v1/sales/${oldSale.id}`, tk)).lines[0].returnedQuantity;
  check('the server: one Coke back on the old sale', back === '1');
  await clickText('New sale');
  check('the exchange banner is gone after the sale', !(await text()).includes('Exchange for sale'));

  // ---- a customer on the sale, a refund as store credit, the credit spent ----
  await clickText('Customer');
  await fill('custSearch', 'Rosa');
  await evaluate(`void [...document.querySelectorAll('form')].find((f) => f.querySelector('[name=custSearch]')).requestSubmit()`);
  await waitFor(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim'))`, 10000);
  await evaluate(`void [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim')).click()`);
  check('the customer is on the sale', await waitFor(`document.querySelector('[data-testid=sale-customer]')?.innerText.includes('Rosa Lim')`, 10000).then(() => true, () => false));
  await scan(`RICE-${slug}`);
  await totalShows('₱56.00');
  await pay('56');
  check('the receipt names the customer', await shown('Customer: Rosa Lim', 10000));
  await clickText('New sale');
  await tab('This shift');
  await waitFor(`[...document.querySelectorAll('main li button')].some((x) => x.getClientRects().length)`, 10000);
  // The newest sale of this shift is first.
  await evaluate(`void [...document.querySelectorAll('main li button')].find((x) => x.getClientRects().length).click()`);
  await shown('Customer: Rosa Lim', 10000);
  await clickText('Return items');
  await waitFor(`[...document.querySelectorAll('input')].some((i) => i.name.startsWith('qty-') && i.getClientRects().length)`);
  await evaluate(`(() => { const el = [...document.querySelectorAll('input')].find((i) => i.name.startsWith('qty-') && i.getClientRects().length); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill('reason', 'Torn bag');
  check('a sale with a customer offers a refund as store credit', await evaluate(`Boolean([...document.querySelectorAll('input[name=toCredit]')].find((x) => x.getClientRects().length))`));
  await evaluate(`void [...document.querySelectorAll('input[name=toCredit]')].find((x) => x.getClientRects().length).click()`);
  await evaluate(`void [...document.querySelectorAll('form .btn-primary')].find((x) => x.getClientRects().length && x.textContent.includes('Return items')).click()`);
  check('refunded as store credit, no cash', await shown('Store credit given: ₱56.00', 10000));
  await tab('Sell');
  await clickText('Customer');
  await fill('custSearch', '0917 555');
  await evaluate(`void [...document.querySelectorAll('form')].find((f) => f.querySelector('[name=custSearch]')).requestSubmit()`);
  await waitFor(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim'))`, 10000);
  await evaluate(`void [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim')).click()`);
  check('found by phone, with ₱56.00 of store credit', await waitFor(`document.querySelector('[data-testid=sale-customer]')?.innerText.includes('₱56.00')`, 10000).then(() => true, () => false));
  await scan(`CK-${slug}`);
  await totalShows('₱22.40');
  await clickText('Use store credit');
  check('the credit pays the whole sale: nothing left to take', await waitFor(`document.querySelector('[data-testid=credit-applied]') && !document.getElementById('pay-submit').disabled`, 8000).then(() => true, () => false));
  await shot('store-credit.png', false);
  await evaluate(`document.getElementById('pay-submit').click()`);
  check('the receipt shows the store credit tender', await shown('STORE CREDIT', 10000));
  const left = (await call('GET', `/v1/customers/${rosa.id}`, tk)).storeCredit[0].balance;
  check('the server: ₱33.60 of credit left', left === '33.60');
  await clickText('New sale');

  // ---- a manager's discount ----
  await scan(`CK-${slug}`);
  await totalShows('₱22.40');
  // The line's own Discount (not "Discount all" for the whole cart, session 26).
  await evaluate(`void [...document.querySelectorAll('ul[aria-label=Cart] button')].find((x) => x.getClientRects().length && x.textContent.trim() === 'Discount').click()`);
  await fill('value', '10');
  await submitFormOf('value');
  check('10 % off, priced by the server', await totalShows('₱20.16') && (await text()).includes('−10%'));
  await shot('discount.png', false);

  // ---- Filipino and phone width ----
  await clickText('fil');
  await sleep(200);
  check('Filipino labels on the line controls', await shown('Diskwento') && (await text()).includes('Palitan ang presyo'));
  // Phone width in Filipino, whose labels are the longest: the line controls wrap, none overlaps another.
  await viewport(390, 844, true);
  await sleep(400);
  check('phone width: no horizontal scroll with the line controls', await noHorizontalScroll());
  check('phone width: the line buttons do not overlap', await evaluate(`(() => {
    const row = [...document.querySelectorAll('ul[aria-label=Cart] li')].find((li) => li.getClientRects().length);
    const rects = [...row.querySelectorAll('button')].filter((x) => x.getClientRects().length).map((x) => x.getBoundingClientRect());
    return rects.every((a, i) => rects.every((b, j) => i === j || a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5))
      && [...row.querySelectorAll('button')].every((x) => x.scrollWidth <= x.clientWidth + 1);
  })()`));
  await shot('counter-controls-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
