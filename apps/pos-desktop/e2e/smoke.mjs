// End-to-end smoke test for the POS counter (browser mode), over CDP with local Edge/Chrome.
// Usage: node apps/pos-desktop/e2e/smoke.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview, port 3330) running.
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const PASSWORD = 'correct horse battery staple';

// --- arrange a shop through the API (owner holds every permission, incl. manager actions)
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
const slug = `pos-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Aling Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Aling Nena', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = async (name, sku, barcode, price, tax = 'VAT') =>
  (await call('POST', '/v1/products', tk, { name, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku, barcodes: barcode ? [barcode] : [], price }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const cola = await product('Coke Mismo 290ml', 'CK-290', '4801981116072', '22.40');
await product('Dinorado Rice 1kg', 'RICE-1', null, '56.00', 'VAT_EXEMPT');
await product('Pancit Canton Chilimansi', 'PC-CHILI', '4807770270017', '16.50');
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '24' }] }, { 'idempotency-key': randomUUID() });

// --- drive the counter
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9336 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(500);
};
const setInput = (id, value) =>
  evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
// The Sell view stays mounted (hidden) behind other tabs: act on the visible form only.
const submitVisible = () => evaluate(`[...document.querySelectorAll('form .btn-primary')].find((e) => e.getClientRects().length).click()`);
const shown = (s) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`).then(() => true, () => false);
const totalShows = (amount) => waitFor(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`, 8000).then(() => true, () => false);

try {
  await viewport(1440, 900);
  await go('/');
  check('sign-in screen with browser-mode notice', (await text()).toLowerCase().includes('browser mode'));
  await shot('sign-in.png', false);
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Counter 1')`);
  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  check('shift opened; counter shows the scan field focused', await evaluate(`document.activeElement?.id === 'scan'`));

  // Sale 1: barcode + SKU, cash with change
  await scan('4801981116072');
  await scan('RICE-1');
  check('server-priced total for barcode + SKU items (₱78.40)', await totalShows('₱78.40'));
  check('VAT breakdown shows VATable and exempt sales', /VATable sales[\s\S]*₱20\.00/.test(await text()) && /VAT-exempt sales[\s\S]*₱56\.00/.test(await text()));
  await shot('sell-cart.png', false);
  await clickText('₱100.00');
  await sleep(200);
  check('change preview ₱21.60', (await text()).includes('₱21.60'));
  await clickText('Complete sale');
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const r1 = await text();
  check('receipt: not an invoice, VAT REG TIN, reference R1-000001', r1.includes('VAT REG TIN 123-456-789-00000') && r1.includes('R1-000001'));
  await shot('receipt-cash.png');
  await clickText('New sale');

  // Sale 2: SC/PWD on a line, paid by card
  await scan('PC-CHILI');
  await clickText('SC/PWD');
  await waitFor(`document.querySelector('input[name="name"]')`);
  await fill('name', 'Corazon Dela Cruz');
  await fill('idNumber', 'OSCA-0001');
  await clickText('Apply');
  check('SC computed by server: ₱16.50 → ₱11.78 due', await totalShows('₱11.78'));
  check('pending-review notice shown for SC/PWD', (await text()).includes('tax-professional sign-off'));
  await shot('sell-sc.png', false);
  await clickText('Card');
  await waitFor(`document.body.innerText.includes('Approved')`);
  await clickText('Complete sale');
  await waitFor(`document.body.innerText.includes('Signature')`);
  const r2 = await text();
  check('card sale receipt carries the SC block with ID and signature line', r2.includes('OSCA-0001') && r2.includes('CARD'));
  await shot('receipt-sc-card.png');
  await clickText('New sale');

  // Return one Coke from sale 1 (owner has sales.refund)
  await clickText('This shift');
  await waitFor(`document.body.innerText.includes('#000001')`);
  await clickText('#000001');
  await waitFor(`document.body.innerText.includes('Return items')`);
  await clickText('Return items');
  await waitFor(`document.querySelector('[id^="qty-"]')`);
  const qtyId = await evaluate(`document.querySelector('[id^="qty-"]').id`);
  await setInput(qtyId, '1');
  await setInput('reason', 'Dented can');
  await submitVisible();
  check('cash refund for the returned item (₱22.40)', await waitFor(`document.body.innerText.includes('Refund ₱22.40')`).then(() => true, () => false));
  await shot('history-return.png');

  // Close: expected = 1000 + 78.40 cash − 22.40 refund (card sale moves no cash)
  await clickText('Close shift');
  check('expected drawer ₱1,056.00', await waitFor(`document.body.innerText.includes('₱1,056.00')`).then(() => true, () => false));
  await fill('counted', '1056.00');
  await submitVisible();
  check('drawer balanced on close', await waitFor(`document.body.innerText.includes('Drawer balanced')`).then(() => true, () => false));
  await shot('close-balanced.png', false);

  const openShift = async () => {
    await clickText('Back');
    await waitFor(`document.body.innerText.includes('Counter 1')`);
    await clickText('Open shift');
    await fill('float', '0');
    await submitVisible();
    await waitFor(`document.getElementById('scan')`);
  };

  // Phase 2 exit drills at the counter: the cart survives a look at the shift, a double-clicked
  // Complete records one sale, and a card payment with no sale blocks the close until settled.
  await openShift();
  await scan('4801981116072');
  await clickText('This shift');
  await sleep(300);
  await clickText('Sell');
  check('cart survives switching to the shift history and back', await totalShows('₱22.40'));
  await clickText('₱50.00');
  await sleep(200);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Complete sale')); b.click(); b.click(); })()`);
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const ws = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.openSession?.mine);
  const shiftSales = (await call('GET', `/v1/sales?cashierSessionId=${ws.openSession.id}`, tk)).data;
  check('double-clicked Complete sale records exactly one sale (R1-000003)', shiftSales.length === 1 && (await text()).includes('R1-000003'));
  await clickText('New sale');
  await scan('4801981116072');
  await clickText('Card');
  await waitFor(`document.body.innerText.includes('Approved')`);
  await clickText('Close shift');
  await waitFor(`document.getElementById('counted')`);
  await fill('counted', '22.40');
  await submitVisible();
  check('close refused while a card payment belongs to no sale', await shown('not part of a sale') && (await text()).includes('Cancel payment'));
  await shot('close-blocked.png', false);
  await clickText('Cancel payment');
  await waitFor(`!document.body.innerText.includes('Cancel payment')`);
  await submitVisible();
  check('after cancelling the card payment the drawer closes balanced (₱22.40)', await shown('Drawer balanced'));

  // Layout at a tablet counter and a phone width
  await openShift();
  await scan('4801981116072');
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await viewport(w, h, w < 500);
    await sleep(300);
    check(`no horizontal scroll at ${w}px`, await noHorizontalScroll());
    await shot(`sell-${w}.png`);
  }
  await viewport(1440, 900);

  // Filipino
  await clickText('fil');
  await sleep(200);
  check('Filipino UI', (await text()).includes('Kabuuang babayaran'));
  await shot('sell-fil.png', false);
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
