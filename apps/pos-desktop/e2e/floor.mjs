// End-to-end test of the floor leftovers closed in session 16: a server works the floor without a
// drawer (no shift opened), writes a note for a course, sends the order, voids one choice of a fired
// item, sees a change made on another tablet arrive by push, and prints the bill, which tells them to
// take payment at a till. Phone width and Filipino.
// Usage: node apps/pos-desktop/e2e/floor.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview) running.
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { arrangeRestaurant, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const r = await arrangeRestaurant(API, 'flr');
const { call, email, tk } = r;

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9339 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const visible = `[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length && !x.disabled)`;
const clickExact = async (s) => {
  const find = `${visible}.find((x) => x.textContent.trim() === ${JSON.stringify(s)})`;
  await waitFor(find, 8000).catch(() => undefined);
  await evaluate(`(() => { const x = ${find}; if (!x) throw new Error('no button ' + ${JSON.stringify(s)}); x.click(); })()`);
};
const clickLabel = (label) => evaluate(`[...document.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label').startsWith(${JSON.stringify(label)}) && x.getClientRects().length).click()`);
const setValue = (id, value) => evaluate(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front')`);

  // 1. Work the floor without opening a shift.
  check('the register picker offers table service without a drawer', await shown('Work the floor'));
  await clickText('Work the floor');
  check('the floor opens with no shift: tables, and no Sell or Close shift tab', (await shown('T1')) && !(await text()).includes('Close shift'));
  const shifts = (await call('GET', '/v1/pos/workstations', tk)).data.filter((w) => w.openSession);
  check('no shift was opened on the server', shifts.length === 0);
  await clickLabel('T1 —');
  await waitFor(`document.getElementById('guests')`);
  await fill('guests', '2');
  await clickText('Open table');
  await shown('Mains');

  // 2. Order a burger with cheese; a note for course 1.
  await clickText('Burger');
  await waitFor(`document.body.innerText.includes('pick one')`);
  await clickExact('Medium');
  await clickText('Cheese');
  await clickText('Add to order');
  await shown('Not sent');
  await clickText('Course notes');
  await waitFor(`document.getElementById('course-1')`);
  await setValue('course-1', 'Allergy: no peanuts at all');
  await clickText('Save notes');
  check('the course note shows above the order', await shown('Course 1: Allergy: no peanuts at all'));
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);
  const tickets = (await call('GET', `/v1/kitchen/tickets?branchId=${r.branchId}`, tk)).data;
  check('the kitchen ticket carries the course note', tickets.some((t) => t.courseNote === 'Allergy: no peanuts at all'));

  // 3. Void the cheese alone.
  await clickLabel('Void the choice Cheese');
  await waitFor(`document.getElementById('voidReason')`);
  check('the void panel names the choice', await shown('Void the choice Cheese'));
  await fill('reason', 'No cheese after all');
  await evaluate(`document.querySelector('form .btn-danger').click()`);
  check('the cheese is struck and the subtotal is the burger alone (₱150.00)', (await waitFor(`[...document.querySelectorAll('span.line-through')].some((x) => x.textContent === 'Cheese')`).then(() => true, () => false)) && (await shown('₱150.00')));
  // A required choice cannot go alone: the server says so in words.
  await clickLabel('Void the choice Medium');
  await waitFor(`document.getElementById('voidReason')`);
  await fill('reason', 'Wants it rare');
  await evaluate(`document.querySelector('form .btn-danger').click()`);
  check('voiding the required doneness alone is refused in words', await shown('Doneness needs at least 1 choice; void the item instead'));
  await clickText('Cancel');
  await shot('floor-order.png', false);

  // 4. Another tablet adds a tea: it appears here by push (the poll is 30 s while the stream is up).
  const orderId = (await call('GET', `/v1/restaurant/orders?branchId=${r.branchId}&status=LIVE`, tk)).data[0].id;
  const t0 = Date.now();
  await call('POST', `/v1/restaurant/orders/${orderId}/items`, tk, { items: [{ variantId: r.tea, quantity: '1' }] }, { 'idempotency-key': randomUUID() });
  const pushed = await shown('1× Iced tea', 2500);
  check(`a change from another tablet arrives by push within 2.5 s (${Date.now() - t0} ms)`, pushed);
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);

  // 5. The bill prints; payment is for a till.
  await clickText('Print bill');
  await waitFor(`document.body.innerText.includes('Before printing the bill')`);
  await evaluate(`[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length && x.textContent.includes('Print bill')).at(-1).click()`);
  check('the bill is shown, and says to take payment at a till', (await shown('Bill #1')) && (await shown('Take payment at a till with an open shift')));
  check('no payment buttons without a drawer', !(await text()).includes('Take payment\n') && !(await evaluate(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.trim() === 'Take payment')`)));
  await shot('floor-bill-no-drawer.png', false);

  // 6. Phone width and Filipino.
  await viewport(390, 844, true);
  await sleep(300);
  check('390px: no horizontal scroll', await noHorizontalScroll());
  await shot('floor-390.png');
  await viewport(1440, 900);
  await clickText('fil');
  check('Filipino: the pay-at-a-till notice', await shown('Kunin ang bayad sa till'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
