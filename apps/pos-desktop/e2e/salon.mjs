// End-to-end test of a salon at the counter (ADR-0022, session 27):
// - the Appointments tab shows the day with a column per staff member;
// - booking a customer on file into a free time; a walk-in outside the staff's hours needs "Book anyway";
//   double-booking is refused; cancelling with a reason;
// - marking arrived, then "Ring up": Sell gets the service with its staff and the customer, whose pinned
//   note shows; a product sold by another staff member; the tip split by hand between the two;
// - the appointment is completed by the sale; tips per staff and staff per line recorded;
// - a package cannot be paid without a customer; sold to the customer; one session used at ₱0.00;
// - the guide's appointments part; phone width.
// Usage: node apps/pos-desktop/e2e/salon.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './api.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `salon-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Rosa Cruz', businessName: 'Rosa Salon', tenantSlug: slug, businessType: 'SALON' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Rosa Cruz Beauty', tin: '345-678-912', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Quezon City' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const item = async (body) => (await call('POST', '/v1/products', tk, { taxCategoryId: vat, uomId: pc, ...body }, idem())).variants[0].id;
const CUT = `CUT-${slug}`.toUpperCase();
const SHAMPOO = `SHP-${slug}`.toUpperCase();
const PKG = `PKG-${slug}`.toUpperCase();
const haircut = await item({ name: 'Haircut', productType: 'SERVICE', variants: [{ sku: CUT, price: '300.00', serviceMinutes: 45 }] });
const colour = await item({ name: 'Hair colour', productType: 'SERVICE', variants: [{ sku: `CLR-${slug}`.toUpperCase(), price: '1200.00', serviceMinutes: 90 }] });
const shampoo = await item({ name: 'Argan shampoo', variants: [{ sku: SHAMPOO, price: '250.00' }] });
const pack = await item({ name: '5 haircuts', productType: 'PACKAGE', variants: [{ sku: PKG, price: '1500.00', packageValidDays: 365 }] });
await call('PUT', `/v1/variants/${pack}/package-items`, tk, { items: [{ serviceVariantId: haircut, sessions: 5 }] });
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: shampoo, quantity: '20', unitCost: '120.00' }] }, idem());
const hours = { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAt: '08:00', endsAt: '20:00' })) };
const ana = await call('POST', '/v1/service-staff', tk, { branchId: br.id, displayName: 'Ana Reyes', color: '#7a4cc2', commissionRate: '0.1' }, idem());
const ben = await call('POST', '/v1/service-staff', tk, { branchId: br.id, displayName: 'Ben Lim', color: '#1e7a4a', commissionRate: '0.05' }, idem());
await call('PUT', `/v1/service-staff/${ana.id}/hours`, tk, hours);
await call('PUT', `/v1/service-staff/${ben.id}/hours`, tk, hours);
await call('PUT', `/v1/service-staff/${ben.id}/services`, tk, { services: [{ variantId: haircut }] });
const maria = await call('POST', '/v1/customers', tk, { displayName: 'Maria Santos', phone: '09171234567', marketingConsent: false, consentSource: 'COUNTER' }, idem());
await call('POST', `/v1/customers/${maria.id}/notes`, tk, { body: 'Allergic to ammonia hair dye', pinned: true }, idem());
void colour;

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9347 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const ok = (expr, ms = 10000) => waitFor(expr, ms).then(() => true, () => false);
const tab = (label) => evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
/** Set a React-controlled input or select (found by a selector, the visible one first). */
const setEl = (selector, value, index = 0) => evaluate(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = all.filter((x) => x.getClientRects().length)[${index}] ?? all[${index}];
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const click = (selector) => evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; (all.find((x) => x.getClientRects().length) ?? all[0]).click(); })()`);
const block = (who) => `[...document.querySelectorAll('[data-testid=appointment-block]')].find((x) => x.getAttribute('aria-label').includes(${JSON.stringify(who)}))`;
const scan = async (code) => {
  await setEl('#scan', code);
  await evaluate(`document.getElementById('scan').form.requestSubmit()`);
  await sleep(600);
};
const totalShows = (amount) => ok(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`);
const submitEnabled = () => evaluate(`!document.getElementById('pay-submit').disabled`);
const pickCustomer = async () => {
  await clickText('Customer');
  await waitFor(`document.getElementById('custSearch')`);
  await fill('custSearch', 'Maria');
  await clickText('Find');
  await shown('Maria Santos');
  await evaluate(`[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.includes('Maria Santos')).click()`);
  await waitFor(`document.querySelector('[data-testid=sale-customer]')`);
};

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front')`);
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === 'Front').querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);

  // ---- the appointment book ----
  check('a salon has an Appointments tab', await ok(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].some((x) => x.textContent.trim() === 'Appointments')`));
  await tab('Appointments');
  check('the day shows a column per staff member', await ok(`document.querySelector('[data-testid=day-view]')?.innerText.includes('Ana Reyes') && document.querySelector('[data-testid=day-view]').innerText.includes('Ben Lim')`));
  // Tomorrow, so every working hour is still ahead whatever the time of the run.
  await evaluate(`document.querySelector('[aria-label="Next day"]').click()`);
  await sleep(500);
  await clickText('New appointment');
  await waitFor(`document.querySelector('[data-testid=booking-form]')`);
  await fill('custSearch', 'Maria');
  await clickText('Find');
  await shown('Maria Santos');
  await evaluate(`[...document.querySelectorAll('[data-testid=booking-form] button')].find((x) => x.textContent.includes('Maria Santos')).click()`);
  check('the customer is found and put on the booking', await ok(`document.querySelector('[data-testid=booking-customer]')?.innerText.includes('Maria Santos')`));
  await setEl('[data-testid=booking-service] select', haircut, 0);
  check('free times are offered per staff member', await ok(`document.querySelector('[data-testid=free-times] button[data-staff="Ana Reyes"]') && document.querySelector('[data-testid=free-times] button[data-staff="Ben Lim"]')`));
  const slot = await evaluate(`(() => { const all = [...document.querySelectorAll('[data-testid=free-times] button[data-staff="Ana Reyes"]')]; const b = all.find((x) => x.dataset.slot === '10:00') ?? all[0]; b.click(); return b.dataset.slot; })()`);
  await sleep(300);
  check('tapping a free time sets the staff member and the time', (await evaluate(`document.querySelectorAll('[data-testid=booking-service] select')[1].value`)) === ana.id && (await evaluate(`document.querySelector('[data-testid=booking-service] input[type=time]').value`)) === slot);
  await setEl('#apptNotes', 'Trim only, keep the length');
  await shot('salon-booking.png', false);
  await click('[data-testid=booking-form] .btn-primary');
  check('the booking shows as a block in Ana’s column', await ok(`${block('Maria Santos')}?.dataset.status === 'BOOKED'`) && await shown(`Booked for ${slot}`));

  // ---- double-booking is refused; outside hours needs "Book anyway" ----
  await clickText('New appointment');
  await waitFor(`document.querySelector('[data-testid=booking-form]')`);
  await clickText('Walk-in');
  await setEl('#guestName', 'Lea Dizon');
  await setEl('[data-testid=booking-service] select', haircut, 0);
  await sleep(300);
  await setEl('[data-testid=booking-service] select', ana.id, 1);
  await setEl('[data-testid=booking-service] input[type=time]', slot);
  await click('[data-testid=booking-form] .btn-primary');
  check('booking Ana twice at the same time is refused', await shown('already booked at that time'));
  await setEl('#guestName', 'Joy Tan');
  await setEl('[data-testid=booking-service] select', ben.id, 1);
  await setEl('[data-testid=booking-service] input[type=time]', '21:00');
  await click('[data-testid=booking-form] .btn-primary');
  check('a time outside the staff member’s hours asks to book anyway', await shown('outside the staff member’s hours'));
  await clickText('Book anyway');
  check('“Book anyway” books it', await ok(`${block('Joy Tan')}?.dataset.status === 'BOOKED'`));
  await evaluate(`${block('Joy Tan')}.click()`);
  await clickText('Cancel appointment');
  await setEl('#cancelReason', 'Called to cancel');
  await clickText('Cancel it');
  check('a cancelled appointment stays on the day, marked cancelled', await ok(`${block('Joy Tan')}?.dataset.status === 'CANCELLED'`));
  await shot('salon-day.png', false);

  // ---- arrived, then ring up ----
  await evaluate(`${block('Maria Santos')}.click()`);
  await waitFor(`document.querySelector('[data-testid=appointment-panel]')?.innerText.includes('Trim only')`);
  await clickText('Arrived');
  check('marking arrived', await ok(`${block('Maria Santos')}?.dataset.status === 'ARRIVED'`));
  const appointmentId = (await call('GET', `/v1/appointments?branchId=${br.id}&from=${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 86400000).toISOString())}`, tk)).data.find((a) => a.customerId === maria.id).id;
  await clickText('Ring up');
  check('Ring up opens Sell with the appointment', await ok(`document.querySelector('[data-testid=sale-appointment]')?.getClientRects().length > 0`));
  check('… the service on a line with its staff member', await ok(`document.querySelector('[data-testid=line-staff]')?.value === ${JSON.stringify(ana.id)}`) && (await text()).includes('Haircut'));
  check('… the customer on the sale, with her pinned note', await ok(`document.querySelector('[data-testid=sale-customer]')?.innerText.includes('Maria Santos') && document.querySelector('[data-testid=customer-notes]')?.innerText.includes('Allergic to ammonia')`));
  await totalShows('₱300.00');
  await scan(SHAMPOO);
  await totalShows('₱550.00');
  await setEl('[data-testid=line-staff]', ben.id, 1);
  await sleep(300);
  await setEl('#tip', '100');
  check('two staff on the sale: the tip is shared equally unless split', await shown('Shared equally among the 2 staff'));
  await evaluate(`[...document.querySelectorAll('[data-testid=tip-split] button')].find((x) => x.textContent.trim() === 'Split').click()`);
  check('Split starts from equal shares', await ok(`document.getElementById('share-${ana.id}')?.value === '50.00' && document.getElementById('share-${ben.id}')?.value === '50.00'`));
  await setEl(`#share-${ana.id}`, '80');
  check('shares that do not add up stop the sale', await shown('must add up to the tip') && !(await submitEnabled()));
  await setEl(`#share-${ben.id}`, '20');
  await setEl('#cash', '700');
  check('shares adding up to the tip let the sale go', await ok(`!document.getElementById('pay-submit').disabled`));
  await shot('salon-ringup.png', false);
  await evaluate(`document.getElementById('pay-submit').click()`);
  check('the sale is recorded', await shown('New sale', 15000) && await ok(`document.querySelector('.printable')`));
  await shot('salon-receipt.png', false);
  const appt = await call('GET', `/v1/appointments/${appointmentId}`, tk);
  check('the appointment is completed by the sale', appt.status === 'COMPLETED' && Boolean(appt.saleId));
  const sale = await call('GET', `/v1/sales/${appt.saleId}`, tk);
  check('each line names who did or sold it', sale.lines.find((l) => l.variantId === haircut)?.serviceStaffId === ana.id && sale.lines.find((l) => l.variantId === shampoo)?.serviceStaffId === ben.id);
  // The report takes the branch's local days (Manila): yesterday to tomorrow covers the run's day.
  const dayOf = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
  const tips = await call('GET', `/v1/reports/tips-by-staff?branchId=${br.id}&from=${dayOf(Date.now() - 86400000)}&to=${dayOf(Date.now() + 86400000)}`, tk);
  const share = (id) => tips.staff?.find((s) => s.staffId === id)?.amount;
  check('the tip went 80 / 20 to Ana and Ben', share(ana.id) === '80.00' && share(ben.id) === '20.00');
  await clickText('New sale');

  // ---- a package needs a customer; sold, then one session used at ₱0.00 ----
  await scan(PKG);
  check('a package without a customer is stopped before payment', await shown('A package belongs to a customer') && !(await submitEnabled()));
  await pickCustomer();
  await setEl('#cash', '1500');
  check('with the customer on the sale, the package can be paid', await totalShows('₱1,500.00') && await ok(`!document.getElementById('pay-submit').disabled`));
  await evaluate(`document.getElementById('pay-submit').click()`);
  await shown('New sale', 15000);
  const packs = (await call('GET', `/v1/customers/${maria.id}/packages?open=true`, tk)).data;
  check('the customer now holds the package with 5 haircuts', packs.length === 1 && packs[0].services[0].sessionsLeft === 5);
  await clickText('New sale');

  await pickCustomer();
  await scan(CUT);
  check('a service the customer’s package covers offers “Use package (5 left)”', await ok(`document.querySelector('[data-testid=use-package]')?.textContent.includes('Use package (5 left)')`));
  await click('[data-testid=use-package]');
  await setEl('[data-testid=line-staff]', ana.id, 0);
  check('the session costs ₱0.00 and says it is from the package', await totalShows('₱0.00') && await ok(`document.querySelector('[data-testid=line-package]')?.innerText.includes('5 haircuts')`));
  await shot('salon-package.png', false);
  check('nothing to pay: the sale can be completed at once', await ok(`!document.getElementById('pay-submit').disabled`));
  await evaluate(`document.getElementById('pay-submit').click()`);
  await shown('New sale', 15000);
  const after = (await call('GET', `/v1/customers/${maria.id}/packages?open=true`, tk)).data;
  check('one session was used: 4 left', after[0]?.services[0].sessionsLeft === 4);
  await clickText('New sale');

  // ---- the guide's part, phone width ----
  await tab('Appointments');
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }))`);
  check('F1 on Appointments opens the guide at “Appointments, staff and packages”', await ok(`document.getElementById('guide-appointments')?.innerText.includes('Book anyway')`));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await viewport(390, 844);
  await sleep(400);
  check('phone width: the day scrolls inside its card, never the page', await noHorizontalScroll());
  await shot('salon-390.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
