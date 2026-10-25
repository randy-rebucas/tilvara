// End-to-end test of counter features the 2026-10-19 audit wired to API that had no screen:
// pay in / pay out on Close shift (expected cash moves) and a return for a sale of an earlier shift
// found by its receipt number.
// Usage: node apps/pos-desktop/e2e/counter-extras.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './api.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

// A VAT shop with one register (Front) and Iced tea at ₱45.
const call = client(API);
const slug = `ctr-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const tk = (await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lito Santos', businessName: 'Tindahan ni Lito', tenantSlug: slug, businessType: 'RETAIL' })).tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Lito Santos Trading', tradeName: 'Tindahan ni Lito', tin: '234-567-891', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const tea = (await call('POST', '/v1/products', tk, { name: 'Iced tea', taxCategoryId: vat, uomId: pc, trackInventory: false, variants: [{ sku: 'TEA-1', price: '45.00' }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const register = (await call('GET', '/v1/registers', tk)).data[0];
// Yesterday's shift (as far as the till knows): three teas sold on sale #1, then closed.
const earlier = await call('POST', '/v1/cashier-sessions', tk, { registerId: register.id, openingFloat: '500.00' });
const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: earlier.id, clientTransactionId: randomUUID(), lines: [{ variantId: tea, quantity: '3' }], tenders: [{ method: 'CASH', tendered: '135.00' }] }, { 'idempotency-key': randomUUID() });
await call('POST', `/v1/cashier-sessions/${earlier.id}/close`, tk, { countedCash: '635.00' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9342 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const tab = (label) => evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
const shiftView = async (id) => call('GET', `/v1/cashier-sessions/${id}`, tk);

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front')`);
  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  const shiftId = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.register.id === register.id).openSession.id;

  // ---- pay in / pay out ----
  await tab('Close shift');
  check('Close shift offers pay in / pay out', await shown('Pay in / pay out'));
  await fill('pioType', 'PAY_OUT');
  await fill('pioAmount', '150');
  await fill('pioReason', 'Ice delivery');
  await clickText('Record');
  check('the pay-out is listed', await shown('Ice delivery', 10000));
  await fill('pioType', 'PAY_IN');
  await fill('pioAmount', '200');
  await fill('pioReason', 'Change fund top-up');
  await clickText('Record');
  check('the pay-in is listed', await shown('Change fund top-up', 10000));
  const v = await shiftView(shiftId);
  check('the server agrees: expected cash 1000 − 150 + 200 = 1050', v.expectedCash === '1050.00' && v.payInOut.length === 2);
  check('the screen shows the new expected cash', await shown('₱1,050.00'));
  await fill('pioAmount', 'abc');
  await fill('pioReason', 'x');
  await clickText('Record');
  check('an amount that is not money is refused on the spot', (await shiftView(shiftId)).payInOut.length === 2);
  await shot('pay-in-out.png', false);

  // ---- a return for a sale of the earlier shift ----
  await tab('This shift');
  check('This shift offers to find an earlier sale', await shown('Find an earlier sale'));
  await fill('findNumber', '999');
  await clickText('Find');
  check('an unknown number says so', await shown('No sale with that number on that register.'));
  await fill('findNumber', String(sale.saleNumber));
  await clickText('Find');
  check('the earlier sale opens with its receipt', await shown('Iced tea', 10000) && (await text()).includes('R1-000001'));
  await clickText('Return items');
  await waitFor(`[...document.querySelectorAll('input')].some((i) => i.name.startsWith('qty-'))`);
  await evaluate(`(() => { const el = [...document.querySelectorAll('input')].find((i) => i.name.startsWith('qty-')); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '1'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill('reason', 'Too sweet');
  await evaluate(`[...document.querySelectorAll('form .btn-primary')].find((x) => x.getClientRects().length && x.textContent.includes('Return items')).click()`);
  check('refunded from today’s drawer', await shown('Refund ₱45.00 in cash', 10000));
  check('the server agrees: one return on the old sale, cash out of this shift', (await call('GET', `/v1/sales/${sale.id}`, tk)).lines[0].returnedQuantity === '1' && (await shiftView(shiftId)).expectedCash === '1005.00');
  await shot('earlier-sale-return.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
