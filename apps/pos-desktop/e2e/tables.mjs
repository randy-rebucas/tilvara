// End-to-end test of POS table service (ADR-0014, Phase 4 slice 6): floor → order with modifiers →
// kitchen → void → bill with service charge → split evenly → cash + card checks → table free.
// Usage: node apps/pos-desktop/e2e/tables.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview) running.
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { arrangeRestaurant, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const r = await arrangeRestaurant(API, 'tbl');
const { call, email, tk } = r;

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

  // T2 (3 guests): a burger for seat 2 and a tea for seat 3, sent.
  await clickExact('Medium');
  await clickLabel('Seat 2');
  await clickText('Add to order');
  await shown('Seat 2');
  await clickText('Drinks');
  await clickText('Iced tea');
  await waitFor(`document.body.innerText.includes('Add to order')`);
  await clickLabel('Seat 3');
  await clickText('Add to order');
  check('items carry their seats on the ticket', await shown('Seat 3') && (await text()).includes('Seat 2'));
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);

  // Move the tea to a new order on T1 (free again), then merge T2 into it.
  await clickText('Move items');
  // The panel opens once the floor is loaded: wait for the item's checkbox, not the button's own text.
  await waitFor(`[...document.querySelectorAll('label')].some((l) => l.getClientRects().length && l.textContent.includes('Iced tea') && l.querySelector('input[type=checkbox]'))`);
  await evaluate(`[...document.querySelectorAll('label')].find((l) => l.getClientRects().length && l.textContent.includes('Iced tea')).querySelector('input').click()`);
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('button.serial')].find((x) => x.getClientRects().length && x.textContent.trim() === 'T1').click()`);
  const liveNow = async () => (await call('GET', `/v1/restaurant/orders?branchId=${r.branchId}&status=LIVE`, tk)).data;
  let onT1;
  for (let i = 0; i < 25 && !onT1; i++) {
    onT1 = (await liveNow()).find((o) => o.tableId === r.tables.T1);
    if (!onT1) await sleep(200);
  }
  if (!onT1) console.log((await text()).slice(0, 1500));
  check('the tea moved to a new order on T1', Boolean(onT1) && await waitFor(`!document.body.innerText.includes('1× Iced tea')`).then(() => true, () => false));
  await clickText('Merge');
  await waitFor(`document.body.innerText.includes('Merge this order into')`);
  await evaluate(`[...document.querySelectorAll('button.serial')].find((x) => x.getClientRects().length && x.textContent.startsWith('T1')).click()`);
  check('T2 merged into T1: back on the floor, T2 free', await waitFor(`[...document.querySelectorAll('[aria-label^="T2 —"]')].some((x) => x.getAttribute('aria-label').endsWith('Free'))`).then(() => true, () => false));
  const merged = await call('GET', `/v1/restaurant/orders/${onT1.id}`, tk);
  check('T1 now has the burger and the tea', merged.items.filter((i) => i.status !== 'VOIDED').map((i) => i.name).sort().join() === 'Burger,Iced tea');

  // T1's bill: split by seat (seat 2 = the burger) and print the bill for the guests.
  await clickLabel('T1 —');
  await shown('Mains');
  await clickText('Print bill');
  await waitFor(`document.body.innerText.includes('Before printing the bill')`);
  await clickLast('Print bill');
  await shown('Bill #3');
  await clickText('By item');
  check('split by seat offers seats 2 and 3', await shown('By seat') && await evaluate(`['Seat 2', 'Seat 3'].every((s) => [...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.trim() === s))`));
  await clickExact('Seat 2');
  check('seat 2 picks the burger only', await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('ul[aria-label="By item"] label')].filter((l) => l.getClientRects().length);
    const on = boxes.filter((l) => l.querySelector('input').checked).map((l) => l.textContent.trim());
    return on.length === 1 && on[0].includes('Burger');
  })()`));
  await evaluate('window.__printed = 0; window.print = () => { window.__printed++; }');
  await clickText('Print the bill');
  check('the bill prints for the guests (not a receipt)', await waitFor('window.__printed === 1').then(() => true, () => false)
    && await evaluate(`[...document.querySelectorAll('.printable')].some((p) => p.innerText.includes('BILL - NOT AN OFFICIAL RECEIPT OR INVOICE') && p.innerText.includes('seat 2'))`));
  await shot('tables-bill-seats.png', false);
  // Leave the Tables tab on the floor (it keeps its screen across tabs).
  await clickText('Order');
  await shown('Go to the bill');
  await clickText('Floor');

  // Session 22: change an item before it is sent (quantity, course), then comp the burger on the bill.
  await waitFor(`[...document.querySelectorAll('[aria-label^="T2 —"]')].some((x) => x.getClientRects().length)`);
  await clickLabel('T2 —');
  await waitFor(`document.getElementById('guests')`);
  await fill('guests', '2');
  await clickText('Open table');
  await shown('Mains');
  await clickText('Burger');
  await waitFor(`document.body.innerText.includes('pick one')`);
  await clickExact('Medium');
  await clickText('Add to order');
  await shown('1× Burger');
  await clickText('Drinks');
  await clickText('Iced tea');
  await waitFor(`document.body.innerText.includes('Add to order')`);
  await clickText('Add to order');
  await shown('1× Iced tea');
  await clickLabel('Change Iced tea');
  await waitFor(`document.getElementById('editNote')`);
  await clickLabel('Quantity +');
  await evaluate(`[...document.querySelectorAll('[aria-label="Change Iced tea"] [aria-label="Course"] button')].find((x) => x.textContent.trim() === '2').click()`);
  await fill('editNote', 'Less ice');
  await clickText('Save changes');
  check('a pending item changes in place: quantity, course and note', await shown('2× Iced tea') && await shown('Course 2') && (await text()).includes('Less ice'));
  const t2 = (await call('GET', `/v1/restaurant/orders?branchId=${r.branchId}&status=LIVE`, tk)).data.find((o) => o.tableId === r.tables.T2);
  const tea = (await call('GET', `/v1/restaurant/orders/${t2.id}`, tk)).items.find((i) => i.name === 'Iced tea');
  check('server: the tea is ×2, course 2, still pending', tea.quantity === '2' && tea.course === 2 && tea.note === 'Less ice' && tea.status === 'PENDING');
  await clickText('Send to kitchen');
  await waitFor(`!document.body.innerText.includes('Not sent')`);
  await clickText('Print bill');
  await waitFor(`document.body.innerText.includes('Before printing the bill')`);
  await clickText('Discount an item');
  await waitFor(`document.getElementById('itemDiscountReason')`);
  await evaluate(`(() => {
    const s = document.getElementById('discountItem');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, [...s.options].find((o) => o.textContent.includes('Burger')).value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await fill('itemDiscountReason', 'Overcooked');
  await clickLast('Apply');
  check('the comp is listed with its reason', await shown('On the house') && (await text()).includes('Overcooked'));
  await shot('tables-comp.png', false);
  await clickLast('Print bill');
  // Burger comped; teas 2 × 45 = 90; service charge 10 % (8.04 + VAT 0.96) → ₱99.00.
  check('bill #4: the burger on the house, ₱99.00 with the service charge', await shown('Bill #4') && await shown('₱99.00') && (await text()).includes('Discount'));
  const bill4 = (await call('GET', `/v1/restaurant/orders/${t2.id}`, tk)).bill;
  const billed = await call('GET', `/v1/restaurant/bills/${bill4.id}`, tk);
  check('server: the burger line is discounted in full', billed.lines.find((l) => l.name === 'Burger' && !l.parentLineId).discount === '150.00' && billed.amountDue === '99.00');
  await clickText('Order');
  await shown('Go to the bill');
  await clickText('Floor');

  // Audit 2026-10-21: a customer on a check. Rosa has ₱45.00 of store credit (a counter tea, cash,
  // returned to her credit through the API); she pays T2's bill #4 (₱99.00) with it and ₱54.00 in cash.
  const idem = () => ({ 'idempotency-key': randomUUID() });
  const rosa = await call('POST', '/v1/customers', tk, { displayName: 'Rosa Lim', phone: '0917 555 0199' });
  const teaSale = await call('POST', '/v1/sales', tk, { cashierSessionId: ws.openSession.id, clientTransactionId: randomUUID(), customerId: rosa.id, lines: [{ variantId: r.tea, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '45.00' }] }, idem());
  await call('POST', `/v1/sales/${teaSale.id}/returns`, tk, { cashierSessionId: ws.openSession.id, kind: 'RETURN', reason: 'Changed her mind', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: teaSale.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }, idem());
  await waitFor(`[...document.querySelectorAll('[aria-label^="T2 —"]')].some((x) => x.getClientRects().length)`);
  await clickLabel('T2 —');
  await shown('Go to the bill');
  await clickText('Go to the bill');
  await shown('Bill #4');
  await clickExact('Customer');
  await waitFor(`document.getElementById('custSearch')`);
  await fill('custSearch', 'Rosa');
  await evaluate(`void [...document.querySelectorAll('form')].find((f) => f.querySelector('[name=custSearch]')).requestSubmit()`);
  await waitFor(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim'))`, 10000);
  await evaluate(`void [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Rosa Lim')).click()`);
  check('the customer is on the check, with ₱45.00 of store credit', await waitFor(`document.querySelector('[data-testid=check-customer]')?.innerText.includes('Rosa Lim') && document.querySelector('[data-testid=check-customer]').innerText.includes('₱45.00')`, 10000).then(() => true, () => false));
  await clickText('Use store credit');
  check('the credit pays ₱45.00; ₱54.00 is left for cash', await waitFor(`document.querySelector('[data-testid=check-customer]').innerText.includes('Paid with store credit') && [...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.trim() === '₱54.00')`, 8000).then(() => true, () => false));
  await shot('tables-check-customer.png', false);
  await clickExact('₱100.00');
  check('change ₱46.00 on the cash part', await shown('₱46.00'));
  await clickText('Take payment');
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const rc = await text();
  check('the check receipt names the customer and the store credit tender', rc.includes('Rosa Lim') && rc.includes('STORE CREDIT'));
  check('the credit check settles bill #4', await shown('The bill is paid'));
  const creditCheck = (await call('GET', `/v1/sales?cashierSessionId=${ws.openSession.id}`, tk)).data.find((s) => s.amountDue === '99.00');
  check('server: the ₱99.00 check is recorded and her credit is spent', Boolean(creditCheck) && (await call('GET', `/v1/customers/${rosa.id}`, tk)).storeCredit[0].balance === '0.00');
  await clickText('Back to the floor');
  await waitFor(`document.body.innerText.includes('T1')`);

  // Void that check from the shift's history: the bill is to pay again, the credit comes back.
  await clickText('This shift');
  await waitFor(`[...document.querySelectorAll('main li button')].some((x) => x.getClientRects().length && x.textContent.includes('#' + ${JSON.stringify(String(creditCheck?.saleNumber ?? 0).padStart(6, '0'))}))`, 10000);
  await evaluate(`void [...document.querySelectorAll('main li button')].find((x) => x.getClientRects().length && x.textContent.includes('#' + ${JSON.stringify(String(creditCheck?.saleNumber ?? 0).padStart(6, '0'))})).click()`);
  await shown('Rosa Lim', 10000);
  await clickExact('Void sale');
  await waitFor(`[...document.querySelectorAll('input[name=reason]')].some((x) => x.getClientRects().length)`);
  await evaluate(`(() => { const el = [...document.querySelectorAll('input[name=reason]')].find((x) => x.getClientRects().length); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Wrong table'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`void [...document.querySelectorAll('form .btn-danger')].find((x) => x.getClientRects().length).click()`);
  const voidedMsg = await waitFor(`document.body.innerText.includes('Store credit given: ₱45.00')`, 10000).then(() => true, () => false);
  if (!voidedMsg) console.log((await text()).slice(0, 1500));
  check('voided: ₱45.00 back to her credit, ₱54.00 back in cash', voidedMsg && (await text()).includes('Refund ₱54.00 in cash'));
  check('server: her store credit is ₱45.00 again', (await call('GET', `/v1/customers/${rosa.id}`, tk)).storeCredit[0].balance === '45.00');
  await clickText('Tables');
  await waitFor(`[...document.querySelectorAll('[aria-label^="T2 —"]')].some((x) => x.getClientRects().length)`);
  check('floor: T2 is to pay again', await waitFor(`[...document.querySelectorAll('[aria-label^="T2 —"]')].some((x) => x.getClientRects().length && !x.getAttribute('aria-label').endsWith('Free'))`, 8000).then(() => true, () => false));
  await clickLabel('T2 —');
  await shown('Go to the bill');
  await clickText('Go to the bill');
  check(`the bill is payable again: "Check #${creditCheck?.saleNumber} was voided…"`, await shown('Bill #4') && await shown('was voided: its share is to be paid again') && (await text()).includes('₱99.00'));
  await shot('tables-check-voided.png', false);
  await clickText('Order');
  await shown('Go to the bill');
  await clickText('Floor');

  // The drawer: 1000 + 236.50 (cash check) + 45 (the tea sale; its return went to credit); the
  // voided check's ₱54.00 came in and went back out.
  await clickText('Close shift');
  check('expected drawer ₱1,281.50', await shown('₱1,281.50'));

  await clickText('fil');
  await clickText('Mga mesa');
  // Both tables end billed (T1 by seat, T2 with the comp), so the floor reads "Babayaran" (to pay).
  check('Filipino floor', await shown('Babayaran') || await shown('Bakante') || await shown('Bukas'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
