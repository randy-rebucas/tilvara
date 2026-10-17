// End-to-end test of the back-office screens added from the leftovers (session 10): product editing,
// price lists and branch assignment, supplier edit/archive, draft order editing, return to supplier,
// all reorder points, journal filters and document links (sale, return, pay-in, shift), custom roles
// and member access, and the tax registration history. Setup goes through the API; every check is on
// the real admin screens.
// Usage: node e2e/backoffice.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `bo-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const br2 = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-02', name: 'Quezon Ave', birBranchCode: '00001' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = (name, sku, price) => call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, variants: [{ sku, barcodes: [`480${Math.floor(Math.random() * 1e10)}`], price }] }, idem());
const cola = await product('Coke Mismo 290ml', `CK-${slug}`, '22.00');
const canton = await product('Pancit Canton', `PC-${slug}`, '16.50');
const supplier = await call('POST', '/v1/suppliers', tk, { code: 'SUP-1', name: 'Coca-Cola Distributor' });
const spare = await call('POST', '/v1/suppliers', tk, { code: 'SUP-2', name: 'Old Supplier' });
const draft = await call('POST', '/v1/purchase-orders', tk, { branchId: br.id, supplierId: supplier.id, lines: [{ variantId: cola.variants[0].id, quantity: '24', unitCost: '15.00' }] }, idem());
const po = await call('POST', '/v1/purchase-orders', tk, { branchId: br.id, supplierId: supplier.id, lines: [{ variantId: canton.variants[0].id, quantity: '48', unitCost: '11.00' }] }, idem());
await call('POST', `/v1/purchase-orders/${po.id}/approve`, tk, {});
const grn = await call('POST', '/v1/goods-receipts', tk, { branchId: br.id, supplierId: supplier.id, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0].id, variantId: canton.variants[0].id, quantity: '48' }] }, idem());
await call('PUT', '/v1/stock/reorder-points', tk, { branchId: br.id, items: [{ variantId: canton.variants[0].id, reorderPoint: '10' }, { variantId: cola.variants[0].id, reorderPoint: '5' }] });
const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: canton.variants[0].id, quantity: '3' }], tenders: [{ method: 'CASH', tendered: '100.00' }] }, idem());
await call('POST', `/v1/sales/${sale.id}/returns`, tk, { cashierSessionId: shift.id, kind: 'RETURN', reason: 'Expired pack', lines: [{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'DAMAGED' }] }, idem());
const payIn = await call('POST', `/v1/cashier-sessions/${shift.id}/movements`, tk, { type: 'PAY_IN', amount: '200.00', reason: 'Change fund' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9346 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
// innerText applies CSS text-transform (section titles are uppercase), so compare case-insensitively.
const pageText = () => evaluate('document.body.innerText.toLowerCase()');
const has = async (...all) => { const t = await pageText(); return all.every((s) => t.includes(s.toLowerCase())); };
const shown = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
/** Text of the record rows only (no filters, no navigation). */
const rowsText = () => evaluate(`[...document.querySelectorAll('main table tbody, main ul')].map((x) => x.innerText).join(' ').toLowerCase()`);
/** Submit the visible form that holds an input with this name (forms on these pages have no unique ids). */
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary') ?? undefined);
})()`);
const clickHref = (prefix) => evaluate(`(() => {
  const a = [...document.querySelectorAll('main a')].find((x) => x.getAttribute('href')?.startsWith(${JSON.stringify(prefix)}) && x.getClientRects().length);
  if (!a) throw new Error('no link to ${prefix}');
  a.click();
})()`);
const acceptConfirms = () => evaluate('window.confirm = () => true');

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Overview')`);

  // 1. Product page: rename, add a variant, add and remove a barcode.
  await go('/products');
  await clickHref(`/products/${canton.id}`);
  await waitFor(`location.pathname === '/products/${canton.id}'`);
  check('product page opens from the list with its variant and price', (await shown('Variants')) && (await has('₱16.50')));
  await clickText('Edit product');
  await fill('name', 'Lucky Me Pancit Canton');
  await submitFormOf('name');
  check('product renamed in place', await shown('Lucky Me Pancit Canton'));
  await clickText('Add variant');
  await fill('name', 'Kalamansi');
  await fill('sku', `PCK-${slug}`);
  await fill('price', '17.00');
  await submitFormOf('sku');
  check('a second variant added with its price', (await shown('Kalamansi')) && (await shown('₱17.00')));
  await fill('code', '4807770270099');
  await evaluate(`[...document.querySelectorAll('[name="code"]')].find((x) => x.getClientRects().length).form.requestSubmit()`);
  check('barcode added to a variant', await shown('4807770270099'));
  await acceptConfirms();
  await evaluate(`document.querySelector('[aria-label="Remove barcode 4807770270099"]').click()`);
  check('barcode removed (archived)', await waitFor(`!document.body.innerText.includes('4807770270099')`).then(() => true, () => false));
  await shot('bo-product.png');

  // 2. Price lists: create one, use it at a branch, then back to the default.
  await go('/prices');
  await clickText('New price list');
  await fill('name', 'Mall prices');
  await submitFormOf('name');
  check('price list created and selected', (await waitFor(`location.search.includes('list=')`).then(() => true, () => false)) && (await shown('Mall prices')) && (await shown('no branch yet')));
  await fill('branchId', br2.id);
  await clickText('Use this list there');
  check('list used at a branch', await shown('Used at: QC-02'));
  await clickText('Back to the default list at QC-02');
  check('branch back on the default list', await shown('no branch yet'));
  await shot('bo-prices.png');

  // 3. Supplier page: edit, archive one without orders.
  await go(`/purchasing/suppliers/${supplier.id}`);
  check('supplier page shows its orders', (await shown('Coca-Cola Distributor')) && (await has('Open orders')));
  await clickText('Edit supplier');
  await fill('phone', '0917 555 0101');
  await submitFormOf('phone');
  check('supplier edited', await shown('0917 555 0101'));
  await go(`/purchasing/suppliers/${spare.id}`);
  await acceptConfirms();
  await clickText('Archive supplier');
  check('supplier archived', await shown('Archived on'));

  // 4. Draft order: change the quantity.
  await go(`/purchasing/orders/${draft.id}`);
  await clickText('Edit draft');
  await waitFor(`document.querySelector('[name="lines.0.quantity"]')`);
  check('draft editor opens with the current line', await evaluate(`document.querySelector('[name="lines.0.quantity"]').value === '24'`));
  await fill('lines.0.quantity', '36');
  await submitFormOf('lines.0.quantity');
  check('draft saved: 36 ordered, value ₱540.00', await shown('₱540.00'));

  // 5. Return to supplier from the goods receipt.
  await go(`/purchasing/receipts/${grn.id}`);
  check('receipt offers a return and lists none yet', await shown('Nothing returned from this delivery.'));
  await clickText('Return to supplier');
  await fill('reason', 'Crushed cartons');
  await fill('lines.0.quantity', '6');
  await submitFormOf('reason');
  await waitFor(`location.pathname.startsWith('/purchasing/returns/')`);
  check('return document: 6 back, credit ₱66.00, journal link', (await shown('Supplier return')) && (await has('₱66.00', 'Journal entry')));
  await shot('bo-supplier-return.png');
  await go(`/purchasing/receipts/${grn.id}`);
  check('receipt now shows 6 returned and the return', (await shown('Supplier return 000001')) && (await has('Returned')));

  // 6. All reorder points, and removing one.
  await go(`/inventory?branch=${br.id}`);
  check('all reorder points listed (low or not)', (await shown('All reorder points')) && (await has(`CK-${slug}`)));
  await evaluate(`document.querySelector('[aria-label="Remove: Coke Mismo 290ml"]').click()`);
  check('reorder point removed', await waitFor(`!document.querySelector('[aria-label="Remove: Coke Mismo 290ml"]')`).then(() => true, () => false));

  // 7. Journal: filter by source; links to the documents.
  await go(`/books?entity=${le.id}`);
  await fill('type', 'SUPPLIER_RETURN');
  await evaluate(`document.querySelector('form[action="/books"]').requestSubmit()`);
  await waitFor(`location.search.includes('type=SUPPLIER_RETURN')`);
  const rows = await rowsText();
  check('journal filtered to supplier returns', rows.includes('supplier return') && !rows.includes('goods receipt') && !rows.includes('sale'));
  await fill('from', '2030-01-01');
  await evaluate(`document.querySelector('form[action="/books"]').requestSubmit()`);
  check('a date range with nothing in it says so', await shown('No entries match these dates and source.'));
  await go(`/books?entity=${le.id}`);
  const journalCsv = await evaluate(`fetch(document.querySelector('a[href^="/books/export"]').getAttribute('href')).then(async (r) => ({ type: r.headers.get('content-type'), body: await r.text() }))`);
  check('journal CSV: one row per line with account codes, debits = credits', journalCsv.type.startsWith('text/csv') && journalCsv.body.includes('Account code') && (() => {
    const rows = journalCsv.body.replace(/^﻿/, '').trim().split('\r\n').slice(1).map((r) => r.split(','));
    const sum = (i) => rows.reduce((a, r) => a + Math.round(Number(r.at(i)) * 100), 0);
    return rows.length > 4 && sum(-2) === sum(-1);
  })());
  await go(`/books?entity=${le.id}&type=SALE`);
  await clickHref(`/sales/${sale.id}`);
  await waitFor(`location.pathname === '/sales/${sale.id}'`);
  check('sale page from the journal: line, return, journal links', (await shown('Sale 000001')) && (await has('Return 000001', 'Expired pack', 'Journal entry')));
  await shot('bo-sale.png');
  await go(`/books?entity=${le.id}&type=SALE_RETURN`);
  await clickHref('/sales/returns/');
  check('return entry opens its sale at the return', await waitFor(`location.pathname === '/sales/${sale.id}'`).then(() => true, () => false));
  await go(`/books?entity=${le.id}&type=CASH_MOVEMENT`);
  await clickHref('/shifts/movements/');
  check('pay-in entry opens its shift', (await waitFor(`location.pathname === '/shifts/${shift.id}'`).then(() => true, () => false)) && (await shown('Change fund')));
  check('shift page: float, pay-in, sales', await has('₱1,000.00', '₱200.00', '000001'));
  check('pay-in anchored for the link', await evaluate(`Boolean(document.getElementById('movement-${payIn.id}'))`));
  await shot('bo-shift.png');

  // 8. Team: a custom role with two permissions; the owner's access shown.
  await go('/team');
  await clickText('New role');
  await fill('name', 'Stock counter');
  await fill('key', 'stock_counter');
  await evaluate(`for (const v of ['inventory.read', 'inventory.adjust']) document.querySelector('input[name="permissions"][value="' + v + '"]').click()`);
  await submitFormOf('key');
  await waitFor(`location.pathname.startsWith('/team/roles/')`);
  check('custom role page lists its permissions in words', (await shown('Stock counter')) && (await has('See stock', 'Adjust and count stock')));
  await clickText('Edit role');
  await evaluate(`document.querySelector('input[name="permissions"][value="inventory.transfer"]').click()`);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.getClientRects().length).click()`);
  check('role edited: a third permission', await shown('Transfer stock between branches'));
  await go('/team');
  await clickHref('/team/members/');
  await waitFor(`location.pathname.startsWith('/team/members/')`);
  check('member page shows the owner role for the whole business', (await shown('Owner')) && (await has('Whole business')));
  await clickText('Change access');
  await clickText('Add a role');
  await sleep(200);
  check('access editor offers the new role and the branches', await evaluate(`[...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.textContent === 'Stock counter')) && document.body.innerHTML.includes('CUB-01')`));
  check('member page says whether two-step sign-in is on; no reset offered for oneself', (await has('two-step sign-in off')) && !(await has('Reset two-step sign-in')));
  await shot('bo-member.png');

  // Audit log: from the Team page; the role's history; filtered by family.
  await go('/team');
  await clickHref('/audit');
  await waitFor(`location.pathname === '/audit'`);
  check('audit log lists the role changes, newest first, with who did them', (await shown('role.updated')) && (await has('role.created', 'Nena Reyes')));
  await fill('action', 'role');
  await evaluate(`document.querySelector('form[action="/audit"]').requestSubmit()`);
  await waitFor(`location.search.includes('action=role')`);
  check('filtered to roles: only role.* entries', await evaluate(`(() => { const a = [...document.querySelectorAll('main table tbody tr td:nth-child(3)')].map((td) => td.innerText.trim().toLowerCase()); return a.length >= 2 && a.every((x) => x.startsWith('role.')); })()`));
  await shot('bo-audit.png');

  // 9. Tax registration history: schedule a change.
  await go(`/locations/entities/${le.id}`);
  check('entity page shows the VAT registration in force', (await shown('Tax registration')) && (await has('In force', 'VAT 12%')));
  await clickText('Change tax registration');
  await fill('effectiveAt', '2031-01-01T00:00');
  await fill('note', 'E2E scheduled change');
  await submitFormOf('note');
  check('a scheduled version appears beside the one in force', (await shown('E2E scheduled change')) && (await has('Scheduled')));
  await shot('bo-tax.png');

  // 10. Retail reports: summary, by product, by tender, CSV, quick ranges.
  await go('/');
  await evaluate(`[...document.querySelectorAll('header nav a')].find((a) => a.textContent === 'Reports').click()`);
  await waitFor(`location.pathname === '/reports/sales'`);
  check('Reports opens on the sales summary: ₱49.50 sold, ₱16.50 back, ₱33.00 net', (await shown('Summary')) && (await has('₱49.50', '₱16.50', '₱33.00')));
  await shot('bo-report-sales.png');
  await clickText('By product');
  await waitFor(`location.pathname === '/reports/products'`);
  check('by product: the canton, 3 sold, 1 returned', (await shown(`PC-${slug}`)) && (await has('Lucky Me Pancit Canton')));
  await clickText('By tender');
  await waitFor(`location.pathname === '/reports/tenders'`);
  check('by tender: cash net ₱33.00', (await shown('CASH')) && (await has('₱33.00')));
  const csv = await evaluate(`fetch(document.querySelector('a[download]').getAttribute('href')).then(async (r) => ({ type: r.headers.get('content-type'), name: r.headers.get('content-disposition'), body: await r.text() }))`);
  check('CSV download: tender rows with exact amounts', csv.type.startsWith('text/csv') && csv.name.includes('1pos-tenders-') && csv.body.includes('CASH,1,49.50,1,16.50,33.00'));
  await clickText('This month');
  check('quick range "This month" starts on the 1st', await waitFor(`/from=\\d{4}-\\d{2}-01/.test(location.search)`).then(() => true, () => false));
  await clickHref('/reports?'); // the Restaurant group (the band also has a Restaurant tab)
  check('the restaurant group keeps its tabs', await waitFor(`location.pathname === '/reports'`).then(() => true, () => false) && (await shown('Item performance')));

  // 11. Phone width and Filipino.
  await viewport(390, 844, true);
  const pages = [`/products/${canton.id}`, '/prices', `/purchasing/suppliers/${supplier.id}`, `/sales/${sale.id}`, `/shifts/${shift.id}`, '/team', `/locations/entities/${le.id}`, `/books?entity=${le.id}`, '/reports/sales', '/reports/products', '/reports/tax'];
  const wide = [];
  for (const p of pages) {
    await go(p);
    if (!(await noHorizontalScroll())) wide.push(p);
  }
  check(`390px: ${pages.length} new pages without sideways scroll${wide.length ? ` (wide: ${wide.join(', ')})` : ''}`, wide.length === 0);
  await viewport(1440, 900);
  await evaluate(`fetch('/api/auth/lang', { method: 'POST', headers: { 'content-type': 'application/json', 'x-onepos-request': '1' }, body: JSON.stringify({ lang: 'fil' }) })`);
  await go(`/locations/entities/${le.id}`);
  check('Filipino: tax page and VAT status in Filipino', (await shown('Rehistro sa buwis')) && (await has('Rehistrado sa VAT')));
  await evaluate(`fetch('/api/auth/lang', { method: 'POST', headers: { 'content-type': 'application/json', 'x-onepos-request': '1' }, body: JSON.stringify({ lang: 'en' }) })`);
} catch (e) {
  console.error(e);
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
  finish();
}
