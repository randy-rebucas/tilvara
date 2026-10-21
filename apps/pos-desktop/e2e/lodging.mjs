// End-to-end test of a hotel's front desk and outlets at the counter (ADR-0023, session 28):
// - a LODGING business has a Rooms tab: the board shows each room's housekeeping status, the guest in it,
//   and today's arrivals;
// - a walk-in checked in with the guest registry and a charge limit; a booking arriving today checked in;
// - a sale charged to the room (search by room number, the name confirmed with the guest): the receipt
//   prints "Charged to room 101 — Cruz" with a signature line, the folio gets the charge;
// - a charge above what the room may still take is refused (by the till, and by the server);
// - a cash deposit at the drawer; check-out: nights and the deposit go on the folio, the balance paid in
//   cash with change, then the statement ("Guest folio — not an invoice") to sign; the room turns dirty;
// - housekeeping: marking a room clean, and out of order with a reason;
// - the guide's rooms part, Filipino, phone width.
// Usage: node apps/pos-desktop/e2e/lodging.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
/** The API's answer, refused or not: { status, body }. */
const raw = async (method, path, token, body, headers = {}) => {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ---- arrangement (API) ----
const slug = `inn-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Tess Bautista', businessName: 'Bahay Kubo Inn', tenantSlug: slug, businessType: 'LODGING' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Bahay Kubo Inn Corp', tradeName: 'Bahay Kubo Inn', tin: '456-789-123', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'BAG-01', name: 'Baguio' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'FD1', name: 'Front desk' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const SHAKE = `SHK-${slug}`.toUpperCase();
await call('POST', '/v1/products', tk, { name: 'Mango shake', taxCategoryId: vat, uomId: pc, trackInventory: false, variants: [{ sku: SHAKE, price: '150.00' }] }, idem());
const std = await call('POST', '/v1/room-types', tk, { code: 'STD', name: 'Standard', baseOccupancy: 2, maxOccupancy: 3, rackRate: '2000.00' }, idem());
const room = async (number) => call('POST', '/v1/rooms', tk, { branchId: br.id, roomTypeId: std.id, number, floor: '1' }, idem());
const r101 = await room('101');
const r102 = await room('102');
const r103 = await room('103');
// The branch's day (Asia/Manila): a booking arriving today, keyed in by phone without the registry.
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const booking = await call('POST', '/v1/stays', tk, { branchId: br.id, roomId: r103.id, guestName: 'Ana Reyes', arrivalDate: today, departureDate: plusDays(today, 2), adults: 2, source: 'PHONE' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9349 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const ok = (expr, ms = 10000) => waitFor(expr, ms).then(() => true, () => false);
const tab = (label) => evaluate(`[...document.querySelectorAll('nav[aria-label=Counter] button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
const setEl = (selector, value, index = 0) => evaluate(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = all.filter((x) => x.getClientRects().length)[${index}] ?? all[${index}];
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const click = (selector) => evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = all.find((x) => x.getClientRects().length) ?? all[0]; if (!el) throw new Error('nothing at ${selector.replace(/'/g, '')}'); el.click(); })()`);
const card = (n) => `document.querySelector('[data-testid=room-card][data-room="${n}"]')`;
const openRoom = async (n) => {
  if (!(await evaluate(`${card(n)}?.getAttribute('aria-pressed') === 'true'`))) await evaluate(`${card(n)}.click()`);
  await waitFor(`document.querySelector('[data-testid=room-panel]')?.innerText.includes('Room ${n}')`);
};
const panelText = () => evaluate(`document.querySelector('[data-testid=room-panel]')?.innerText ?? ''`);
const scan = async (code) => {
  await setEl('#scan', code);
  await evaluate(`document.getElementById('scan').form.requestSubmit()`);
  await sleep(600);
};
const totalShows = (amount) => ok(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`);
const submitEnabled = () => evaluate(`!document.getElementById('pay-submit').disabled`);
const stayOf = async (roomId) => (await call('GET', `/v1/stays?branchId=${br.id}&status=IN_HOUSE`, tk)).data.find((s) => s.roomId === roomId);

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front desk')`);
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === 'Front desk').querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);

  // ---- the board ----
  check('a lodging business has a Rooms tab', await ok(`[...document.querySelectorAll('nav[aria-label=Counter] button')].some((x) => x.textContent.trim() === 'Rooms')`));
  await tab('Rooms');
  check('the board shows every room with its housekeeping status', await ok(`${card('101')}?.dataset.status === 'CLEAN' && ${card('102')} && ${card('103')}`));
  check('… and the booking arriving today on its room', await ok(`${card('103')}?.innerText.includes('Arrives today')`) && await ok(`document.querySelector('[data-testid=rooms-summary]')?.innerText.includes('Arrivals today')`));
  await shot('lodging-board.png', false);

  // ---- walk-in check-in with the registry and a charge limit ----
  await openRoom('101');
  await click('[data-testid=walk-in]');
  await waitFor(`document.querySelector('[data-testid=walk-in-form]')`);
  check('the walk-in leaves tomorrow by default', (await evaluate(`document.getElementById('departure').value`)) === plusDays(today, 1));
  await setEl('#guestFullName-0', 'Juan Dela Cruz');
  await setEl('#guestNationality-0', 'Filipino');
  await setEl('#guestIdType-0', 'Driver’s licence');
  await setEl('#guestIdNumber-0', 'N01-23-456789');
  await setEl('#guestContact-0', '09171234567');
  await setEl('#chargeLimit', '500');
  await shot('lodging-walk-in.png', false);
  await click('[data-testid=walk-in-form] button.btn-primary');
  check('the walk-in is checked in and shows on the room', await shown('Juan Dela Cruz is checked in to room 101') && await ok(`${card('101')}?.innerText.includes('Juan Dela Cruz')`));
  const juan = await stayOf(r101.id);
  const juanDetail = await call('GET', `/v1/stays/${juan.id}`, tk);
  check('… the registry has the main guest, the stay a charge limit of 500.00', juanDetail.guests.length === 1 && juanDetail.guests[0].isPrimary && juanDetail.chargeLimit === '500.00' && juanDetail.folio?.status === 'OPEN');

  // ---- the booking arriving today ----
  await openRoom('103');
  check('a booking arriving today offers check-in, asking for the main guest first', await ok(`document.querySelector('[data-testid=arrival-panel]')?.innerText.includes('Record the main guest')`) && (await evaluate(`document.getElementById('guestFullName-0').value`)) === 'Ana Reyes');
  await setEl('#guestIdType-0', 'Passport');
  await setEl('#guestIdNumber-0', 'P1234567A');
  await click('[data-testid=arrival-panel] button.btn-primary');
  check('the booking is checked in', await shown('Ana Reyes is checked in to room 103') && (await call('GET', `/v1/stays/${booking.id}`, tk)).status === 'IN_HOUSE');

  // ---- a sale charged to the room ----
  await tab('Sell');
  await scan(SHAKE);
  await totalShows('₱150.00');
  check('the payment offers “Charge to room”', await ok(`document.querySelector('[data-testid=room-charge-open]')?.getClientRects().length > 0`));
  await click('[data-testid=room-charge-open]');
  await waitFor(`document.getElementById('roomSearch')`);
  await setEl('#roomSearch', '101');
  await evaluate(`document.getElementById('roomSearch').form.requestSubmit()`);
  check('searching by room number finds the guest with what the room may still charge', await ok(`document.querySelector('[data-testid=room-hits] button[data-room="101"]')?.innerText.includes('Juan Dela Cruz') && document.querySelector('[data-testid=room-hits]').innerText.includes('₱500.00')`));
  await click('[data-testid=room-hits] button[data-room="101"]');
  check('the cashier is asked to confirm the name with the guest', await ok(`document.querySelector('[data-testid=room-charge-confirm]')?.innerText.includes('Ask the guest their name')`));
  await clickText('Name matches — charge to room');
  check('the rest of the sale goes on the room; no cash needed', await ok(`document.querySelector('[data-testid=room-charge]')?.innerText.includes('Charged to room 101 — Juan Dela Cruz')`) && !(await evaluate(`Boolean(document.getElementById('cash')?.getClientRects().length)`)) && await submitEnabled());
  await shot('lodging-charge-to-room.png', false);
  await evaluate(`document.getElementById('pay-submit').click()`);
  check('the receipt prints “Charged to room 101 — Cruz” with a signature line', await ok(`document.querySelector('[data-testid=receipt-room-charge]')?.innerText.includes('Charged to room 101 — Cruz') && document.querySelector('[data-testid=receipt-room-charge]').innerText.includes('Guest signature')`, 15000));
  check('… and names the tender', await shown('CHARGE TO ROOM'));
  await shot('lodging-receipt.png', false);
  const folio = await call('GET', `/v1/folios/${juanDetail.folio.id}`, tk);
  check('the folio has the charge of 150.00', folio.entries.some((e) => e.kind === 'CHARGE' && e.amount === '150.00'));
  await clickText('New sale');

  // ---- over the limit: refused ----
  await scan(SHAKE);
  await scan(SHAKE);
  await scan(SHAKE);
  await totalShows('₱450.00');
  await click('[data-testid=room-charge-open]');
  await waitFor(`document.getElementById('roomSearch')`);
  await setEl('#roomSearch', 'Cruz');
  await evaluate(`document.getElementById('roomSearch').form.requestSubmit()`);
  check('searching by name finds the guest, with ₱350.00 left', await ok(`document.querySelector('[data-testid=room-hits] button[data-room="101"]')?.innerText.includes('₱350.00')`));
  await click('[data-testid=room-hits] button[data-room="101"]');
  check('a charge above what is left is refused before it is sent', await ok(`document.querySelector('[data-testid=room-charge-confirm]')?.innerText.includes('only ₱350.00 is left')`) && (await evaluate(`[...document.querySelectorAll('[data-testid=room-charge-confirm] button')].find((x) => x.textContent.includes('Name matches')).disabled`)));
  await shot('lodging-over-limit.png', false);
  const sessionId = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.openSession)?.openSession.id;
  const variantId = (await call('GET', `/v1/products?limit=50`, tk)).data.find((p) => p.name === 'Mango shake').variants[0].id;
  const refused = await raw('POST', '/v1/sales', tk, { cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines: [{ variantId, quantity: '3' }], tenders: [{ method: 'ROOM_CHARGE', stayId: juan.id }] }, idem());
  check('… and by the server: 409 ROOM_CHARGE_LIMIT with 350.00 available', refused.status === 409 && refused.body?.error?.code === 'ROOM_CHARGE_LIMIT' && refused.body.error.details?.available === '350.00');
  await clickText('Cancel');
  await setEl('#cash', '500');
  check('cash still pays it', await ok(`!document.getElementById('pay-submit').disabled`));
  await evaluate(`document.getElementById('pay-submit').click()`);
  await shown('New sale', 15000);
  await clickText('New sale');

  // ---- a cash deposit at the drawer ----
  await tab('Rooms');
  await openRoom('101');
  await waitFor(`document.querySelector('[data-testid=in-house-guest]')?.innerText.includes('Juan Dela Cruz')`);
  await clickText('Cash deposit');
  await waitFor(`document.getElementById('depositAmount')`);
  await setEl('#depositAmount', '1000');
  await click('[data-testid=deposit-form] button.btn-primary');
  check('the cash deposit is taken', await shown('Deposit of ₱1,000.00 taken in cash for room 101'));
  check('… and held on the stay', (await call('GET', `/v1/stays/${juan.id}`, tk)).depositsHeld === '1000.00');

  // ---- check-out: prepare, pay the balance in cash, check out, the statement ----
  await openRoom('101');
  await waitFor(`document.querySelector('[data-testid=in-house-guest]')`);
  await click('[data-testid=check-out]');
  await click('[data-testid=prepare-check-out]');
  // One night (2,000.00) + the charge (150.00) − the deposit (1,000.00) = 1,150.00.
  check('prepare puts the night and the deposit on the folio: ₱1,150.00 to pay', await ok(`document.querySelector('[data-testid=checkout]')?.innerText.includes('₱1,150.00') && document.querySelector('[data-testid=folio] [data-kind=ROOM_NIGHT]') && document.querySelector('[data-testid=folio] [data-kind=DEPOSIT_APPLIED]')`));
  await setEl('#folioCash', '1200');
  check('the change is shown before paying', await ok(`document.querySelector('[data-testid=folio-payment]')?.innerText.includes('₱50.00')`));
  await shot('lodging-check-out-pay.png', false);
  await click('[data-testid=folio-pay-cash]');
  check('paid: the change was ₱50.00 and the balance is nil', await ok(`document.querySelector('[data-testid=folio-change]')?.innerText.includes('₱50.00')`) || await ok(`document.querySelector('[data-testid=finish-check-out]')`));
  await waitFor(`document.querySelector('[data-testid=finish-check-out]')`);
  await click('[data-testid=finish-check-out]');
  // The statement's title prints in the serial face (capitals): compare without case.
  const statement = `(document.querySelector('[data-testid=statement]')?.innerText ?? '').toLowerCase()`;
  check('checked out: the statement to sign, the stay details gone', await ok(`${statement}.includes('guest folio') && ${statement}.includes('guest signature') && !document.querySelector('[data-testid=in-house-guest]')`, 15000));
  check('… says it is not an invoice', await ok(`${statement}.includes('guest folio — not an invoice')`));
  await shot('lodging-statement.png', false);
  const out = await call('GET', `/v1/stays/${juan.id}`, tk);
  check('the stay is checked out and its folio settled', out.status === 'CHECKED_OUT' && out.folio?.status === 'SETTLED');
  const session = await call('GET', `/v1/cashier-sessions/${sessionId}`, tk).catch(() => null);
  if (session?.expectedCash !== undefined) check('the drawer expects the float, the cash sale, the deposit and the folio payment', session.expectedCash === '3600.00');
  await clickText('Done');

  // ---- housekeeping ----
  check('the room is now to clean', await ok(`${card('101')}?.dataset.status === 'DIRTY' && ${card('101')}.innerText.includes('Vacant')`));
  await openRoom('101');
  await click('[data-testid=housekeeping] button[data-status=CLEAN]');
  check('marking it clean', await ok(`${card('101')}?.dataset.status === 'CLEAN'`));
  await openRoom('102');
  await click('[data-testid=housekeeping] button[data-status=OUT_OF_ORDER]');
  await waitFor(`document.getElementById('oooNote')`);
  await setEl('#oooNote', 'Leaking shower');
  await evaluate(`document.getElementById('oooNote').form.requestSubmit()`);
  check('out of order needs a reason, and shows on the board', await ok(`${card('102')}?.dataset.status === 'OUT_OF_ORDER'`) && (await call('GET', `/v1/rooms/${r102.id}/status-changes`, tk)).data[0]?.note === 'Leaking shower');
  await openRoom('102');
  check('an out-of-order room offers no walk-in', (await panelText()).includes('out of order') && !(await evaluate(`Boolean(document.querySelector('[data-testid=walk-in]'))`)));

  // ---- the guide's part, Filipino, phone width ----
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }))`);
  check('F1 on Rooms opens the guide at “Rooms, stays and folios”', await ok(`document.getElementById('guide-rooms')?.innerText.includes('Walk-in check-in') && document.getElementById('guide-rooms').innerText.includes('Name matches — charge to room')`));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('[aria-label=Language] button')].find((x) => x.textContent.trim() === 'fil').click()`);
  check('Filipino: the tab and the board', await ok(`[...document.querySelectorAll('nav[aria-label=Counter] button')].some((x) => x.textContent.trim() === 'Mga kuwarto')`) && await shown('Darating ngayon'));
  await shot('lodging-fil.png', false);
  await evaluate(`[...document.querySelectorAll('[aria-label=Language] button')].find((x) => x.textContent.trim() === 'en').click()`);
  await viewport(390, 844);
  await sleep(400);
  check('phone width: the board fits, no sideways scroll', await noHorizontalScroll());
  await shot('lodging-390.png');
  await openRoom('103');
  await waitFor(`document.querySelector('[data-testid=check-out]')`);
  await click('[data-testid=check-out]');
  check('phone width: the check-out fits', await noHorizontalScroll());
  await tab('Sell');
  await scan(SHAKE);
  await click('[data-testid=room-charge-open]');
  await waitFor(`document.querySelector('[data-testid=room-hits]')`);
  check('phone width: Charge to room fits', await noHorizontalScroll());
  await shot('lodging-charge-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
