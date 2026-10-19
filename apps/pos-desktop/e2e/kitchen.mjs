// End-to-end test of the kitchen display (ADR-0014 §7, Phase 4 slice 6b): station picker → open
// tickets per station → start / bump → the floor serves → the ticket leaves the board.
// Usage: node apps/pos-desktop/e2e/kitchen.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { arrangeRestaurant, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const r = await arrangeRestaurant(API, 'kds');
const { call, tk } = r;
// The floor (through the API): T1 orders a burger and an iced tea and sends them.
const order = await call('POST', '/v1/restaurant/orders', tk, { branchId: r.branchId, orderType: 'DINE_IN', tableId: r.tables.T1, guestCount: 2 });
await call('POST', `/v1/restaurant/orders/${order.id}/items`, tk, { items: [
  { variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.cheeseOption], note: 'No pickles' },
  { variantId: r.tea, quantity: '2' },
] }, { 'idempotency-key': randomUUID() });
await call('POST', `/v1/restaurant/orders/${order.id}/fire`, tk, {});
const items = async () => (await call('GET', `/v1/restaurant/orders/${order.id}`, tk)).items;

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9338 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', r.email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  check('the register picker offers the kitchen display', await shown('Open kitchen display'));
  await clickText('Open kitchen display');
  check('stations of the branch: Grill and Bar', await shown('Grill') && (await text()).includes('Bar'));
  await shot('kds-picker.png', false);
  await evaluate(`[...document.querySelectorAll('section')].find((s) => s.textContent.includes('GRILL')).querySelector('button').click()`);

  check('grill ticket for T1: the burger with its choices and note', await shown('1× Burger') && (await text()).includes('Medium · Cheese') && (await text()).includes('No pickles'));
  check('the grill does not see the bar', !(await text()).includes('Iced tea'));
  check('ticket shows course-free header, elapsed time and New (not started)', /T1/.test(await text()) && /\d+:\d\d/.test(await text()) && (await text()).includes('New'));
  await shot('kds-board.png', false);

  await clickText('Start');
  check('Start → Cooking (on the server too)', await shown('Cooking') && (await items()).find((i) => i.name === 'Burger').status === 'IN_PREP');
  await clickText('All ready (bump)');
  // The item's own "Ready" button is on screen before the bump: wait for the bump to land instead.
  check('a ticket with nothing left to cook has no bump button', await waitFor(`!document.body.innerText.includes('All ready (bump)')`).then(() => true, () => false));
  check('bump → Ready; the floor sees it', (await items()).find((i) => i.name === 'Burger').status === 'READY' && !(await evaluate(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.trim() === 'Ready')`)));
  // A mistaken bump is undone: back to Cooking, then bumped again.
  check('a bumped ticket offers Undo bump', await shown('Undo bump'));
  await shot('kds-unbump.png', false);
  await clickText('Undo bump');
  check('Undo bump → Cooking again, on the server too', await waitFor(`document.body.innerText.includes('All ready (bump)')`).then(() => true, () => false) && (await items()).find((i) => i.name === 'Burger').status === 'IN_PREP');
  await clickText('All ready (bump)');
  check('bumped again → Ready', await waitFor(`!document.body.innerText.includes('All ready (bump)')`).then(() => true, () => false) && (await items()).find((i) => i.name === 'Burger').status === 'READY');

  // The floor serves: the ticket leaves the board on the next poll.
  const burger = (await items()).find((i) => i.name === 'Burger');
  await call('POST', `/v1/order-items/${burger.id}/status`, tk, { status: 'SERVED' });
  check('served food leaves the board', await shown('No tickets', 10000));

  // Done: the served ticket can be looked up again (read-only).
  await clickText('Done');
  check('Done lists the served T1 ticket with its burger', await shown('Served') && (await text()).includes('1× Burger') && (await text()).includes('T1'));
  await shot('kds-done.png', false);
  await clickText('Open');

  // A new ticket arrives: it chimes once (counted by wrapping Web Audio) and flashes "New ticket".
  await evaluate(`(() => {
    window.__tones = 0;
    const A = window.AudioContext;
    window.AudioContext = class extends A { createOscillator() { window.__tones++; return super.createOscillator(); } };
  })()`);
  await call('POST', `/v1/restaurant/orders/${order.id}/items`, tk, { items: [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }] }, { 'idempotency-key': randomUUID() });
  await call('POST', `/v1/restaurant/orders/${order.id}/fire`, tk, {});
  check('a newly fired ticket flashes as New ticket', await waitFor(`document.querySelector('[data-fresh]') && document.body.innerText.includes('New ticket')`, 10000).then(() => true, () => false));
  check('and the kitchen hears it (two tones)', (await evaluate('window.__tones')) === 2);
  await shot('kds-new-ticket.png', false);

  // Pushed, not polled (the poll is 30 s while the stream is up): a course with its note, fired
  // through the API, is on the board within a moment; voiding its cheese strikes the cheese.
  await call('PUT', `/v1/restaurant/orders/${order.id}/course-notes`, tk, { course: 2, note: 'Birthday: bring with a candle' });
  await call('POST', `/v1/restaurant/orders/${order.id}/items`, tk, { items: [{ variantId: r.burger, quantity: '1', course: 2, modifierOptionIds: [r.medium, r.cheeseOption] }] }, { 'idempotency-key': randomUUID() });
  const fired = Date.now();
  await call('POST', `/v1/restaurant/orders/${order.id}/fire`, tk, { courses: [2] });
  const noted = await waitFor(`document.querySelector('[data-testid="course-note"]')?.innerText.includes('Birthday: bring with a candle')`, 2500).then(() => true, () => false);
  check(`a fired course arrives by push within 2.5 s, with its course note (${Date.now() - fired} ms)`, noted);
  const course2 = (await items()).find((i) => i.course === 2 && i.name === 'Burger');
  await call('POST', `/v1/order-items/${course2.modifiers.find((m) => m.name === 'Cheese').id}/void`, tk, { reason: 'No cheese after all' }, { 'idempotency-key': randomUUID() });
  check('a choice voided on its own is struck on the ticket', await waitFor(`[...document.querySelectorAll('s')].some((x) => x.textContent === 'Cheese')`, 2500).then(() => true, () => false));
  await shot('kds-course-note.png', false);
  await clickText('Sound on');
  check('sound can be turned off', await shown('Sound off'));
  await clickText('Sound off');

  // All stations: the bar ticket, labelled with its station.
  await clickText('Change station');
  await shown('All stations');
  await clickText('All stations');
  check('all stations: the bar ticket, marked BAR', await shown('2× Iced tea') && (await text()).includes('BAR'));
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await viewport(w, h, w < 500);
    await sleep(300);
    check(`kitchen board: no horizontal scroll at ${w}px`, await noHorizontalScroll());
  }
  await shot('kds-390.png');
  await viewport(1440, 900);
  await clickText('fil');
  check('Filipino kitchen display', await shown('Handa na lahat (bump)'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
