// End-to-end test of stock reservations and the supplier catalog (session 20) in the back office:
// reserve stock for a customer's order, see on hand / reserved / available, release it; add an item
// to a supplier's catalog with their SKU and cost, make them preferred, and create a purchase order
// whose line takes its cost from the catalog; the order shows the supplier's SKU. Filipino, phone width.
// Usage: node apps/admin-web/e2e/inventory-extras.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

const slug = `inx-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const sku = `CK-${slug}`.toUpperCase();
const cola = (await call('POST', '/v1/products', tk, { name: 'Coke Mismo 290ml', taxCategoryId: vat, uomId: pc, variants: [{ sku, price: '22.40' }] }, idem())).variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '10', unitCost: '12.00' }] }, idem());
const supplier = await call('POST', '/v1/suppliers', tk, { code: 'COKE', name: 'Coca-Cola Beverages' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9354 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary') ?? undefined);
})()`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  // ---- reservations ----
  await go(`/inventory/reservations?branch=${br.id}`);
  check('the Reservations tab says nothing is reserved', await shown('Nothing is reserved at this branch.'));
  await clickText('Reserve stock');
  await fill('variantId', cola);
  await fill('quantity', '12');
  await fill('note', 'Maria, pick-up Saturday');
  await submitFormOf('note');
  check('more than is on hand is refused in words', await shown('Not that much is available to reserve', 8000));
  await fill('quantity', '3');
  await submitFormOf('note');
  check('the reservation is listed', await shown('Maria, pick-up Saturday', 8000) && (await text()).includes('Until released'));
  await go(`/inventory?branch=${br.id}`);
  check('Stock & value shows on hand 10, reserved 3, available 7', await evaluate(`(() => { const row = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes(${JSON.stringify(sku)})); return row && /\\b10\\b/.test(row.innerText) && /\\b3\\b/.test(row.innerText) && /\\b7\\b/.test(row.innerText); })()`));
  await shot('inventory-reserved.png', false);
  await go(`/inventory/reservations?branch=${br.id}`);
  await clickText('Release');
  await fill('reason', 'Collected and paid');
  await evaluate(`void [...document.querySelectorAll('form button')].find((x) => x.getClientRects().length && x.textContent.trim() === 'Release').click()`);
  check('released: nothing reserved any more', await shown('Nothing is reserved at this branch.', 8000));
  const after = (await call('GET', `/v1/stock/balances?branchId=${br.id}&variantId=${cola}`, tk)).data[0];
  check('the API agrees: available 10 again', after.reserved === '0' && after.available === '10');

  // ---- supplier catalog ----
  await go(`/purchasing/suppliers/${supplier.id}`);
  check('the supplier page has a catalog, empty', await shown('No items in this supplier’s catalog yet.'));
  await clickText('Add an item');
  await fill('variantId', cola);
  await fill('supplierSku', 'KO-290-24');
  await fill('unitCost', '11.50');
  await evaluate(`void document.querySelector('input[name="preferred"]').click()`);
  await submitFormOf('supplierSku');
  check('the item is in the catalog with their SKU, cost and preferred', await shown('KO-290-24', 8000) && (await text()).includes('₱11.50') && (await text()).includes('Preferred supplier'));
  await shot('supplier-catalog.png');

  // A purchase order with the cost left blank takes it from the catalog.
  await go('/purchasing');
  await clickText('New purchase order');
  await waitFor(`document.querySelector('[name="lines.0.quantity"]')`);
  await fill('supplierId', supplier.id);
  await fill('lines.0.variantId', cola);
  await fill('lines.0.quantity', '24');
  check('the cost field says it comes from the catalog', await evaluate(`document.querySelector('[name="lines.0.unitCost"]').placeholder === 'Catalog cost'`));
  await submitFormOf('lines.0.quantity');
  await waitFor(`location.pathname.startsWith('/purchasing/orders/')`, 10000);
  check('the order took ₱11.50 from the catalog and shows their SKU', await shown('₱276.00', 8000) && (await text()).includes('KO-290-24'));

  await clickText('FIL');
  check('Filipino: the order page is translated', await waitFor(`document.body.innerText.toLowerCase().includes('sku ng supplier')`, 8000).then(() => true, () => false));
  await clickText('EN');
  await viewport(390, 844, true);
  await go(`/purchasing/suppliers/${supplier.id}`);
  check('390px: no sideways scroll on the supplier page', await noHorizontalScroll());
  await go(`/inventory/reservations?branch=${br.id}`);
  check('390px: no sideways scroll on Reservations', await noHorizontalScroll());
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
