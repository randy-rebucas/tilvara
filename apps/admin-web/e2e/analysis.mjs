// End-to-end test of the reports added in session 20 (SPEC §6.10), in a retail shop with two branches:
// the Analysis group; sales by category (top level and each category); by branch, all branches at once
// with their total; discounts and price changes with who approved; purchases by supplier; payments
// that still need checking; a CSV download; Filipino; phone width.
// Usage: node apps/admin-web/e2e/analysis.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `anl-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const b1 = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const b2 = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati', birBranchCode: '00002' });
const r1 = await call('POST', '/v1/registers', tk, { branchId: b1.id, code: 'R1', name: 'Front' });
const r2 = await call('POST', '/v1/registers', tk, { branchId: b2.id, code: 'R1', name: 'Front' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const drinks = await call('POST', '/v1/categories', tk, { name: 'Drinks' });
const soda = await call('POST', '/v1/categories', tk, { name: 'Soda', parentId: drinks.id });
const product = async (name, categoryId, price, tax = 'VAT') => (await call('POST', '/v1/products', tk, { name, categoryId, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku: `${name.slice(0, 3).toUpperCase()}-${slug}`, price }] }, idem())).variants[0].id;
const cola = await product('Coke Mismo 290ml', soda.id, '22.40');
const rice = await product('Dinorado Rice 1kg', null, '56.00', 'VAT_EXEMPT');
const supplier = await call('POST', '/v1/suppliers', tk, { code: 'COKE', name: 'Coca-Cola Beverages' });
await call('POST', '/v1/goods-receipts', tk, { branchId: b1.id, supplierId: supplier.id, lines: [{ variantId: cola, quantity: '24', unitCost: '12.00' }, { variantId: rice, quantity: '10', unitCost: '40.00' }] }, idem());
await call('POST', '/v1/stock/adjustments', tk, { branchId: b2.id, reason: 'Opening', items: [{ variantId: rice, quantity: '5', unitCost: '40.00' }] }, idem());
const s1 = await call('POST', '/v1/cashier-sessions', tk, { registerId: r1.id, openingFloat: '500.00' });
await call('POST', '/v1/sales', tk, { cashierSessionId: s1.id, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '2', discountRate: '0.1' }, { variantId: rice, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '96.32' }] }, idem());
const approval = await call('POST', '/v1/price-overrides', tk, { branchId: b1.id, variantId: cola, unitPrice: '20.00', quantity: '1', reason: 'Dented can' });
await call('POST', '/v1/sales', tk, { cashierSessionId: s1.id, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '1', priceOverrideId: approval.id }], tenders: [{ method: 'CASH', tendered: '20.00' }] }, idem());
await call('POST', '/v1/payment-intents', tk, { cashierSessionId: s1.id, clientTransactionId: randomUUID(), method: 'QR', amount: '15.00' }, idem());
const s2 = await call('POST', '/v1/cashier-sessions', tk, { registerId: r2.id, openingFloat: '0.00' });
await call('POST', '/v1/sales', tk, { cashierSessionId: s2.id, clientTransactionId: randomUUID(), lines: [{ variantId: rice, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '56.00' }] }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9353 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const q = `branch=${b1.id}`;

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  await go(`/reports/sales?${q}`);
  check('a retail shop now has report groups: Sales and Analysis, no Restaurant', await shown('Analysis') && !(await text()).includes('Item performance'));
  await clickText('Analysis');
  await waitFor(`location.pathname === '/reports/categories'`, 10000);
  // Section titles are upper-cased by CSS: compare without case.
  check('by category: Drinks at the top level, Soda under it, rice without a category', (await text()).toLowerCase().includes('top-level categories') && (await text()).includes('Drinks') && (await text()).includes('Soda') && (await text()).includes('No category'));
  check('the Analysis group has its own lede', (await text()).includes('Across categories and branches'));
  check('the estimated-margin note is there', (await text()).includes('It is an estimate, not an audited profit.'));
  await shot('report-categories.png');

  await go(`/reports/branches?${q}`);
  check('by branch: both branches and the total, no branch picker', await shown('CUB-01') && (await text()).includes('MKT-01') && (await text()).includes('All branches') && !(await evaluate(`Boolean(document.querySelector('nav[aria-label="Branch"]'))`)));
  check('by branch: the total of ₱116.32 + ₱56.00', (await text()).includes('₱172.32'));
  await shot('report-branches.png');

  await go(`/reports/discounts?${q}`);
  check('discounts: the 10 % off and the approved price, with who approved and why', await shown('₱4.48') && (await text()).includes('Dented can') && (await text()).includes('Nena Reyes') && (await text()).includes('₱2.40'));
  const csv = await evaluate(`fetch('/reports/export?report=discounts&${q}&from=' + new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())).then((r) => r.text())`);
  check('discounts as CSV: one row per line, the reason in its column', csv.split('\r\n').filter(Boolean).length === 3 && csv.includes('Dented can'));
  await shot('report-discounts.png');

  await go(`/reports/purchases?${q}`);
  check('purchases by supplier: ₱688.00 received from Coca-Cola Beverages', await shown('Coca-Cola Beverages') && (await text()).includes('₱688.00'));

  await go(`/reports/payments?${q}`);
  check('payments to check: the QR payment in no sale, with its shift, and no dates to pick', await shown('Approved, but in no sale', 8000) && (await text()).includes('₱15.00') && !(await evaluate(`Boolean(document.querySelector('input[name="from"]'))`)));
  await shot('report-payments.png');

  await clickText('FIL');
  check('Filipino: the group and tabs are translated', await shown('Pagsusuri') && (await text()).includes('Bayad na susuriin'));
  await clickText('EN');
  await viewport(390, 844, true);
  await go(`/reports/discounts?${q}`);
  check('390px: no sideways scroll on the discounts report', await noHorizontalScroll());
  await shot('report-discounts-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
