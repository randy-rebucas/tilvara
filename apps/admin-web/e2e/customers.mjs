// End-to-end test of customers in the back office (session 20, ADR-0018): the overview tile, adding a
// customer with marketing consent and how it was given, finding them, correcting a detail, their
// purchases and store credit (a return given as credit at the till, through the API), withdrawing
// consent, the data download (audited), anonymising (refused while they hold credit), the guide part,
// the help button, Filipino and phone width.
// Usage: node apps/admin-web/e2e/customers.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `cus-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Nena', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const cola = (await call('POST', '/v1/products', tk, { name: 'Coke Mismo 290ml', taxCategoryId: vat, uomId: pc, trackInventory: false, variants: [{ sku: `CK-${slug}`, price: '22.40' }] }, idem())).variants[0].id;
const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9352 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const submitVisible = (label) => evaluate(`void [...document.querySelectorAll('form button.btn-primary')].find((x) => x.getClientRects().length && x.textContent.includes(${JSON.stringify(label)})).click()`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  check('the overview has a Customers tile', await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/customers' && a.innerText.includes('Customers'))`));
  check('the overview tiles still fit at 1440', await noHorizontalScroll());
  await shot('customers-overview-1440.png', false);
  await go('/customers');
  check('an empty list says how to start', await shown('No customers yet.'));
  check('the help button opens the Customers part', await evaluate(`document.querySelector('header a[href^="/help"]').getAttribute('href') === '/help#customers'`));

  // ---- add one, with consent asked at the counter ----
  await clickText('Add customer');
  await fill('displayName', 'Maria Santos');
  await fill('phone', '0917 123 4567');
  await fill('email', 'maria@example.ph');
  await fill('code', 'C-001');
  await fill('phone', 'call me');
  await submitVisible('Create');
  check('a phone that is not a phone number is refused in words', await shown('Use digits, spaces, +, ( ) or -', 8000));
  await fill('phone', '0917 123 4567');
  await evaluate(`void document.querySelector('input[name="marketingConsent"]').click()`);
  await waitFor(`document.querySelector('select[name="consentSource"]')`);
  await fill('consentSource', 'COUNTER');
  await submitVisible('Create');
  await waitFor(`/^\\/customers\\/[0-9a-f-]{36}$/.test(location.pathname)`, 10000);
  const id = await evaluate('location.pathname.split("/").pop()');
  check('the new customer opens, with consent on record', await shown('Maria Santos') && await shown('Agrees to offers and news since'));
  const api1 = await call('GET', `/v1/customers/${id}`, tk);
  check('the API agrees (email lower-cased, consent given)', api1.email === 'maria@example.ph' && api1.marketingConsent === true && api1.code === 'C-001');

  // ---- find and correct ----
  await go('/customers?q=0917');
  check('found by phone', await shown('Maria Santos'));
  await go(`/customers/${id}`);
  await clickText('Correct details');
  await fill('phone', '0918 765 4321');
  await submitVisible('Save');
  check('the corrected phone shows', await shown('0918 765 4321', 10000));

  // ---- a sale for her, one Coke returned as store credit (as the till does it) ----
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), customerId: id, lines: [{ variantId: cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '44.80' }] }, idem());
  await call('POST', `/v1/sales/${sale.id}/returns`, tk, { cashierSessionId: shift.id, kind: 'RETURN', reason: 'Wrong flavour', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }, idem());
  await go(`/customers/${id}`);
  check('the purchase is listed with its receipt reference', await shown('R1-000001'));
  check('store credit ₱22.40 shows, with its history', (await text()).includes('₱22.40') && (await text()).includes('Refund given as credit'));
  check('anonymising waits for the credit', (await text()).includes('still has store credit') && !(await evaluate(`[...document.querySelectorAll('button')].some((x) => x.textContent.includes('Remove personal details'))`)));
  await shot('customer-1440.png');
  await go(`/sales/${sale.id}`);
  check('the sale page links to the customer', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/customers/${id}')`));

  // ---- withdraw consent, download, anonymise ----
  await go(`/customers/${id}`);
  await fill('source', 'REQUEST');
  await clickText('Withdraw consent');
  check('consent withdrawn', await shown('Does not receive offers or news.', 10000));
  await evaluate(`window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return o.call(URL, b); }`);
  await clickText('Download their data');
  await waitFor(`window.__blobs.length > 0`, 10000);
  const dump = JSON.parse(await evaluate(`window.__blobs[0].text()`));
  check('the download holds the profile, consent history, purchases and credit', dump.customer.phone === '0918 765 4321' && dump.consentHistory.length === 2 && dump.purchases.length === 1 && dump.storeCredit.length === 1);
  const audit = await call('GET', `/v1/audit-logs?action=customer.exported`, tk);
  check('the download is in the audit log', audit.data.some((a) => a.resourceId === id));
  // She spends the credit at the till; then she can be forgotten.
  await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), customerId: id, lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'STORE_CREDIT', amount: '22.40' }] }, idem());
  await go(`/customers/${id}`);
  await clickText('Remove personal details');
  await fill('reason', 'The customer asked to be forgotten');
  await evaluate(`void [...document.querySelectorAll('form button')].find((x) => x.getClientRects().length && x.textContent.includes('Remove personal details')).click()`);
  check('anonymised: the name and details are gone, the purchases stay', await shown('Anonymised on', 10000) && (await text()).includes('Anonymised customer') && !(await text()).includes('0918') && (await text()).includes('R1-000001'));
  await go('/customers');
  check('the anonymised customer leaves the list', !(await text()).includes('Anonymised customer') && !(await text()).includes('Maria'));

  // ---- the guide, Filipino, phone ----
  await go('/help#customers');
  check('the guide has a Customers part', await shown('Keep the customers you need to know'));
  await go('/customers');
  await clickText('FIL');
  check('Filipino: the page is translated', await shown('Mga customer') && (await text()).includes('Maghanap ng customer'));
  await clickText('EN');
  await viewport(390, 844, true);
  await go(`/customers/${id}`);
  check('390px: no sideways scroll on a customer', await noHorizontalScroll());
  await shot('customer-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
