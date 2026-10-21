// End-to-end test of a boutique in the back office (ADR-0021, session 26):
// - Prices → Promotions: create "3 tees for 800" through the form (item picker, kind fields), see it
//   running, end it later from its page;
// - the product page shows sizes and colours, makes a store barcode;
// - Products → Quick keys puts the socks on key 1; Products → Labels draws barcodes for picked items;
// - Inventory: the shelf column, and every branch side by side;
// - Reports → Promotions and Sizes and colours after a till sale; the sale page names the promotion;
// - the guide's "Promotions, labels and shelves" part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/retail.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

const slug = `btq-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lia Tan', businessName: 'Lia Boutique', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Lia Tan Trading', tin: '123-456-789', vatStatus: 'VAT' });
const b1 = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati', birBranchCode: '00001' });
const b2 = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Quezon City', birBranchCode: '00002' });
const reg = await call('POST', '/v1/registers', tk, { branchId: b1.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const TEE = `TEE-${slug.slice(-5)}`.toUpperCase();
const tee = await call('POST', '/v1/products', tk, {
  name: 'Linen tee', taxCategoryId: vat, uomId: pc,
  variants: [
    { sku: `${TEE}-S-BLK`, name: 'S / Black', attributes: { Size: 'S', Colour: 'Black' }, price: '300.00', barcodes: ['4800016644290'] },
    { sku: `${TEE}-M-BLK`, name: 'M / Black', attributes: { Size: 'M', Colour: 'Black' }, price: '300.00' },
  ],
}, idem());
const [small, medium] = tee.variants.map((v) => v.id);
const socks = (await call('POST', '/v1/products', tk, { name: 'Ankle socks', taxCategoryId: vat, uomId: pc, variants: [{ sku: `SOX-${slug}`, price: '50.00' }] }, idem())).variants[0].id;
for (const b of [b1, b2]) {
  await call('POST', '/v1/stock/adjustments', tk, { branchId: b.id, reason: 'Opening stock', items: [small, medium, socks].map((variantId) => ({ variantId, quantity: '20', unitCost: '90.00' })) }, idem());
}
await call('PUT', '/v1/stock/locations', tk, { branchId: b1.id, items: [{ variantId: small, location: 'A1-2' }] });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9357 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const shownAnyCase = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
/** Type into (or choose in) the visible field whose label starts with `label` (React-controlled). */
const byLabel = (label, value) => evaluate(`(() => {
  const l = [...document.querySelectorAll('label')].find((x) => x.getClientRects().length && x.textContent.trim().startsWith(${JSON.stringify(label)}));
  if (!l) throw new Error('no field: ${label}');
  const el = document.getElementById(l.htmlFor) ?? l.querySelector('input, select');
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return el.id;
})()`);
const enterIn = (label) => evaluate(`(() => {
  const l = [...document.querySelectorAll('label')].find((x) => x.getClientRects().length && x.textContent.trim().startsWith(${JSON.stringify(label)}));
  document.getElementById(l.htmlFor).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  await evaluate('window.confirm = () => true');

  // ---- a promotion through the form ----
  await go('/prices/promotions');
  check('Prices has a Promotions tab that explains the kinds', await shown('Promotions') && await shownAnyCase('Buy 2, get 1'));
  await clickText('New promotion');
  await waitFor(`[...document.querySelectorAll('label')].some((x) => x.textContent.trim().startsWith('Promotion name'))`);
  await byLabel('Promotion name', '3 tees for 800');
  await byLabel('Kind', 'MULTI_BUY');
  await sleep(200);
  await byLabel('How many items', '3');
  await byLabel('For (₱)', '800.00');
  await byLabel('Find items', 'Linen tee');
  await sleep(300);
  await clickText('Add all 2');
  check('the form reads the promotion back in plain words', await shownAnyCase('3 for ₱800'));
  await shot('retail-promo-form.png', false);
  await clickText('Create promotion');
  const created = await waitFor(`document.body.innerText.includes('3 tees for 800') && !document.body.innerText.includes('Create promotion')`, 10000).then(() => true, () => false);
  const promos = (await call('GET', '/v1/promotions', tk)).data;
  const promo = promos.find((p) => p.name === '3 tees for 800');
  check('the promotion is created for both tees, every branch, running now', created && Boolean(promo) && promo.kind === 'MULTI_BUY' && promo.quantity === 3 && promo.price === '800.00' && promo.items.length === 2 && promo.allBranches && promo.state === 'RUNNING');
  await shot('retail-promotions.png', false);
  await go(`/prices/promotions/${promo.id}`);
  check('the promotion page lists its items and offers End now', await shown(`${TEE}-S-BLK`) && await shown('End now'));

  // ---- a till sale of three tees, promoted ----
  const session = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '0.00' });
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: session.id, clientTransactionId: randomUUID(), lines: [{ variantId: small, quantity: '2' }, { variantId: medium, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '800.00' }] }, idem());
  check('the server sold three tees for ₱800.00', sale.amountDue === '800.00');
  await go(`/sales/${sale.id}`);
  check('the sale page names the promotion on its lines', await shown('3 tees for 800'));

  // ---- product page: sizes and colours, a store barcode ----
  await go(`/products/${tee.id}`);
  check('the product page shows each variant’s size and colour', await shownAnyCase('Size') && (await text()).includes('Black'));
  await clickText('Make barcode');
  const barcoded = await waitFor(`/29\\d{11}/.test(document.body.innerText)`, 10000).then(() => true, () => false);
  const v2 = (await call('GET', `/v1/products/${tee.id}`, tk)).variants.find((v) => v.id === medium);
  check('“Make barcode” gives the medium tee a store barcode', barcoded && v2.barcodes.some((x) => /^29\d{11}$/.test(x)));

  // ---- quick keys ----
  await go('/products/quick-keys');
  check('Quick keys shows the empty keys in till order', await shown('Quick keys') && await shown('Empty'));
  await clickText('Put an item on a key');
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('select[name=variantId]'); const o = [...s.options].find((x) => x.textContent.includes('Ankle socks')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate(`(() => { const s = document.querySelector('select[name=position]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '1'); s.dispatchEvent(new Event('change', { bubbles: true })); s.form.requestSubmit(s.form.querySelector('.btn-primary')); })()`);
  await sleep(1500);
  const keys = (await call('GET', `/v1/catalog/quick-keys?branchId=${b1.id}`, tk)).data;
  check('the socks are on quick key 1', keys.length === 1 && keys[0].variantId === socks && keys[0].position === 1);

  // ---- labels ----
  await go('/products/labels');
  await waitFor(`[...document.querySelectorAll('label')].some((x) => x.textContent.trim().startsWith('Find items'))`, 10000);
  await byLabel('Find items', `${TEE}-S-BLK`);
  await sleep(300);
  await enterIn('Find items');
  check('a label shows the tee with its EAN-13 barcode drawn, its price and shelf', await waitFor(`document.querySelectorAll('svg rect').length > 20`, 10000).then(() => true, () => false) && await shown('₱300.00') && (await text()).includes('A1-2'));
  await shot('retail-labels.png', false);

  // ---- inventory: shelf column, every branch ----
  await go(`/inventory?branch=${b1.id}`);
  // The shelf is edited in place: its value sits in the row's input.
  check('the stock list has the shelf of the small tee', await shownAnyCase('Shelf') && await evaluate(`[...document.querySelectorAll('input')].some((i) => i.value === 'A1-2')`));
  await go('/inventory?branch=all');
  check('All branches lists both branches side by side', await shownAnyCase('Stock in every branch', 10000) && (await text()).includes('MKT-01') && (await text()).includes('QC-01'));
  await shot('retail-all-branches.png', false);

  // ---- reports ----
  await go(`/reports/promotions?branch=${b1.id}&from=${today}&to=${today}`);
  check('Reports → Promotions: the tees promotion gave ₱100.00', await shown('3 tees for 800', 10000) && (await text()).includes('₱100.00'));
  await go(`/reports/sizes-colours?branch=${b1.id}&from=${today}&to=${today}&attribute=Size`);
  check('Reports → Sizes and colours: S and M rows', await shown('Sizes and colours', 10000) && /\bS\b/.test(await text()) && /\bM\b/.test(await text()));
  await shot('retail-sizes-report.png', false);

  // ---- end the promotion from its page ----
  await go(`/prices/promotions/${promo.id}`);
  await evaluate('window.confirm = () => true');
  await clickText('End now');
  await sleep(1500);
  check('End now ends the promotion', (await call('GET', `/v1/promotions/${promo.id}`, tk)).state === 'ENDED');

  // ---- guide, Filipino, phone width ----
  await go('/help');
  check('the guide has the part “Promotions, labels and shelves”', await shownAnyCase('Promotions, labels and shelves', 10000));
  await go('/prices/promotions?state=ALL');
  await clickText('FIL');
  check('Filipino: the promotions page', await shownAnyCase('Bagong promo', 10000));
  await viewport(390, 844);
  await sleep(400);
  check('phone width: promotions page has no horizontal scroll', await noHorizontalScroll());
  await go('/products/labels');
  await sleep(600);
  check('phone width: labels page has no horizontal scroll', await noHorizontalScroll());
  await shot('retail-labels-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
