// End-to-end test of POS table service (ADR-0014, Phase 4 slice 6): floor → order with modifiers →
// kitchen → void → bill with service charge → split evenly → cash + card checks → table free.
// Usage: node apps/pos-desktop/e2e/tables.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview) running.
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { arrangeRestaurant, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const { call, email, tk } = await arrangeRestaurant(API, 'tbl');

// --- drive the floor
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9337 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const visible = `[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length && !x.disabled)`;
/** A visible button whose whole text is exactly `s` (the ways "2", a table code). */
const clickExact = async (s) => {
  // Waits until it is enabled: payment buttons stay disabled until the server has priced the check.
  const find = `${visible}.find((x) => x.textContent.trim() === ${JSON.stringify(s)})`;
  await waitFor(find, 8000).catch(() => undefined);
  await evaluate(`(() => { const x = ${find}; if (!x) throw new Error('no button ' + ${JSON.stringify(s)}); x.click(); })()`);
};
/** The last visible button containing `s` (the panel that just opened sits below the first match). */
const clickLast = (s) => evaluate(`(() => { const x = ${visible}.filter((x) => x.textContent.includes(${JSON.stringify(s)})).at(-1); if (!x) throw new Error('no button ' + ${JSON.stringify(s)}); x.click(); })()`);
const clickLabel = (label) => evaluate(`[...document.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label').startsWith(${JSON.stringify(label)}) && x.getClientRects().length).click()`);

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

  // Floor
  await clickExact('Tables');
  check('floor shows both tables free', await shown('T2') && (await text()).match(/Free/g)?.length >= 2);
  await shot('tables-floor.png', false);
  await clickLabel('T1 —');
  await waitFor(`document.getElementById('guests')`);
  await fill('guests', '2');
  await clickText('Open table');
  check('table opened: order screen with the menu', await shown('Mains') && await shown('Tap a menu item'));

  // A burger with a required choice and a priced extra, ×2
  await clickText('Burger');
  await waitFor(`document.body.innerText.includes('pick one')`);
  check('composer asks for the required choice first', await evaluate(`${visible.replace('&& !x.disabled', '')}.find((x) => x.textContent.trim() === 'Add to order').disabled`));
  await clickExact('Medium');
  await clickText('Cheese');
  await clickLabel('Quantity +');
  await clickText('Add to order');
  check('burger ×2 with its choices is on the order, not yet sent', await shown('2× Burger') && (await text()).includes('Medium · Cheese') && (await text()).includes('Not sent'));
  check('server-priced subtotal ₱340.00 (2 × 150 + 2 × 20)', await shown('₱340.00'));
  await clickText('Drinks');
  await clickText('Iced tea');
  await waitFor(`document.body.innerText.includes('Add to order')`);
  await clickLabel('Quantity +');
  await clickText('Add to order');
  check('subtotal ₱430.00 with two iced teas', await shown('₱430.00'));
  await shot('tables-order.png', false);
  await clickText('Send to kitchen');
  check('items sent to the kitchen', await waitFor(`!document.body.innerText.includes('Not sent')`).then(() => true, () => false) && (await text()).includes('Sent'));

  // One more tea by mistake: sent, then voided (not cooked, nothing written off)
  await clickText('Iced tea');
  await waitFor(`document.body.innerText.includes('Add to order')`);
  await clickText('Add to order');
  await shown('Not sent');
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);
  await clickLast('Void');
  await waitFor(`document.getElementById('voidReason')`);
  await fill('reason', 'Ordered twice');
  await evaluate(`document.querySelector('form .btn-danger').click()`);
  check('the extra tea is voided with its reason; subtotal back to ₱430.00', await shown('Ordered twice') && await shown('₱430.00'));
  await clickText('Served');
  await sleep(300);

  // Bill: items ₱430 + service charge 10 % (38.39 + VAT 4.61) = ₱473.00
  await clickText('Print bill');
  await waitFor(`document.body.innerText.includes('Before printing the bill')`);
  await clickLast('Print bill');
  check('bill #1: ₱473.00 with the service charge on its own line', await shown('Bill #1') && await shown('₱473.00') && (await text()).includes('Service charge 10%'));
  await shot('tables-bill.png', false);

  // Split evenly between two: ₱236.50 each, first in cash, then the rest by card
  await clickText('Split evenly');
  await clickExact('2');
  const previewed = await waitFor(`[...document.querySelectorAll('.money')].some((x) => x.getClientRects().length && x.textContent === '₱236.50')`).then(() => true, () => false);
  if (!previewed) console.log(await text());
  check('this check: ₱236.50 (server preview)', previewed);
  await clickText('₱250.00');
  check('change ₱13.50', await shown('₱13.50'));
  await clickText('Take payment');
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const r1 = await text();
  check('check 1 receipt R1-000001 prints the service charge line', r1.includes('R1-000001') && r1.includes('Service charge 10%'));
  await shot('tables-receipt.png');
  check('₱236.50 left to pay', r1.includes('Left to pay') && r1.includes('₱236.50'));
  await clickText('Next check');
  check('last part pays what is left (₱236.50)', await shown('Last part') && await waitFor(`[...document.querySelectorAll('.money')].some((x) => x.getClientRects().length && x.textContent === '₱236.50')`).then(() => true, () => false));
  await clickExact('Card');
  await shown('Approved');
  await clickText('Take payment');
  check('second check settles the bill; the table is free', await shown('The bill is paid'));
  await clickText('Back to the floor');
  await waitFor(`document.body.innerText.includes('T1')`);
  check('floor: T1 free again', await evaluate(`[...document.querySelectorAll('[aria-label^="T1 —"]')].some((x) => x.getAttribute('aria-label').endsWith('Free'))`));
  const ws = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.openSession?.mine);
  const sales = (await call('GET', `/v1/sales?cashierSessionId=${ws.openSession.id}`, tk)).data;
  check('server: two checks of ₱236.50 on the shift', sales.length === 2 && sales.every((s) => s.amountDue === '236.50'));

  // Takeaway: no service charge; billed and left open
  await clickText('Takeaway');
  await waitFor(`document.getElementById('customerName')`);
  await fill('customerName', 'Ana');
  await clickText('Start takeaway');
  await shown('Drinks');
  await clickText('Drinks');
  await clickText('Iced tea');
  await clickText('Add to order');
  await shown('Not sent');
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);
  await clickText('Print bill');
  await waitFor(`document.body.innerText.includes('Before printing the bill')`);
  await clickLast('Print bill');
  check('takeaway bill #2 ₱45.00 without a service charge', await shown('Bill #2') && (await text()).includes('₱45.00') && !(await text()).includes('Service charge'));
  await clickText('Order');
  check('back on the order: billed, nothing can be added', await shown('Go to the bill'));
  await clickText('Floor');
  check('floor lists the billed takeaway for Ana', await shown('Ana') && /#2\s+Ana\s+To pay/.test(await text()));

  // Layout
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await viewport(w, h, w < 500);
    await sleep(300);
    check(`floor: no horizontal scroll at ${w}px`, await noHorizontalScroll());
  }
  await shot('tables-floor-390.png');
  await clickLabel('T2 —');
  await fill('guests', '3');
  await clickText('Open table');
  await shown('Mains');
  await clickText('Burger');
  await sleep(300);
  check('order + composer: no horizontal scroll at 390px', await noHorizontalScroll());
  await shot('tables-order-390.png');
  await viewport(1440, 900);

  // The drawer took the cash check only: 1000 + 236.50
  await clickText('Close shift');
  check('expected drawer ₱1,236.50', await shown('₱1,236.50'));

  await clickText('fil');
  await clickText('Mga mesa');
  check('Filipino floor', await shown('Bakante') || await shown('Bukas'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
