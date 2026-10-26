// End-to-end test of a boutique at the counter (ADR-0021, session 26):
// - "3*" before a scan sells three; a "3 tees for ₱800" promotion prices them and shows in green;
// - quick keys add an item without a barcode; "Buy 2 socks, get 1 free" applies on the third pair;
// - the receipt prints each promotion with what it took off; the server recorded the promotions;
// - "Discount all" gives 10 % off every line that has no promotion; "0*" is refused;
// - phone width.
// Usage: node apps/pos-desktop/e2e/retail.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './api.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `ret-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lia Tan', businessName: 'Lia Boutique', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Lia Tan Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const TEE = `TEE-${slug}`.toUpperCase();
const tee = await call('POST', '/v1/products', tk, {
  name: 'Linen tee', taxCategoryId: vat, uomId: pc,
  variants: [
    { sku: `${TEE}-S-BLK`, name: 'S / Black', attributes: { Size: 'S', Colour: 'Black' }, price: '300.00' },
    { sku: `${TEE}-M-BLK`, name: 'M / Black', attributes: { Size: 'M', Colour: 'Black' }, price: '300.00' },
  ],
}, idem());
const [small, medium] = tee.variants.map((v) => v.id);
const socks = (await call('POST', '/v1/products', tk, { name: 'Ankle socks', taxCategoryId: vat, uomId: pc, variants: [{ sku: `SOX-${slug}`, price: '50.00' }] }, idem())).variants[0].id;
const cap = (await call('POST', '/v1/products', tk, { name: 'Bucket hat', taxCategoryId: vat, uomId: pc, variants: [{ sku: `CAP-${slug}`, price: '150.00' }] }, idem())).variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [small, medium, socks, cap].map((variantId) => ({ variantId, quantity: '40', unitCost: '90.00' })) }, idem());
await call('PATCH', `/v1/variants/${socks}`, tk, { quickKeyPosition: 1 });
const teesPromo = await call('POST', '/v1/promotions', tk, { name: '3 tees for 800', kind: 'MULTI_BUY', quantity: 3, price: '800.00', variantIds: [small, medium] }, idem());
const socksPromo = await call('POST', '/v1/promotions', tk, { name: 'Socks 2+1', kind: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, getRate: '1', variantIds: [socks] }, idem());
// A dated item with one batch on hold (a recall): 3 on hand, 2 sellable at the counter (ADR-0020).
const SUN = `SUN-${slug}`.toUpperCase();
const sun = (await call('POST', '/v1/products', tk, { name: 'Sunscreen 50ml', taxCategoryId: vat, uomId: pc, tracksExpiry: true, variants: [{ sku: SUN, price: '300.00' }] }, idem())).variants[0].id;
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Delivery', items: [
  { variantId: sun, quantity: '2', unitCost: '200.00', expiresOn: inDays(200), lotCode: 'SUN-A' },
  { variantId: sun, quantity: '1', unitCost: '200.00', expiresOn: inDays(300), lotCode: 'SUN-B' },
] }, idem());
await call('POST', '/v1/stock/lot-holds', tk, { variantId: sun, lotCode: 'SUN-B', reason: 'Supplier recall' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9346 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(600);
};
const totalShows = (amount) => waitFor(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`, 8000).then(() => true, () => false);
const setById = (id, value) =>
  evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const pay = async (cash) => {
  await setById('cash', cash);
  await waitFor(`!document.getElementById('pay-submit').disabled`, 8000);
  await evaluate(`document.getElementById('pay-submit').click()`);
};
const quickKey = (name) => evaluate(`void [...document.querySelectorAll('[data-testid=quick-keys] button')].find((x) => x.textContent.includes(${JSON.stringify(name)})).click()`);

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front')`);
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === 'Front').querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);

  check('the keys row explains 5* before a scan', await shown('how many, then scan'));
  check('the quick keys show the socks with their price', await waitFor(`document.querySelector('[data-testid=quick-keys]')?.innerText.includes('Ankle socks')`, 10000).then(() => true, () => false) && (await text()).includes('₱50.00'));

  // ---- 3* before a scan; the promotion prices three tees ----
  await scan(`3*${TEE}-S-BLK`);
  check('3* sells three on one line', await evaluate(`document.querySelector('[data-testid=cart] .money.w-10')?.textContent.trim() === '3'`));
  check('the tees promotion shows on the line, total ₱800.00', await totalShows('₱800.00') && await waitFor(`document.querySelector('[data-testid=line-promotion]')?.innerText.includes('3 tees for 800')`, 8000).then(() => true, () => false));

  // ---- quick keys and buy 2, get 1 ----
  for (let i = 0; i < 3; i++) {
    await quickKey('Ankle socks');
    await sleep(400);
  }
  check('three socks from the quick key, the third pair free: total ₱900.00', await totalShows('₱900.00') && (await text()).includes('Socks 2+1'));
  await shot('retail-promotions.png', false);
  await pay('1000');
  check('the receipt names each promotion with what it took off', await shown('3 tees for 800 −100.00', 10000) && (await text()).includes('Socks 2+1 −50.00'));
  await shot('retail-receipt.png', false);
  const sales = (await call('GET', '/v1/sales', tk)).data;
  const sold = await call('GET', `/v1/sales/${sales[0].id}`, tk);
  check('the server recorded the promotions on the lines', sold.amountDue === '900.00' && sold.lines.map((l) => l.promotionId).join() === [teesPromo.id, socksPromo.id].join());
  await clickText('New sale');

  // ---- 0* is refused; discount all skips promoted lines ----
  await scan(`0*${TEE}-M-BLK`);
  check('0* is refused with a hint', await shown('Type how many before the *'));
  await scan(`2*SOX-${slug}`);
  await scan(`CAP-${slug}`);
  await scan(`${TEE}-M-BLK`);
  await totalShows('₱550.00');
  await clickText('Discount all');
  check('the cart discount says how many lines it reaches (not the socks, no promotion either: 3)', await shown('For 3 item(s)'));
  await fill('cartPercent', '10');
  await evaluate(`void document.querySelector('[data-testid=cart-discount] .btn-primary').click()`);
  // Socks 2 × 50 = 100 (two socks earn no free pair) − 10 %; hat 150 − 15; tee 300 − 30 → 495.00.
  check('10 % off every line without a promotion: ₱495.00', await totalShows('₱495.00'));
  await shot('retail-discount-all.png', false);

  await viewport(390, 844);
  await sleep(400);
  check('phone width: no horizontal scroll with quick keys and the cart', await noHorizontalScroll());
  await shot('retail-390.png', false);

  // The dated item: a line asking for more than is sellable shows the chip, and the sale is refused in words.
  await viewport(1440, 900);
  await pay('1000');
  await waitFor(`document.body.innerText.includes('New sale')`, 8000);
  await clickText('New sale');
  await waitFor(`document.getElementById('scan')`);
  await scan(`3*${SUN}`);
  check('a line beyond what is sellable warns before payment', await shown('Only 2 of Sunscreen 50ml can be sold here'));
  check('the line shows the chip “Expired or on hold · 2 sellable”', await waitFor(`document.querySelector('[data-testid=line-expired]')?.innerText.includes('Expired or on hold · 2 sellable')`, 8000).then(() => true, () => false));
  await shot('retail-expired-chip.png', false);
  await pay('1000');
  check('completing is refused: not enough sellable stock, lower the quantity', await shown('Not enough sellable stock for Sunscreen 50ml (2 sellable)'));
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
