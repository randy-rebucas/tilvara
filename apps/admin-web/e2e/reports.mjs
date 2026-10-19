// End-to-end test of the restaurant report screens (ADR-0014 §10, Phase 4 slice 6d). A service day is
// arranged through the API (orders, kitchen, a bill paid in one check, a dropped burger), then the
// owner reads every report in the admin and the figures are checked.
// Usage: node e2e/reports.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { arrangeRestaurant, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

// --- the day: burger recipe = 1 cheese slice (₱3.00 each); T1 pays ₱473.00; T2's burger is dropped while cooking.
const r = await arrangeRestaurant(API, 'rep');
const { call, tk } = r;
const key = () => ({ 'idempotency-key': randomUUID() });
await call('POST', `/v1/variants/${r.burger}/recipe`, tk, { ingredients: [{ variantId: r.cheese, quantity: '1' }] });
const ws = (await call('GET', '/v1/pos/workstations', tk)).data[0];
const session = await call('POST', '/v1/cashier-sessions', tk, { registerId: ws.register.id, openingFloat: '1000.00' });
const status = (id, s) => call('POST', `/v1/order-items/${id}/status`, tk, { status: s });

const t1 = await call('POST', '/v1/restaurant/orders', tk, { branchId: r.branchId, orderType: 'DINE_IN', tableId: r.tables.T1, guestCount: 2 });
await call('POST', `/v1/restaurant/orders/${t1.id}/items`, tk, { items: [{ variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOption] }, { variantId: r.tea, quantity: '2' }] }, key());
const fired1 = await call('POST', `/v1/restaurant/orders/${t1.id}/fire`, tk, {});
const [b1, tea1] = fired1.items;
for (const [id, steps] of [[b1.id, ['IN_PREP', 'READY', 'SERVED']], [tea1.id, ['READY', 'SERVED']]]) for (const s of steps) await status(id, s);
const bill = await call('POST', `/v1/restaurant/orders/${t1.id}/bill`, tk, {}, key());
await call('POST', `/v1/restaurant/bills/${bill.id}/checks`, tk, { cashierSessionId: session.id, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '500.00' }], expectedAmountDue: '473.00' }, key());

const t2 = await call('POST', '/v1/restaurant/orders', tk, { branchId: r.branchId, orderType: 'DINE_IN', tableId: r.tables.T2 });
await call('POST', `/v1/restaurant/orders/${t2.id}/items`, tk, { items: [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }] }, key());
const [b2] = (await call('POST', `/v1/restaurant/orders/${t2.id}/fire`, tk, {})).items;
await status(b2.id, 'IN_PREP');
await call('POST', `/v1/order-items/${b2.id}/void`, tk, { reason: 'Dropped on the floor', wasted: true }, key());

// --- read the reports in the admin
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9340 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const has = async (...parts) => {
  const s = await text();
  return parts.every((p) => (p instanceof RegExp ? p.test(s) : s.includes(p)));
};

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', r.email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('nav shows Reports', await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.textContent === 'Reports')`));

  await go('/reports');
  await waitFor(`document.body.innerText.includes('Item performance')`);
  // Burger 2 × 150 (cost 2 cheese slices for the recipe = ₱6.00); its cheese choice ₱40.00 (2 × ₱3.00); tea ₱90.00.
  check('item performance: burger ₱300.00, cheese choice under it ₱40.00, tea ₱90.00, total ₱430.00', await has('Burger', '₱300.00', '+ Cheese slice', '₱40.00', 'Burger with choices', '₱340.00', 'Iced tea', '₱90.00', '₱430.00'));
  check('item performance: burger cost ₱6.00 (its recipe)', await has('₱6.00'));
  await shot('reports-items.png');

  await clickText('Ingredient usage');
  await waitFor(`document.body.innerText.includes('Over expected')`);
  // Cheese: recipe 2 + sold as a choice 2 = expected 4; the dropped burger threw 1 away → actual 5, +1 (25.0%), ₱3.00.
  check('ingredient usage: cheese expected 4, thrown away 1, actual 5, +1 (25.0%)', await has(/Cheese slice[\s\S]*4 PC[\s\S]*1[\s\S]*5 PC[\s\S]*\+1 \(25\.0%\)/));
  check('ingredient usage: expected ₱12.00, waste ₱3.00, actual ₱15.00, over +₱3.00', await has('₱12.00', '₱15.00', '+₱3.00'));
  await shot('reports-usage.png');

  await clickText('Kitchen voids');
  await waitFor(`document.body.innerText.includes('Dropped on the floor')`);
  check('kitchen voids: the dropped burger, cooking, thrown away ₱3.00, by the owner', await has('Dropped on the floor', /cooking/i, '₱3.00', 'Lito Santos'));
  check('waste value links to its stock document', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.href.includes('/inventory/adjustments/'))`));
  await shot('reports-voids.png');

  await clickText('Prep times');
  await waitFor(`document.body.innerText.includes('All stations')`);
  check('prep times: Grill timed 1 of 2 (the voided burger untimed), Bar 1 of 1, all stations 2 of 3', await has(/Grill[\s\S]*1 \/ 2/, /Bar[\s\S]*1 \/ 1/, /All stations[\s\S]*2 \/ 3/));
  await clickText('By item');
  await waitFor(`location.search.includes('by=item') && document.body.innerText.includes('Iced tea')`);
  check('prep times by item: Burger 1 of 2 and Iced tea 1 of 1', await has(/Burger[\s\S]*1 \/ 2/, /Iced tea[\s\S]*1 \/ 1/));
  await clickText('By hour');
  await waitFor(`location.search.includes('by=hour')`);
  check('prep times by hour: rows named by local hour, 3 items in all', await evaluate(`(() => {
    const rows = [...document.querySelectorAll('main table tbody tr')];
    const counted = rows.map((tr) => /(\\d+) \\/ (\\d+)/.exec(tr.innerText)).filter(Boolean).reduce((a, m) => a + Number(m[2]), 0);
    return rows.length > 0 && rows.every((tr) => /\\d\\d:00–\\d\\d:59/.test(tr.innerText)) && counted === 3;
  })()`));
  await shot('reports-prep-hour.png');

  await clickText('Open orders');
  await waitFor(`document.body.innerText.includes('Left to collect')`);
  check('open orders: T2 still open, not billed; T1 (paid) not listed', await has(/T2\s*#2/) && !(await has(/T1\s*#1/)));

  await clickText('Service charge');
  await waitFor(`document.body.innerText.includes('To distribute')`);
  check('service charge: ₱43.00 charged, ₱38.39 to distribute, equal to the books', await has('₱43.00', '₱38.39', 'Equals the service charge liability'));
  check('service charge: the RA 11360 / accountant caveat is shown', await has('RA 11360'));
  await shot('reports-charge.png');

  // A range the API refuses is shown, not crashed.
  await go(`/reports/service-charge?branch=${r.branchId}&from=2026-12-31&to=2026-01-01`);
  check('a reversed range shows the API message', await has('"from" must not be after "to"'));

  for (const path of ['/reports', '/reports/ingredient-usage', '/reports/kitchen-voids', '/reports/prep-times', '/reports/open-orders', '/reports/service-charge']) {
    await viewport(390, 844, true);
    await go(path);
    await sleep(300);
    check(`${path}: no horizontal page scroll at 390px`, await noHorizontalScroll());
  }
  await shot('reports-390.png');
  await viewport(1440, 900);
  await go('/reports');
  await clickText('FIL');
  check('Filipino reports', await waitFor(`document.body.innerText.includes('Kita bawat item')`).then(() => true, () => false));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
