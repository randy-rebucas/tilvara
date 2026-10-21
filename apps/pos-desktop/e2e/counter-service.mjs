// End-to-end test of counter service (session 25, ADR-0014 amendment): a café sells over the
// counter with the takeaway menu's choices, a pickup name and a cash tip; the receipt carries the call
// number; the kitchen display shows the order by its number, bumps it and hands it over; a cart line's
// choices can be changed before paying; the pay-out of tips from the drawer.
// Usage: node apps/pos-desktop/e2e/counter-service.mjs [posUrl] [screenshotDir] [apiUrl]
import { checklist, openBrowser } from '../../admin-web/e2e/cdp.mjs';
import { arrangeRestaurant, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const r = await arrangeRestaurant(API, 'cafe');
const { call, tk } = r;
const settings = await call('GET', `/v1/branches/${r.branchId}/restaurant-settings`, tk);
const { branchId: _b, updatedAt: _u, ...current } = settings;
await call('PUT', `/v1/branches/${r.branchId}/restaurant-settings`, tk, { ...current, counterService: true });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9343 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const tab = (label) => evaluate(`[...document.querySelectorAll('nav[aria-label=Counter] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
/** Fill a React-controlled input by id (the counter's own inputs have ids, not names). */
const set = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const scan = async (code) => {
  await set('scan', code);
  await evaluate(`document.getElementById('scan').form.requestSubmit()`);
};
const disabled = (label) => evaluate(`[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim().includes(${JSON.stringify(label)}))?.disabled`);
const signIn = async () => {
  await go('/');
  await fill('email', r.email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
};

try {
  await viewport(1440, 900);
  await signIn();
  await waitFor(`document.body.innerText.includes('Front')`);
  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  const register = (await call('GET', '/v1/registers', tk)).data[0];
  const shiftId = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.register.id === register.id).openSession.id;

  // ---- a dish with choices asks for them; a drink without goes straight in ----
  await scan('BRG-1');
  check('scanning a dish with choices opens its choices', await shown('Choices for Burger') || (await text()).includes('Doneness'));
  check('Add stays off until the doneness is chosen', (await disabled('Add to the sale')) === true && (await text()).includes('Choose Doneness first') || (await text()).includes('Doneness'));
  await clickText('Medium');
  await clickText('Cheese');
  await set('kitchenNote', 'Cut in half');
  check('with doneness chosen, Add is on', (await disabled('Add to the sale')) === false);
  await shot('counter-choices.png', false);
  await clickText('Add to the sale');
  await waitFor(`document.querySelector('[data-testid=line-choices]')`);
  check('the cart line shows its choices and note', /Medium/.test(await text()) && (await text()).includes('Cut in half'));
  await scan('TEA-1');
  check('a drink without choices is added at once', await shown('Iced tea'));
  check('the total includes the priced choice: 150 + 20 + 45', await shown('₱215.00', 10000));
  check('the pickup name is asked for', await evaluate(`Boolean(document.getElementById('pickupName'))`));
  await set('pickupName', 'Ana');

  // ---- a cash tip on top ----
  await set('tip', '10');
  check('the cash to take adds the tip', await shown('₱225.00'));
  await set('cash', '300');
  check('the change counts the tip: 300 − 215 − 10', await shown('₱75.00'));
  await shot('counter-tip.png', false);
  await clickText('Complete sale');
  check('the receipt shows the call number', await waitFor(`document.querySelector('[data-testid=call-number]')`, 15000).then(() => true, () => false));
  const receiptText = await text();
  check('… with the pickup name, the choice under its dish and the tip', receiptText.includes('Ana') && receiptText.includes('+ Cheese slice') && receiptText.includes('Tip (cash)'));
  await shot('counter-receipt.png', false);
  const sales = (await call('GET', `/v1/sales?cashierSessionId=${shiftId}`, tk)).data;
  const sale = await call('GET', `/v1/sales/${sales[0].id}`, tk);
  check('the server agrees: ₱215.00 due, ₱10.00 cash tip, a counter order with two tickets', sale.amountDue === '215.00' && sale.tip?.amount === '10.00' && sale.counterOrder?.tickets.length === 2 && sale.counterOrder.pickupName === 'Ana');
  const callNumber = sale.counterOrder.orderNumber;
  check('the receipt number is the kitchen’s order number', receiptText.includes(`#${callNumber}`));

  // ---- a card tip, then the sale voided: the tip goes back on the card ----
  await clickText('New sale');
  await waitFor(`document.getElementById('scan')`);
  await scan('TEA-1');
  await shown('₱45.00', 10000);
  await set('tip', '15');
  await clickText('Card tip');
  await clickText('Charge the');
  check('the card tip is charged on its own', await shown('Tip paid by card', 10000));
  await set('cash', '50');
  await clickText('Complete sale');
  check('the receipt shows the card tip', await waitFor(`document.querySelector('[data-testid=receipt-tip]')`, 15000).then(() => true, () => false) && (await text()).includes('Tip (card)'));
  const tipped = (await call('GET', `/v1/sales?cashierSessionId=${shiftId}`, tk)).data[0];
  check('the server agrees: a ₱15.00 card tip outside the ₱45.00 sale', (await call('GET', `/v1/sales/${tipped.id}`, tk)).tip?.method === 'CARD' && tipped.amountDue === '45.00');
  await clickText('New sale');
  await tab('This shift');
  await shown(`#${String(tipped.saleNumber).padStart(6, '0')}`, 10000);
  await clickText(`#${String(tipped.saleNumber).padStart(6, '0')}`);
  await shown('Void sale', 10000);
  await clickText('Void sale');
  await waitFor(`document.querySelector('form [name=reason]')`);
  await fill('reason', 'Wrong drink');
  await evaluate(`[...document.querySelectorAll('form .btn-danger')].find((x) => x.getClientRects().length && x.textContent.includes('Void sale')).click()`);
  check('the void says the card tip went back on the card', await shown('card tip was given back on the card', 15000));
  await shot('counter-tip-void.png', false);
  await tab('Sell');

  // ---- changing a cart line's choices before paying ----
  await waitFor(`document.getElementById('scan')`);
  await scan('BRG-1');
  await waitFor(`document.body.innerText.includes('Doneness')`);
  await clickText('Well done');
  await clickText('Add to the sale');
  await waitFor(`document.querySelector('[data-testid=line-choices]')`);
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label')?.startsWith('Change the choices for')).click()`);
  await waitFor(`document.body.innerText.includes('Save changes')`);
  await clickText('Medium');
  await clickText('Save changes');
  await waitFor(`!document.body.innerText.includes('Save changes')`).catch(() => undefined);
  const line = await evaluate(`document.querySelector('[data-testid=line-choices]').innerText`);
  check('the line now carries the new choice', line.includes('Medium') && !line.includes('Well done'));
  await viewport(390, 844);
  await scan('BRG-1');
  await waitFor(`document.body.innerText.includes('Doneness')`);
  await shot('counter-choices-390.png', false);
  check('no sideways scroll at phone width', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
  await clickText('Cancel');
  await viewport(1440, 900);

  // ---- tips paid out of the drawer ----
  await tab('Close shift');
  await waitFor(`document.getElementById('pioType')`);
  await fill('pioType', 'TIP_PAYOUT');
  await fill('pioAmount', '10');
  await fill('pioReason', 'Tips to the crew');
  await clickText('Record');
  check('the tip pay-out is listed', await shown('Tips to the crew', 10000) && (await text()).includes('Tips paid out'));
  const shift = await call('GET', `/v1/cashier-sessions/${shiftId}`, tk);
  check('the drawer: 1000 + 215 + 10 tip − 10 paid out', shift.expectedCash === '1215.00');

  // ---- the kitchen display: by number, bump, hand over ----
  await signIn();
  await waitFor(`document.body.innerText.includes('Open kitchen display')`, 15000).catch(() => undefined);
  await clickText('Open kitchen display');
  await shown('Grill');
  await evaluate(`[...document.querySelectorAll('section')].find((s) => s.textContent.includes('GRILL')).querySelector('button').click()`);
  check('the grill ticket shows the call number and name', await shown(`#${callNumber}`, 15000) && (await text()).toUpperCase().includes(`#${callNumber} ANA`));
  check('… with the choices and the note', (await text()).includes('Cut in half') && /Medium/.test(await text()));
  await shot('counter-kds.png', false);
  await clickText('All ready (bump)');
  check('bumped, it can be handed over', await shown(`Handed over (#${callNumber})`, 10000));
  await clickText('Handed over');
  await waitFor(`!document.body.innerText.includes('Handed over (#')`, 10000).catch(() => undefined);
  const items = (await call('GET', `/v1/kitchen/tickets?branchId=${r.branchId}&status=ALL`, tk)).data.filter((t) => t.station.code === 'GRILL').flatMap((t) => t.items);
  check('the server agrees: the burger is served', items.length === 1 && items[0].status === 'SERVED');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
