// End-to-end test of the screens the 2026-10-19 audit added over API that had none:
// supplier invoices and payments (enter against goods receipts, pay part, pay the rest, cancel,
// aging tied to the books, journal labels and links), stock adjustments and waste, and editing the
// details receipts print (entity trade name/address/RDO, branch address, register name).
// Usage: node apps/admin-web/e2e/payables.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API): a VAT shop with two deliveries from one supplier ----
const slug = `ap-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const cola = (await call('POST', '/v1/products', tk, { name: 'Coke Mismo 290ml', taxCategoryId: vat, uomId: pc, variants: [{ sku: `CK-${slug}`, price: '22.00' }] }, idem())).variants[0].id;
const sup = await call('POST', '/v1/suppliers', tk, { code: 'COKE', name: 'Coca-Cola Beverages', paymentTermsDays: 30 }, idem());
const receive = (qty, cost) => call('POST', '/v1/goods-receipts', tk, { branchId: br.id, supplierId: sup.id, supplierInvoiceRef: 'SI-778', lines: [{ variantId: cola, quantity: qty, unitCost: cost }] }, idem());
await receive('24', '12.00'); // ₱288.00
await receive('12', '12.50'); // ₱150.00

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9356 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const submitVisible = (label) => evaluate(`[...document.querySelectorAll('form button')].filter((x) => x.getClientRects().length && x.textContent.trim() === ${JSON.stringify(label)}).at(-1).click()`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  // ---- supplier invoices ----
  await go('/purchasing');
  check('Purchasing links to supplier invoices and payments', await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/purchasing/invoices')`));
  await go('/purchasing/invoices');
  check('invoices page: nothing yet, nothing owed', await shown('No supplier invoices yet.') && (await text()).includes('Nothing is owed to suppliers.'));
  check('the help button opens the Purchasing part of the guide', await evaluate(`document.querySelector('header a[href^="/help"]').getAttribute('href') === '/help#purchasing'`));
  await fill('branch', br.id);
  await fill('supplier', sup.id);
  await clickText('Find receipts');
  await waitFor(`location.search.includes('supplier=')`);
  await clickText('Enter a supplier invoice');
  await waitFor(`document.querySelector('input[name="invoiceNumber"]')`);
  check('both uninvoiced receipts are offered with what they hold', /₱288\.00/.test(await text()) && /₱150\.00/.test(await text()));
  // Tick both receipts.
  await evaluate(`[...document.querySelectorAll('fieldset input[type=checkbox]')].forEach((c) => { if (!c.checked) c.click(); })`);
  check('the ticked receipts add up exactly', await shown('Goods received on the ticked receipts: ₱438.00'));
  await fill('invoiceNumber', 'SI-778');
  await fill('netAmount', '440.00');
  await fill('vatAmount', '52.80');
  await submitVisible('Record invoice');
  await waitFor(`/^\\/purchasing\\/invoices\\/[0-9a-f-]{36}$/.test(location.pathname)`, 15000);
  const invoiceId = await evaluate('location.pathname.split("/").at(-1)');
  const page1 = await text();
  check('the invoice page shows total, input VAT and the price difference', page1.includes('₱492.80') && page1.includes('₱52.80') && page1.includes('₱2.00') && page1.includes('Supplier invoice SI-778'));
  // Status tags and section titles are upper-cased by CSS: innerText reads them upper-cased.
  check('it is open and still owed in full', /Still owed\s*₱492\.80/.test(page1) && /· OPEN\b/.test(page1));
  await shot('ap-invoice.png');

  // Pay part, then the rest.
  await clickText('Record a payment');
  await waitFor(`document.querySelector('input[name="amount"]')`);
  check('the payment form starts at the open balance', await evaluate(`document.querySelector('input[name="amount"]').value === '492.80'`));
  await fill('amount', '200.00');
  await fill('method', 'CHECK');
  await fill('reference', 'BDO 000123');
  await submitVisible('Record a payment');
  check('a part payment leaves the rest owed', await shown('₱292.80', 10000) && (await text()).includes('BDO 000123'));
  const cancelOffered = await evaluate(`[...document.querySelectorAll('main button')].some((x) => x.textContent.includes('Cancel invoice'))`);
  check('a part-paid invoice offers no cancel', !cancelOffered);
  await clickText('Record a payment');
  await waitFor(`document.querySelector('input[name="amount"]')`);
  await submitVisible('Record a payment');
  const paidOff = await waitFor(`/Still owed\\s*₱0\\.00/.test(document.body.innerText)`, 10000).then(() => true, () => false);
  check('paying the rest marks it paid', paidOff && /· PAID\b/.test(await text()));
  const apiInv = await call('GET', `/v1/supplier-invoices/${invoiceId}`, tk);
  check('the API agrees: paid in two payments', apiInv.status === 'PAID' && apiInv.payments.length === 2 && apiInv.balance === '0.00');

  // The journal names and links both kinds of entry.
  await go(`/books?entity=${le.id}&type=SUPPLIER_INVOICE`);
  check('journal: the supplier invoice entry is labelled and filterable', await shown('Supplier invoice') && await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/purchasing/invoices/${invoiceId}')`));
  await go(`/books?entity=${le.id}&type=SUPPLIER_PAYMENT`);
  const payLink = await evaluate(`[...document.querySelectorAll('main a')].find((a) => (a.getAttribute('href') ?? '').startsWith('/purchasing/payments/') && a.getClientRects().length)?.getAttribute('href') ?? null`);
  check('journal: payment entries are labelled and link to their payment', (await text()).includes('Supplier payment') && !!payLink);
  await go(payLink);
  check('a payment link opens the payment, which links the invoice it settles', await waitFor(`document.body.innerText.toLowerCase().includes('invoices this payment settles')`).then(() => true, () => false) && await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/purchasing/invoices/${invoiceId}')`));
  await go(`/books?entity=${le.id}`);
  check('Books links to supplier invoices (accountants have no Purchasing tab)', await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.getAttribute('href') === '/purchasing/invoices?entity=${le.id}')`));

  // A second invoice to cancel, and the aging.
  const r3 = await receive('6', '10.00');
  const inv2 = await call('POST', '/v1/supplier-invoices', tk, { supplierId: sup.id, invoiceNumber: 'SI-801', invoiceDate: apiInv.invoiceDate, goodsReceiptIds: [r3.id], netAmount: '60.00', vatAmount: '7.20' }, idem());
  await go(`/purchasing/invoices?entity=${le.id}`);
  const aging = await evaluate(`[...document.querySelectorAll('section')].find((s) => s.innerText.toLowerCase().includes('what you owe, by age'))?.innerText ?? ''`);
  check('aging: the open invoice is not yet due, and the books agree', /Coca-Cola Beverages/.test(aging) && aging.includes('₱67.20') && aging.includes('Accounts payable in the books: ₱67.20'));
  await clickText('Paid');
  await waitFor(`location.search.includes('status=PAID')`);
  check('status filter: Paid lists only the paid invoice', (await text()).includes('SI-778') && !(await text()).includes('SI-801'));
  await shot('ap-list.png');
  await go(`/purchasing/invoices/${inv2.id}`);
  await clickText('Cancel invoice');
  await waitFor(`document.querySelector('input[name="reason"]')`);
  await fill('reason', 'Billed the wrong branch');
  await submitVisible('Cancel invoice');
  check('cancelling an unpaid invoice shows why, with its reversal entry', await shown('Billed the wrong branch', 10000) && (await text()).includes('Reversal entry'));
  const r = await fetch(`${API}/v1/journal-entries/${apiInv.journalEntryId}/reverse`, { method: 'POST', headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ memo: 'by hand' }) });
  check('an invoice entry cannot be reversed by hand', r.status === 422 && (await r.json()).error.code === 'CANCEL_THE_DOCUMENT');

  // ---- session 22: a credit note after a return, one payment for several invoices, a void ----
  const r4 = await receive('10', '10.00');
  const r5 = await receive('5', '10.00');
  const inv3 = await call('POST', '/v1/supplier-invoices', tk, { supplierId: sup.id, invoiceNumber: 'SI-900', invoiceDate: apiInv.invoiceDate, goodsReceiptIds: [r4.id], netAmount: '100.00', vatAmount: '12.00' }, idem());
  const inv4 = await call('POST', '/v1/supplier-invoices', tk, { supplierId: sup.id, invoiceNumber: 'SI-901', invoiceDate: apiInv.invoiceDate, goodsReceiptIds: [r5.id], netAmount: '50.00', vatAmount: '6.00' }, idem());
  await call('POST', '/v1/supplier-returns', tk, { branchId: br.id, supplierId: sup.id, goodsReceiptId: r4.id, reason: 'Leaking', lines: [{ goodsReceiptLineId: r4.lines[0].id, variantId: cola, quantity: '1' }] }, idem());
  await go(`/purchasing/invoices/${inv3.id}`);
  await clickText('Record a credit or debit note');
  await waitFor(`document.querySelector('input[name="noteNumber"]')`);
  await fill('noteNumber', 'CM-55');
  await fill('netAmount', '10.00');
  await fill('vatAmount', '1.20');
  await fill('reason', 'One leaking case returned');
  await submitVisible('Record note');
  check('a credit note lowers what is owed and clears the returned goods', await shown('CM-55', 10000) && /Still owed\s*₱100\.80/.test(await text()) && (await text()).includes('One leaking case returned'));
  check('an invoice with a note offers no cancel', !(await evaluate(`[...document.querySelectorAll('main button')].some((x) => x.textContent.includes('Cancel invoice'))`)));
  await shot('ap-note.png');
  const noteInv = await call('GET', `/v1/supplier-invoices/${inv3.id}`, tk);
  check('the API agrees: the note cleared ₱10.00 of returned goods', noteInv.adjustments.length === 1 && noteInv.adjustments[0].grniCleared === '10.00' && noteInv.balance === '100.80');
  await go(`/books?entity=${le.id}&type=SUPPLIER_NOTE`);
  check('journal: the note entry is labelled and links back', await shown('Supplier credit/debit note') && await evaluate(`[...document.querySelectorAll('main a')].some((a) => (a.getAttribute('href') ?? '') === '/purchasing/notes/${noteInv.adjustments[0].id}')`));

  await go(`/purchasing/invoices?entity=${le.id}`);
  await fill('pay', sup.id);
  await clickText('Show open invoices');
  await waitFor(`location.search.includes('pay=')`);
  await waitFor(`document.body.innerText.includes('SI-901')`);
  // "Still owed" fills each line with its balance.
  await evaluate(`[...document.querySelectorAll('form button')].filter((x) => x.getClientRects().length && x.textContent.trim() === 'Still owed').forEach((x) => x.click())`);
  check('the payment adds up both open balances', await shown('Payment total: ₱156.80'));
  await fill('reference', 'BDO 000777');
  await submitVisible('Record the payment');
  await waitFor(`location.pathname.startsWith('/purchasing/payments/')`, 15000).catch(() => undefined);
  const settles = await text();
  check('one payment settles both invoices', settles.includes('SI-900') && settles.includes('SI-901') && settles.includes('₱156.80'));
  await shot('ap-payment.png');
  await clickText('Void payment');
  await waitFor(`document.querySelector('input[name="reason"]')`);
  await fill('reason', 'Check bounced');
  await submitVisible('Void payment');
  check('voiding shows why, with its reversal entry', await shown('Check bounced', 10000) && (await text()).includes('Reversal entry'));
  const reopened = await Promise.all([inv3.id, inv4.id].map((id) => call('GET', `/v1/supplier-invoices/${id}`, tk)));
  check('both invoices are owed again', reopened.every((x) => x.status === 'OPEN') && reopened[0].balance === '100.80' && reopened[1].balance === '56.00');

  // ---- stock adjustment and waste ----
  await go(`/inventory?branch=${br.id}`);
  await clickText('Adjust stock or record waste');
  await waitFor(`document.querySelector('select[name="kind"]')`);
  await fill('kind', 'WASTE');
  await fill('reason', 'Dented cans');
  await fill('lines.0.variantId', cola);
  await fill('lines.0.quantity', '2');
  await submitVisible('Post');
  await waitFor(`location.pathname.startsWith('/inventory/adjustments/')`, 15000).catch(() => undefined);
  check('waste posts a document (entered as a positive quantity)', await evaluate(`location.pathname.startsWith('/inventory/adjustments/')`) && (await text()).includes('Dented cans'));
  const bal = (await call('GET', `/v1/reports/inventory-valuation?branchId=${br.id}`, tk)).data.find((x) => x.variantId === cola);
  check('stock went down by the waste: 24 + 12 + 6 + 10 + 5 − 1 returned − 2 = 54', Number(bal.quantity) === 54);

  // ---- details printed on receipts ----
  await go(`/locations/entities/${le.id}`);
  await clickText('Edit details');
  await waitFor(`document.querySelector('input[name="tradeName"]')`);
  await fill('tradeName', 'Tindahan ni Nena');
  await fill('registeredAddress', '12 Aurora Blvd, Cubao, Quezon City');
  await fill('rdoCode', '039');
  await submitVisible('Save');
  check('entity details saved and shown', await shown('12 Aurora Blvd, Cubao, Quezon City', 10000) && (await text()).includes('039'));
  await go('/locations');
  await evaluate(`[...document.querySelectorAll('li')].find((li) => li.innerText.includes('CUB-01')).querySelector('button').click()`);
  await waitFor(`document.querySelector('input[name="address"]')`);
  await fill('address', '12 Aurora Blvd, Cubao');
  await submitVisible('Save');
  check('branch address saved and shown on its card', await shown('12 Aurora Blvd, Cubao', 10000));
  // A receipt now prints them.
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' });
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '22.00' }] }, idem());
  const receipt = await call('GET', `/v1/sales/${sale.id}/receipt`, tk);
  // The receipt prints the branch's address, else the entity's registered one.
  check('the receipt carries the trade name and the branch address', receipt.seller.name === 'Tindahan ni Nena' && receipt.seller.address === '12 Aurora Blvd, Cubao');

  // Phone and Filipino.
  await viewport(390, 844, true);
  await go(`/purchasing/invoices/${invoiceId}`);
  check('390px: no sideways scroll on an invoice', await noHorizontalScroll());
  await go(`/purchasing/invoices?entity=${le.id}`);
  check('390px: no sideways scroll on the invoice list', await noHorizontalScroll());
  await shot('ap-list-390.png', false);
  await viewport(1440, 900);
  await clickText('FIL');
  check('Filipino: the invoices page is translated', await shown('Mga invoice ng supplier') && (await text()).toLowerCase().includes('utang sa supplier, ayon sa tagal'));
  await clickText('EN');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
