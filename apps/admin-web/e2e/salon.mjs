// End-to-end test of a salon, spa or barber shop (ADR-0022) in the back office: the sign-up offers
// "Salon, spa or barber shop"; the band has Appointments and no Restaurant; a staff member is added
// with weekly hours; a service is added with its duration (and has "Supplies used"); an appointment
// is booked from an empty slot of the calendar and shows there; a booking outside the staff's hours
// asks first and "Book anyway" books it; the client arrives; a package is made with its contents; the
// customer's page has service notes (with the privacy notice), packages with sessions left and visits;
// the sale shows who did the work and the package session; the commission report and its CSV; the
// guide's part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/salon.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));
const today = day(0);
const target = day(1); // tomorrow: every slot of the day is still ahead
const weekday = new Date(`${target}T00:00:00Z`).getUTCDay();

const slug = `salon-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Liza Mendoza', businessName: 'Salon ni Liza', tenantSlug: slug, businessType: 'SALON' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Liza Mendoza Beauty', tin: '234-567-890', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Quezon City' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front desk' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const tag = slug.slice(-5).toUpperCase();
const haircut = await call('POST', '/v1/products', tk, { name: 'Haircut', productType: 'SERVICE', taxCategoryId: vat, uomId: pc, variants: [{ sku: `CUT-${tag}`, price: '350.00', serviceMinutes: 45 }] }, idem());
const haircutId = haircut.variants[0].id;
await call('POST', '/v1/products', tk, { name: 'Hair dye tube', taxCategoryId: vat, uomId: pc, variants: [{ sku: `DYE-${tag}`, price: '250.00' }] }, idem());
const customer = await call('POST', '/v1/customers', tk, { displayName: 'Maria Santos', email: `maria-${tag.toLowerCase()}@example.ph`, phone: '0917 555 0101' }, idem());
const mark = await call('POST', '/v1/service-staff', tk, { branchId: br.id, displayName: 'Mark Reyes', commissionRate: '0.10', color: '#2a8a8a' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9361 });
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

try {
  await viewport(1440, 900);
  // ---- sign-up offers the salon type ----
  await go('/sign-up');
  check('sign-up offers “Salon, spa or barber shop”', await evaluate(`Boolean(document.querySelector('input[name=businessType][value=SALON]'))`) && (await text()).includes('Salon, spa or barber shop'));

  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  const tabs = await evaluate(`[...document.querySelectorAll('header nav a')].map((a) => a.textContent.trim())`);
  check('a salon has the Appointments tab and no Restaurant tab', tabs.includes('Appointments') && !tabs.includes('Restaurant'));

  // ---- a staff member with weekly hours ----
  await go(`/appointments/staff?branch=${br.id}`);
  check('Staff lists the staff member made through the API, with 10 %', await shown('Mark Reyes') && (await text()).includes('10%'));
  await clickText('Add staff member');
  await waitFor(`document.querySelector('[name="displayName"]')`);
  await fill('displayName', 'Joy Cruz');
  await fill('commission', '15');
  await submitFormOf('displayName');
  await waitFor(`/^\\/appointments\\/staff\\/[0-9a-f-]{36}$/.test(location.pathname)`, 10000);
  const joyId = await evaluate(`location.pathname.split('/').pop()`);
  check('the new staff member’s page opens, commission 15 %', await shown('Joy Cruz') && (await text()).includes('15%'));
  await evaluate(`[...document.querySelectorAll('li[data-weekday="${weekday}"] button')].find((x) => x.textContent.trim() === 'Hours').click()`);
  await waitFor(`document.querySelectorAll('li[data-weekday="${weekday}"] input[type=time]').length === 2`);
  await clickButton('Save hours');
  await shown('Saved.', 8000);
  const joy = await call('GET', `/v1/service-staff/${joyId}`, tk);
  check('the hours are saved: 09:00–18:00 on the booking day', joy.hours.length === 1 && joy.hours[0].weekday === weekday && joy.hours[0].startsAt === '09:00' && joy.hours[0].endsAt === '18:00' && joy.commissionRate === '0.15');
  await shot('salon-staff.png');

  // ---- a service with its duration ----
  await go('/products');
  await clickText('Add product');
  await waitFor(`document.querySelector('select[name="productType"]')`);
  await fill('productType', 'SERVICE');
  await waitFor(`document.querySelector('[name="serviceMinutes"]')`);
  check('a service has no “Keeps expiry dates” box', !(await evaluate(`Boolean(document.querySelector('[name="tracksExpiry"]'))`)));
  await fill('name', 'Hair colour');
  await fill('sku', `CLR-${tag}`);
  await fill('price', '1200.00');
  await fill('serviceMinutes', '90');
  await submitFormOf('serviceMinutes');
  await shown('Hair colour', 10000);
  const colour = (await call('GET', '/v1/products?q=Hair%20colour', tk)).data.find((p) => p.name === 'Hair colour');
  check('the API has the service with 90 minutes', colour?.productType === 'SERVICE' && colour.variants[0].serviceMinutes === 90 && !colour.trackInventory);
  await go(`/products/${colour.id}`);
  check('the service’s page shows its duration and “Supplies used”', await shown('90 min') && (await text()).includes('Supplies used'));
  await clickText('Supplies used');
  check('“Supplies used” opens the service’s supplies, with the dye to choose', await shown('Supplies used: Hair colour', 10000) && (await text()).includes('Set supplies used'));

  // ---- book from an empty slot of the calendar ----
  await go(`/appointments?branch=${br.id}&date=${target}`);
  check('the day view has a column per staff member', await evaluate(`Boolean(document.querySelector('[data-staff="Joy Cruz"]')) && Boolean(document.querySelector('[data-staff="Mark Reyes"]'))`));
  await evaluate(`document.querySelector('[data-staff="Joy Cruz"] a[data-slot="10:00"]').click()`);
  await waitFor(`location.pathname === '/appointments/new'`, 10000);
  await waitFor(`document.querySelector('[name="time-0"]')`);
  check('the slot fills Joy and 10:00', await evaluate(`document.querySelector('[name="staff-0"]').value === ${JSON.stringify(joyId)} && document.querySelector('[name="time-0"]').value === '10:00'`));
  await fill('customerSearch', 'Maria');
  await waitFor(`document.querySelector('button[data-customer]')`, 8000);
  await evaluate(`document.querySelector('button[data-customer]').click()`);
  await waitFor(`document.querySelector('[data-testid=picked-customer]')`);
  check('the reminder is ticked for a customer with an email', await evaluate(`document.querySelector('input[name=remind]').checked`));
  await fill('service-0', haircutId);
  check('free times are suggested for the service', await waitFor(`document.querySelector('[data-testid=free-times] [data-slot^="Joy Cruz"]')`, 8000).then(() => true, () => false));
  await fill('time-0', '10:00');
  await fill('staff-0', joyId);
  await shot('salon-booking.png');
  await clickButton('Book');
  await waitFor(`location.pathname === '/appointments'`, 10000);
  check('the booking shows on the calendar in Joy’s column', await waitFor(`[...document.querySelectorAll('[data-staff="Joy Cruz"] [data-appointment]')].some((a) => a.textContent.includes('Maria Santos'))`, 8000).then(() => true, () => false));
  await shot('salon-calendar.png');

  // ---- outside the hours: asked first, then "Book anyway" ----
  await go(`/appointments/new?branch=${br.id}&date=${target}&staff=${joyId}&time=19:00`);
  await waitFor(`document.querySelector('[name="guestName"]')`);
  await fill('guestName', 'Walk-in Ben');
  await fill('service-0', haircutId);
  await fill('staff-0', joyId);
  await clickButton('Book');
  check('a booking outside Joy’s hours asks first', await waitFor(`document.querySelector('[data-testid=outside-hours]')`, 8000).then(() => true, () => false) && (await text()).includes('outside'));
  await shot('salon-outside-hours.png', false);
  await clickButton('Book anyway');
  await waitFor(`location.pathname === '/appointments'`, 10000);
  const from = new Date(`${target}T00:00:00+08:00`).toISOString();
  const to = new Date(`${target}T23:59:00+08:00`).toISOString();
  const appts = (await call('GET', `/v1/appointments?branchId=${br.id}&from=${from}&to=${to}`, tk)).data;
  check('“Book anyway” booked it: two bookings that day', appts.length === 2 && appts.some((a) => a.guestName === 'Walk-in Ben'));
  check('the calendar lists the guest too', await shown('Walk-in Ben'));

  // ---- the client arrives ----
  const maria = appts.find((a) => a.customerId === customer.id);
  await go(`/appointments/${maria.id}`);
  await clickButton('Mark arrived');
  check('marked arrived', await waitFor(`document.querySelector('h1 [data-status="ARRIVED"]')`, 8000).then(() => true, () => false));

  // ---- a package with its contents ----
  await go('/products');
  await clickText('Add product');
  await waitFor(`document.querySelector('select[name="productType"]')`);
  await fill('productType', 'PACKAGE');
  await waitFor(`document.querySelector('[name="packageValidDays"]')`);
  await fill('name', '5 Haircuts');
  await fill('sku', `PKG-${tag}`);
  await fill('price', '1500.00');
  await fill('packageValidDays', '180');
  await submitFormOf('packageValidDays');
  await waitFor(`/^\\/products\\/[0-9a-f-]{36}$/.test(location.pathname)`, 10000);
  const pkgProductId = await evaluate(`location.pathname.split('/').pop()`);
  await waitFor(`document.querySelector('[name="pkgService-0"]')`);
  check('the package page asks for its contents, valid 180 days', (await text()).includes('What the package holds') && (await text()).includes('Valid 180 days'));
  await fill('pkgService-0', haircutId);
  await fill('pkgSessions-0', '5');
  await clickButton('Save contents');
  await shown('Saved.', 8000);
  const pkgProduct = await call('GET', `/v1/products/${pkgProductId}`, tk);
  const pkgVariantId = pkgProduct.variants[0].id;
  const contents = await call('GET', `/v1/variants/${pkgVariantId}/package-items`, tk);
  check('the API has the package: 5 haircuts, 180 days', pkgProduct.productType === 'PACKAGE' && contents.validDays === 180 && contents.items.length === 1 && contents.items[0].sessions === 5);
  await shot('salon-package.png');

  // ---- sales at the till (through the API): the appointment, the package, a session from it ----
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
  const sale = async (body) => call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '5000.00' }], ...body }, idem());
  const apptSale = await sale({ customerId: customer.id, appointmentId: maria.id, lines: [{ variantId: haircutId, quantity: '1', staffId: joyId }] });
  await sale({ customerId: customer.id, lines: [{ variantId: pkgVariantId, quantity: '1', staffId: joyId }] });
  const owned = (await call('GET', `/v1/customers/${customer.id}/packages`, tk)).data;
  const sessionSale = await sale({ customerId: customer.id, lines: [{ variantId: haircutId, quantity: '1', staffId: joyId, packageId: owned[0].id }] });

  await go(`/appointments/${maria.id}`);
  check('the rung-up appointment is done and links to its sale', await shown('Rung up at the till.') && (await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/sales/${apptSale.id}')`)));
  await go(`/sales/${sessionSale.id}`);
  check('the sale names who did it and the package session', await shown('By Joy Cruz') && (await text()).includes('From package'));

  // ---- the customer: service notes, packages, visits ----
  await go(`/customers/${customer.id}`);
  check('the customer page has service notes with the privacy notice', await shownAnyCase('Service notes') && (await text()).includes('Keep only what the service needs'));
  await fill('noteBody', 'Allergic to ammonia: use the ammonia-free colour.');
  await evaluate(`document.querySelector('input[name=pinned]').click()`);
  await submitFormOf('noteBody');
  check('the note is saved, pinned', await shown('Allergic to ammonia', 8000) && (await text()).includes('Pinned'));
  const notes = (await call('GET', `/v1/customers/${customer.id}/notes`, tk)).data;
  check('the API has the pinned note', notes.length === 1 && notes[0].pinned);
  check('Packages shows 4 of 5 haircuts left', (await text()).toLowerCase().includes('4 of 5 left'));
  check('Visits lists the appointment and the services with Joy', (await text()).includes('Haircut · Joy Cruz') && (await text()).includes('From package'));
  await shot('salon-customer.png');

  // ---- commission report and its CSV ----
  await go(`/reports/commissions?branch=${br.id}&from=${today}&to=${today}`);
  const report = await call('GET', `/v1/reports/commissions?branchId=${br.id}&from=${today}&to=${today}`, tk);
  const joyRow = report.staff.find((s) => s.staffId === joyId);
  const pesos = (v) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  check('Reports → Salon → Commissions shows Joy with the API’s commission', Boolean(joyRow) && (await shown('Joy Cruz', 8000)) && (await text()).includes(pesos(joyRow.commission)));
  const csv = await evaluate(`fetch('/reports/export?report=commissions&branch=${br.id}&from=${today}&to=${today}').then((r) => r.text())`);
  check('the commission CSV has Joy and the exact amount', csv.includes('Joy Cruz') && csv.includes(joyRow.commission));
  await shot('salon-commissions.png');
  await go(`/reports/service-packages?branch=${br.id}&from=${today}&to=${today}`);
  check('Service packages lists Maria’s open package', await shown('Maria Santos', 8000) && (await text()).includes('5 Haircuts'));
  await go(`/reports/staff-tips?branch=${br.id}&from=${today}&to=${today}`);
  check('Tips by staff opens', await shownAnyCase('Tips by staff', 8000));

  // ---- the guide ----
  await go('/help');
  check('the guide has the “Appointments, packages and staff” part', await shown('Appointments, packages and staff'));
  await go(`/appointments?branch=${br.id}`);
  check('the help button on Appointments opens that part', await evaluate(`[...document.querySelectorAll('a[href^="/help"]')].some((a) => a.getAttribute('href') === '/help#salon')`));

  // ---- Filipino ----
  await clickText('FIL');
  check('Filipino: the calendar is translated', await shown('Kalendaryo', 8000) && (await text()).includes('Bagong appointment'));
  await go(`/appointments/staff/${joyId}`);
  check('Filipino: the staff page is translated', await shownAnyCase('Oras bawat linggo', 8000));
  await clickText('EN');
  await shown('Weekly hours', 8000);

  // ---- phone width ----
  await viewport(390, 844, true);
  for (const path of [`/appointments?branch=${br.id}&date=${target}`, `/appointments/new?branch=${br.id}&date=${target}`, `/appointments/staff/${joyId}`, `/customers/${customer.id}`, `/reports/commissions?branch=${br.id}&from=${today}&to=${today}`, `/products/${pkgProductId}`]) {
    await go(path);
    check(`390px: no sideways scroll on ${path.split('?')[0]}`, await noHorizontalScroll());
  }
  await go(`/appointments?branch=${br.id}&date=${target}`);
  await shot('salon-calendar-390.png');
  // Mark has no hours: the whole day is open to him (not used further; here so the fixture is not unused).
  check('a staff member without hours is bookable all day', (await call('GET', `/v1/appointments/availability?branchId=${br.id}&variantId=${haircutId}&date=${target}&staffId=${mark.id}`, tk)).staff[0]?.slots.length > 0);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
