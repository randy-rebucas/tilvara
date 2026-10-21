// End-to-end test of a hotel, resort or transient house (ADR-0023) in the back office: the sign-up
// offers "Hotel, resort or transient house"; the band has Lodging (and Restaurant: a resort's outlets);
// set-up adds a room type with its rack rate, rooms, an out-of-order block and the branch's settings
// (night audit time, accommodation tax with its "unverified" note); a booking is made from a free night
// of the rooms-by-night grid with a customer and a bank-transfer deposit; a second booking of the same
// room and night is refused; check-in records the primary guest in the registry and the registration
// card prints; the night audit charges the due night (with the accommodation tax); the folio takes an
// adjustment and a night reversal; check-out charges the rest and applies the deposit, the till takes
// the balance (through the API, as the front desk drawer does), and check-out sets the room to clean;
// housekeeping marks it clean and another room out of order; the folio statement says it is not an
// invoice; the shift shows the front desk collections; the occupancy, guest ledger and accommodation
// tax reports and their CSV; the customer's stays; the guide's part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/lodging.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));
const yesterday = day(-1);
const today = day(0);
const tomorrow = day(1);
// Last night is due once the branch's clock passes 03:00 today (the default night audit time).
const manilaHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hour12: false }).format(new Date()));
const lastNightDue = manilaHour >= 3;

const slug = `hotel-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Rosa Villanueva', businessName: 'Casa Rosa Inn', tenantSlug: slug, businessType: 'LODGING' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Rosa Villanueva Hospitality', tradeName: 'Casa Rosa Inn', tin: '345-678-901', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'BOR-01', name: 'Boracay' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'FD1', name: 'Front desk' });
const tag = slug.slice(-5).toUpperCase();
const customer = await call('POST', '/v1/customers', tk, { displayName: 'Maria Santos', email: `maria-${tag.toLowerCase()}@example.ph`, phone: '0917 555 0102' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9371 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const shownAnyCase = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const clickButton = (label) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!el) throw new Error('no button ${label}');
  el.click();
})()`);
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary') ?? undefined);
})()`);
const pesos = (v) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

try {
  await viewport(1440, 900);
  // ---- sign-up offers the lodging type ----
  await go('/sign-up');
  check('sign-up offers “Hotel, resort or transient house”', await evaluate(`Boolean(document.querySelector('input[name=businessType][value=LODGING]'))`) && (await text()).includes('Hotel, resort or transient house'));

  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  const tabs = await evaluate(`[...document.querySelectorAll('header nav a')].map((a) => a.textContent.trim())`);
  check('a hotel has the Lodging tab (and Restaurant), and no Appointments', tabs.includes('Lodging') && tabs.includes('Restaurant') && !tabs.includes('Appointments'));
  check('the band still fits at 1440px', await noHorizontalScroll());

  // ---- set-up: a room type, rooms, settings, an out-of-order block ----
  await go(`/lodging/setup?branch=${br.id}`);
  check('Set-up has the unverified accommodation tax note', await shown('Unverified', 8000));
  await clickButton('Add a room type');
  await waitFor(`document.querySelector('[name="typeCode"]')`);
  await fill('typeCode', 'STD');
  await fill('typeName', 'Standard');
  await fill('baseOccupancy', '2');
  await fill('maxOccupancy', '3');
  await fill('rackRate', '2500.00');
  await submitFormOf('typeCode');
  await shown('ROOM-STD', 10000);
  const types = (await call('GET', '/v1/room-types', tk)).data;
  const std = types.find((x) => x.code === 'STD');
  check('the API has the room type with its room-night item ROOM-STD', Boolean(std) && std.nightItem?.sku === 'ROOM-STD' && std.maxOccupancy === 3);
  await clickButton('Add a room');
  await waitFor(`document.querySelector('[name="roomNumber"]')`);
  for (const n of ['101', '102']) {
    await fill('roomNumber', n);
    await fill('roomTypeId', std.id);
    await submitFormOf('roomNumber');
    await waitFor(`document.querySelector('[data-room-row="${n}"]')`, 10000);
  }
  const rooms = (await call('GET', `/v1/rooms?branchId=${br.id}`, tk)).data;
  const r101 = rooms.find((r) => r.number === '101');
  const r102 = rooms.find((r) => r.number === '102');
  check('two rooms are listed and in the API, clean', rooms.length === 2 && rooms.every((r) => r.housekeepingStatus === 'CLEAN'));
  await fill('taxPercent', '5');
  await fill('nightAuditTime', '03:00');
  await submitFormOf('taxPercent');
  await shown('Saved.', 8000);
  const settings = await call('GET', `/v1/branches/${br.id}/lodging-settings`, tk);
  check('the branch settings are saved: 5 % accommodation tax, 03:00', settings.accommodationTaxRate === '0.05' && settings.nightAuditTime === '03:00');
  await clickButton('Take a room out of order');
  await waitFor(`document.querySelector('[name="blockReason"]')`);
  await fill('blockRoom', r102.id);
  await fill('startsOn', day(5));
  await fill('endsOn', day(7));
  await fill('blockReason', 'Aircon repair');
  await submitFormOf('blockReason');
  check('the out-of-order block is listed', await shown('Aircon repair', 8000));
  await shot('lodging-setup.png');

  // ---- book from a free night of the grid: a customer, two nights from yesterday, a deposit ----
  await go(`/lodging/calendar?branch=${br.id}&from=${yesterday}`);
  check('the grid has a row per room', await evaluate(`Boolean(document.querySelector('[data-room="101"]')) && Boolean(document.querySelector('[data-room="102"]'))`));
  check('the block shades room 102’s dates', await evaluate(`Boolean(document.querySelector('[data-room="102"] [data-block]'))`));
  await evaluate(`document.querySelector('[data-room="101"] a[data-night="${yesterday}"]').click()`);
  await waitFor(`location.pathname === '/lodging/new'`, 10000);
  await waitFor(`document.querySelector('[name="departureDate"]')`);
  check('the free night fills room 101 and the date', await evaluate(`document.querySelector('[name="roomId"]').value === ${JSON.stringify(r101.id)} && document.querySelector('[name="arrivalDate"]').value === ${JSON.stringify(yesterday)}`));
  await fill('departureDate', tomorrow);
  check('the free rooms for the nights are suggested', await waitFor(`document.querySelector('[data-testid=free-rooms] [data-free-room="101"]')`, 8000).then(() => true, () => false));
  await fill('customerSearch', 'Maria');
  await waitFor(`document.querySelector('button[data-customer]')`, 8000);
  await evaluate(`document.querySelector('button[data-customer]').click()`);
  await waitFor(`document.querySelector('[data-testid=picked-customer]')`);
  await fill('adults', '2');
  await fill('source', 'PHONE');
  await fill('depositAmount', '2000.00');
  await fill('depositReference', 'BDO-778812');
  await shot('lodging-booking.png');
  await clickButton('Book');
  await waitFor(`/^\\/lodging\\/stays\\/[0-9a-f-]{36}$/.test(location.pathname)`, 12000);
  const stayId = await evaluate(`location.pathname.split('/').pop()`);
  let stay = await call('GET', `/v1/stays/${stayId}`, tk);
  check('the stay is booked for the customer, 2 nights, deposit 2,000.00 held', stay.status === 'BOOKED' && stay.customerId === customer.id && stay.arrivalDate === yesterday && stay.departureDate === tomorrow && stay.depositsHeld === '2000.00');
  check('the stay page shows the deposit held', await shown(pesos('2000'), 8000));

  // ---- the same room and night again: refused ----
  await go(`/lodging/new?branch=${br.id}&room=${r101.id}&arrival=${today}`);
  await waitFor(`document.querySelector('[name="guestName"]')`);
  await fill('guestName', 'Ben Cruz');
  await fill('departureDate', day(2));
  check('room 101 is marked taken for those nights', await waitFor(`[...document.querySelectorAll('select[name=roomId] option')].some((o) => o.value === ${JSON.stringify(r101.id)} && o.textContent.includes('taken'))`, 8000).then(() => true, () => false));
  await clickButton('Book');
  check('a double booking is refused with the API’s reason', await shown('already booked', 8000));
  check('and no second stay was made', (await call('GET', `/v1/stays?branchId=${br.id}`, tk)).data.length === 1);
  await shot('lodging-double-booking.png', false);

  // ---- check-in with the guest registry ----
  await go(`/lodging/stays/${stayId}`);
  await clickButton('Check in');
  check('check-in asks for the primary guest first', await shown('Record the primary guest', 8000));
  await clickButton('Cancel');
  await clickButton('Add a guest');
  await waitFor(`document.querySelector('[name="guest-fullName"]')`);
  await fill('guest-fullName', 'Maria Santos');
  await fill('guest-nationality', 'Filipino');
  await fill('guest-idType', 'Passport');
  await fill('guest-idNumber', 'P1234567A');
  await submitFormOf('guest-fullName');
  check('the guest is in the registry as primary', await waitFor(`document.querySelector('[data-testid=registry]')?.innerText.includes('Primary guest')`, 8000).then(() => true, () => false));
  await clickButton('Check in');
  await waitFor(`[...document.querySelectorAll('form button.btn-primary')].some((x) => x.textContent.trim() === 'Check in')`);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.textContent.trim() === 'Check in').click()`);
  await waitFor(`document.querySelector('h1 [data-stay-status="IN_HOUSE"]')`, 10000);
  stay = await call('GET', `/v1/stays/${stayId}`, tk);
  check('the guest is in house and the folio is open', stay.status === 'IN_HOUSE' && stay.folio?.status === 'OPEN');
  await go(`/lodging/stays/${stayId}/card`);
  check('the registration card prints the guest and ID', await shown('Registration card', 8000) && (await text()).includes('P1234567A') && (await text()).includes('I confirm that the details above are correct.'));
  await shot('lodging-registration-card.png');

  // ---- the night audit charges last night ----
  await go(`/lodging?branch=${br.id}`);
  check('the front desk lists the guest in house, leaving tomorrow', await shown('Maria Santos', 8000) && (await text()).includes('In house'));
  await clickButton('Run the night audit now');
  await waitFor(`document.querySelector('[data-testid=night-audit-result]')`, 10000);
  const auditText = await evaluate(`document.querySelector('[data-testid=night-audit-result]').textContent`);
  check(`the night audit says what it charged (${lastNightDue ? '1 night' : 'none yet'})`, lastNightDue ? auditText.includes('1 nights charged') : auditText.includes('No nights'));
  await shot('lodging-front-desk.png');
  let folio = await call('GET', `/v1/folios/${stay.folio.id}`, tk);
  const night = folio.entries.find((e) => e.kind === 'ROOM_NIGHT');
  const accTax = folio.entries.find((e) => e.kind === 'ACCOMMODATION_TAX');
  check('the folio has last night at the rack rate and its accommodation tax', !lastNightDue || (night?.amount === '2500.00' && night.nightDate === yesterday && Boolean(accTax) && accTax.amount !== '0.00'));

  // ---- the folio: a night reversal and an adjustment ----
  await go(`/lodging/stays/${stayId}`);
  // A night charged by mistake first (a credit beyond what is owed would leave the folio owing the guest).
  if (lastNightDue) {
    await clickButton('Reverse');
    await waitFor(`document.querySelector('[name="reason"]')`);
    await fill('reason', 'Charged by mistake');
    await submitFormOf('reason');
    check('the night shows as reversed', await shownAnyCase('Reversed', 8000));
    folio = await call('GET', `/v1/folios/${stay.folio.id}`, tk);
    check('the API has the reversal of the night and of its tax', folio.entries.filter((e) => e.kind === 'NIGHT_REVERSAL').length === (accTax ? 2 : 1));
  }
  await clickButton('Add an adjustment');
  await waitFor(`document.querySelector('[name="adjAmount"]')`);
  await fill('adjAmount', '150.00');
  await fill('adjDescription', 'Late check-out');
  await fill('adjReason', 'Left at 3 p.m.');
  await submitFormOf('adjAmount');
  check('the adjustment is on the folio', await shown('Late check-out', 8000));
  folio = await call('GET', `/v1/folios/${stay.folio.id}`, tk);
  check('the API has the fee of 150.00', folio.entries.some((e) => e.kind === 'ADJUSTMENT' && e.amount === '150.00' && e.reason === 'Left at 3 p.m.'));
  await shot('lodging-folio.png');

  // ---- check-out: nights and deposit, the till takes the balance, then check out ----
  await clickButton('Charge the nights and apply deposits');
  check('preparing check-out gives the balance to pay', await waitFor(`document.querySelector('[data-testid=prepared]')`, 10000).then(() => true, () => false));
  folio = await call('GET', `/v1/folios/${stay.folio.id}`, tk);
  check('the deposit is applied to the folio', folio.entries.some((e) => e.kind === 'DEPOSIT_APPLIED' && e.amount === '-2000.00') && folio.depositsHeld === '0.00');
  check('Check out waits while the folio has a balance', await evaluate(`[...document.querySelectorAll('[data-testid=check-out] button')].find((x) => x.textContent.trim() === 'Check out').disabled`));
  // The front desk takes the rest at its drawer (the till), as a guest pays at check-out.
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
  await call('POST', `/v1/folios/${folio.id}/payments`, tk, { method: 'CASH', cashierSessionId: shift.id, tendered: folio.balance }, idem());
  await go(`/lodging/stays/${stayId}`);
  check('the folio is at ₱0.00 after the payment', await evaluate(`document.querySelector('[data-testid=folio-balance]')?.textContent === '₱0.00'`));
  await evaluate(`[...document.querySelectorAll('[data-testid=check-out] button')].find((x) => x.textContent.trim() === 'Check out').click()`);
  await waitFor(`document.querySelector('h1 [data-stay-status="CHECKED_OUT"]')`, 10000);
  stay = await call('GET', `/v1/stays/${stayId}`, tk);
  const room101 = (await call('GET', `/v1/rooms/${r101.id}`, tk));
  check('checked out, folio settled, room 101 to clean', stay.status === 'CHECKED_OUT' && stay.folio.status === 'SETTLED' && room101.housekeepingStatus === 'DIRTY');
  await go(`/lodging/folios/${stay.folio.id}/statement`);
  check('the folio statement says it is not an invoice, at ₱0.00', await shown('Guest folio — not an invoice', 8000) && (await evaluate(`document.querySelector('[data-testid=statement-balance]').textContent`)) === '₱0.00');
  await shot('lodging-statement.png');
  await go(`/shifts/${shift.id}`);
  check('the shift lists the front desk collections apart from sales', await shownAnyCase('Front desk collections', 8000) && (await text()).includes('Folio payments') && (await text()).includes('Guest folio payments'));

  // ---- housekeeping ----
  await go(`/lodging/housekeeping?branch=${br.id}`);
  check('the housekeeping board shows room 101 to clean', await waitFor(`document.querySelector('[data-room="101"] [data-room-status="DIRTY"]')`, 8000).then(() => true, () => false));
  await evaluate(`document.querySelector('[data-room-actions="101"] [data-set="CLEAN"]').click()`);
  await waitFor(`document.querySelector('[data-room="101"] [data-room-status="CLEAN"]')`, 8000);
  await evaluate(`document.querySelector('[data-room-actions="102"] [data-set="OUT_OF_ORDER"]').click()`);
  await waitFor(`document.querySelector('[name="note"]')`);
  await fill('note', 'Leaking shower');
  await submitFormOf('note');
  await waitFor(`document.querySelector('[data-room="102"] [data-room-status="OUT_OF_ORDER"]')`, 8000);
  const changes = (await call('GET', `/v1/rooms/${r102.id}/status-changes`, tk)).data;
  check('housekeeping: 101 clean, 102 out of order with the note, and who did it', (await call('GET', `/v1/rooms/${r101.id}`, tk)).housekeepingStatus === 'CLEAN' && changes[0]?.toStatus === 'OUT_OF_ORDER' && changes[0].note === 'Leaking shower' && (await text()).includes('Rosa Villanueva'));
  await shot('lodging-housekeeping.png');

  // ---- reports and their CSV ----
  await go(`/reports/occupancy?branch=${br.id}&from=${yesterday}&to=${today}`);
  const occ = await call('GET', `/v1/reports/occupancy?branchId=${br.id}&from=${yesterday}&to=${today}`, tk);
  check('Reports → Lodging → Occupancy shows the API’s figures', await shownAnyCase('Rooms available', 8000) && (await text()).includes(pesos(occ.totals.roomRevenueExVat)));
  const occCsv = await evaluate(`fetch('/reports/export?report=occupancy&branch=${br.id}&from=${yesterday}&to=${today}').then((r) => r.text())`);
  check('the occupancy CSV has both nights and the exact revenue', occCsv.includes(yesterday) && occCsv.includes(today) && occCsv.includes(occ.totals.roomRevenueExVat));
  await go(`/reports/guest-ledger?branch=${br.id}`);
  check('the guest ledger matches the books', await shown('match Guest ledger', 8000));
  const glCsv = await evaluate(`fetch('/reports/export?report=guestLedger&branch=${br.id}&entity=${le.id}').then((r) => r.status + ' ' + r.headers.get('content-type'))`);
  check('the guest ledger CSV downloads', glCsv.startsWith('200 text/csv'));
  await go(`/reports/accommodation-tax?branch=${br.id}&from=${yesterday}&to=${today}`);
  const acc = await call('GET', `/v1/reports/accommodation-tax?branchId=${br.id}&from=${yesterday}&to=${today}`, tk);
  check('the accommodation tax report shows the API’s tax, with the unverified note', await shown('Unverified', 8000) && (await text()).includes(pesos(acc.totals.tax)));
  const accCsv = await evaluate(`fetch('/reports/export?report=accommodationTax&branch=${br.id}&from=${yesterday}&to=${today}').then((r) => r.text())`);
  check('the accommodation tax CSV has the exact tax', accCsv.includes(acc.totals.tax));
  await shot('lodging-reports.png');
  await go(`/reports/sales?branch=${br.id}&from=${yesterday}&to=${today}`);
  check('the sales summary shows room nights as their own source', await shownAnyCase('Room nights are charged on the guest’s folio', 8000));

  // ---- the customer's stays ----
  await go(`/customers/${customer.id}`);
  check('the customer page lists the stay', await shownAnyCase('Stays', 8000) && (await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/lodging/stays/${stayId}')`)));

  // ---- the guide ----
  await go('/help');
  check('the guide has the “Rooms, stays and folios” part', await shown('Rooms, stays and folios'));
  await go(`/lodging?branch=${br.id}`);
  check('the help button on Lodging opens that part', await evaluate(`[...document.querySelectorAll('a[href^="/help"]')].some((a) => a.getAttribute('href') === '/help#lodging')`));

  // ---- Filipino ----
  await clickText('FIL');
  check('Filipino: the front desk is translated', await shown('Bagong booking', 8000) && (await text()).includes('Aalis ngayon'));
  await go(`/lodging/housekeeping?branch=${br.id}`);
  check('Filipino: housekeeping is translated', await shown('Markahang', 8000));
  await clickText('EN');
  await shown('Housekeeping', 8000);

  // ---- phone width ----
  await viewport(390, 844, true);
  for (const path of [`/lodging?branch=${br.id}`, `/lodging/calendar?branch=${br.id}`, `/lodging/new?branch=${br.id}`, `/lodging/stays/${stayId}`, `/lodging/stays/${stayId}/card`, `/lodging/folios/${stay.folio.id}/statement`, `/lodging/housekeeping?branch=${br.id}`, `/lodging/setup?branch=${br.id}`, `/reports/occupancy?branch=${br.id}&from=${yesterday}&to=${today}`, `/reports/guest-ledger?branch=${br.id}`]) {
    await go(path);
    check(`390px: no sideways scroll on ${path.split('?')[0]}`, await noHorizontalScroll());
  }
  await go(`/lodging/calendar?branch=${br.id}&from=${yesterday}`);
  await shot('lodging-calendar-390.png');
  await go(`/lodging/stays/${stayId}`);
  await shot('lodging-stay-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
