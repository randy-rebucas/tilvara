// Phase 4 exit review: the SPEC restaurant scenarios 1–10 as one service, through the real screens of
// one tenant. The admin configures the menu, recipe and service charge; the floor opens a table, orders
// with choices and sends; the kitchen display cooks and bumps; the floor serves, bills, splits and takes
// cash and card; the admin reads consumption, the books and the reports; the shift closes balanced.
// Usage: node apps/pos-desktop/e2e/service.mjs [posUrl] [adminUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false), the POS (vite preview) and the admin (next start).
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const POS = process.argv[2] ?? 'http://127.0.0.1:3330';
const ADMIN = process.argv[3] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[4] ?? '.impeccable/review/service';
const API = process.argv[5] ?? 'http://127.0.0.1:4320';

// --- the business and its stock (set-up the earlier phases cover); the restaurant itself is configured in the admin below
const call = client(API);
const slug = `svc-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const tk = (await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lito Santos', businessName: 'Kainan ni Lito', tenantSlug: slug })).tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Lito Santos Foods', tradeName: 'Kainan ni Lito', tin: '234-567-891', vatStatus: 'VAT' });
const branchId = (await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Makati' })).id;
await call('POST', '/v1/registers', tk, { branchId, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const uoms = (await call('GET', '/v1/uoms', tk)).data;
const uom = (c) => uoms.find((u) => u.code === c).id;
const product = async (name, sku, price, trackInventory, unit = 'PC') =>
  (await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: uom(unit), trackInventory, ...(unit === 'KG' && { soldBy: 'WEIGHT' }), variants: [{ sku, price }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const burger = await product('Burger', 'BRG-1', '150.00', false);
const tea = await product('Iced tea', 'TEA-1', '45.00', false);
const bun = await product('Bun', 'BUN-1', '10.00', true);
const beef = await product('Ground beef', 'BEEF-1', '500.00', true, 'KG');
const cheese = await product('Cheese slice', 'CHZ-1', '20.00', true);
await call('POST', '/v1/stock/adjustments', tk, { branchId, reason: 'Opening', items: [
  { variantId: bun, quantity: '50', unitCost: '5.00' }, { variantId: beef, quantity: '5', unitCost: '400.00' }, { variantId: cheese, quantity: '40', unitCost: '3.00' },
] });
await call('POST', '/v1/kitchen-stations', tk, { branchId, code: 'GRILL', name: 'Grill', isDefault: true });
await call('POST', '/v1/kitchen-stations', tk, { branchId, code: 'BAR', name: 'Bar' });
const area = await call('POST', '/v1/dining-areas', tk, { branchId, name: 'Hall' });
await call('POST', '/v1/restaurant-tables', tk, { areaId: area.id, code: 'T1', seats: 4 });
await call('POST', '/v1/modifier-groups', tk, { name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] });
await call('POST', '/v1/modifier-groups', tk, { name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] });
const balance = async (variantId) => (await call('GET', `/v1/stock/balances?branchId=${branchId}`, tk)).data.find((x) => x.variantId === variantId)?.quantity;

const { check, finish } = checklist();
const admin = await openBrowser({ base: ADMIN, out: OUT, port: 9341 });
const floor = await openBrowser({ base: POS, out: OUT, port: 9342 });
const kds = await openBrowser({ base: POS, out: OUT, port: 9343 });
const helpers = (b) => {
  const text = () => b.evaluate('document.body.innerText');
  const shown = (s, ms) => b.waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
  const visible = `[...document.querySelectorAll('button')].filter((x) => x.getClientRects().length && !x.disabled)`;
  const clickExact = async (s) => {
    const find = `${visible}.find((x) => x.textContent.trim() === ${JSON.stringify(s)})`;
    await b.waitFor(find, 8000).catch(() => undefined);
    await b.evaluate(`(() => { const x = ${find}; if (!x) throw new Error('no button ' + ${JSON.stringify(s)}); x.click(); })()`);
  };
  const clickLast = (s) => b.evaluate(`(() => { const x = ${visible}.filter((x) => x.textContent.includes(${JSON.stringify(s)})).at(-1); if (!x) throw new Error('no button ' + ${JSON.stringify(s)}); x.click(); })()`);
  const clickLabel = (label) => b.evaluate(`[...document.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label').startsWith(${JSON.stringify(label)}) && x.getClientRects().length).click()`);
  return { text, shown, clickExact, clickLast, clickLabel };
};
const A = helpers(admin);
const F = helpers(floor);
const K = helpers(kds);
const money = (b, s) => b.waitFor(`[...document.querySelectorAll('.money')].some((x) => x.getClientRects().length && x.textContent === ${JSON.stringify(s)})`).then(() => true, () => false);

try {
  // ---- 1. Configure menu items and recipes (admin)
  await admin.viewport(1440, 900);
  await admin.go('/sign-in');
  await admin.fill('email', email);
  await admin.fill('password', PASSWORD);
  await admin.evaluate(`document.querySelector('form button.btn-primary').click()`);
  await admin.waitFor(`document.body.innerText.includes('Overview')`);
  const panelSubmit = async () => {
    const forms = `[...document.querySelectorAll('form')].filter((f) => f.getClientRects().length).length`;
    const before = await admin.evaluate(forms);
    await admin.evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
    await admin.waitFor(`(${forms}) < ${before}`).catch(() => undefined);
  };
  await admin.go('/restaurant/menus');
  await admin.evaluate('window.confirm = () => true');
  await admin.clickText('New menu');
  await admin.waitFor(`[...document.querySelectorAll('[name="name"]')].some((x) => x.getClientRects().length)`);
  await admin.fill('name', 'All day');
  await panelSubmit();
  await admin.waitFor(`location.pathname.startsWith('/restaurant/menus/')`);
  await admin.evaluate('window.confirm = () => true');
  await admin.clickText('Add section');
  await admin.fill('sections.0.name', 'Mains');
  await admin.clickText('Add item');
  await admin.waitFor(`document.querySelector('[name="sections.0.items.0.variantId"]')`);
  await admin.fill('sections.0.items.0.variantId', burger);
  await admin.fill('sections.0.items.0.stationCode', 'GRILL');
  for (const g of ['Doneness', 'Extras']) await admin.evaluate(`[...document.querySelectorAll('label')].find((l) => l.textContent.trim() === ${JSON.stringify(g)}).querySelector('input').click()`);
  await admin.clickText('Add section');
  await admin.waitFor(`document.querySelector('[name="sections.1.name"]')`);
  await admin.fill('sections.1.name', 'Drinks');
  await A.clickLast('Add item');
  await admin.waitFor(`document.querySelector('[name="sections.1.items.0.variantId"]')`);
  await admin.fill('sections.1.items.0.variantId', tea);
  await admin.fill('sections.1.items.0.stationCode', 'BAR');
  await admin.clickText('Save draft');
  await admin.waitFor(`!document.body.innerText.includes('Unsaved changes')`);
  await admin.clickText('Publish');
  check('1. admin: menu "All day" published (Mains → Burger with Doneness + Extras at GRILL, Drinks → Iced tea at BAR)', await admin.waitFor(`document.body.innerText.toLowerCase().includes('published · v1')`).then(() => true, () => false));

  await admin.go('/restaurant/recipes');
  await admin.evaluate('window.confirm = () => true');
  await admin.clickText('Burger');
  await admin.waitFor(`document.body.innerText.includes('No recipe yet')`);
  await admin.clickText('New recipe version');
  await admin.waitFor(`document.querySelector('[name="lines.0.variantId"]')`);
  await admin.fill('lines.0.variantId', bun);
  await admin.fill('lines.0.quantity', '1');
  await admin.clickText('Add line');
  await admin.waitFor(`document.querySelector('[name="lines.1.variantId"]')`);
  await admin.fill('lines.1.variantId', beef);
  await admin.fill('lines.1.quantity', '0.15');
  await panelSubmit();
  check('1. admin: burger recipe in force (1 bun + 0.15 kg beef)', await A.shown('In force') && (await A.text()).includes('0.15'));

  await admin.go(`/restaurant/settings?branch=${branchId}`);
  const menuId = (await admin.evaluate(`fetch('/api/v1/menus').then((r) => r.json())`)).data[0].id;
  await admin.fill('dineInMenuId', menuId);
  await admin.fill('takeawayMenuId', menuId);
  await admin.fill('rate', '10');
  await admin.evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  check('1. admin: branch serves the menu with a 10% service charge on dine-in', await A.shown('Saved.'));

  // ---- 2. Open a table (floor)
  await floor.viewport(1440, 900);
  await floor.go('/');
  await floor.fill('email', email);
  await floor.fill('password', PASSWORD);
  await floor.evaluate(`document.querySelector('form button.btn-primary').click()`);
  await floor.waitFor(`document.body.innerText.includes('Front')`);
  await floor.clickText('Open shift');
  await floor.waitFor(`document.getElementById('float')`);
  await floor.fill('float', '1000');
  await floor.evaluate(`document.querySelector('form button.btn-primary').click()`);
  await floor.waitFor(`document.getElementById('scan')`);
  await F.clickExact('Tables');
  await F.shown('T1');
  await F.clickLabel('T1 —');
  await floor.waitFor(`document.getElementById('guests')`);
  await floor.fill('guests', '2');
  await floor.clickText('Open table');
  check('2. floor: T1 opened for 2 with the menu the admin published', await F.shown('Mains') && (await F.text()).includes('Drinks'));

  // ---- 3. An order with modifiers
  await floor.clickText('Burger');
  await F.shown('pick one');
  await F.clickExact('Medium');
  await floor.clickText('Cheese');
  await F.clickLabel('Quantity +');
  await floor.clickText('Add to order');
  await F.shown('2× Burger');
  await floor.clickText('Drinks');
  await floor.clickText('Iced tea');
  await F.shown('Add to order');
  await F.clickLabel('Quantity +');
  await floor.clickText('Add to order');
  check('3. floor: 2× burger (Medium · Cheese) + 2× iced tea, ₱430.00 priced by the server', await F.shown('₱430.00') && (await F.text()).includes('Medium · Cheese'));

  // ---- 4. Route to kitchen stations
  await floor.clickText('Send to kitchen');
  await floor.waitFor(`!document.body.innerText.includes('Not sent')`);
  await kds.viewport(1440, 900);
  await kds.go('/');
  await kds.fill('email', email);
  await kds.fill('password', PASSWORD);
  await kds.evaluate(`document.querySelector('form button.btn-primary').click()`);
  await K.shown('Open kitchen display');
  await kds.clickText('Open kitchen display');
  await K.shown('GRILL');
  await kds.evaluate(`[...document.querySelectorAll('section')].find((s) => s.textContent.includes('GRILL')).querySelector('button').click()`);
  check('4. kitchen: the grill gets the burgers with their choices, not the tea', await K.shown('2× Burger') && (await K.text()).includes('Medium · Cheese') && !(await K.text()).includes('Iced tea'));
  await kds.shot('service-kds-grill.png', false);

  // ---- 5. Preparation statuses
  await kds.clickText('Start');
  await K.shown('Cooking');
  await kds.clickText('All ready (bump)');
  await kds.waitFor(`!document.body.innerText.includes('All ready (bump)')`);
  await kds.clickText('Change station');
  await K.shown('BAR');
  await kds.evaluate(`[...document.querySelectorAll('section')].find((s) => s.textContent.includes('BAR')).querySelector('button').click()`);
  await K.shown('2× Iced tea');
  await kds.clickText('All ready (bump)');
  await kds.waitFor(`!document.body.innerText.includes('All ready (bump)')`);
  check('5. floor: both items show Ready after the kitchen bumped them (by polling)', await floor.waitFor(`document.body.innerText.match(/\\bReady\\b/g)?.length >= 2`, 12000).then(() => true, () => false));
  for (let i = 0; i < 2; i++) {
    await F.clickExact('Served');
    await sleep(500);
  }
  check('5. kitchen: served food leaves the board', await K.shown('No tickets', 12000));

  // ---- 6. Split the bill
  await floor.clickText('Print bill');
  await F.shown('Before printing the bill');
  await F.clickLast('Print bill');
  check('6. floor: bill #1 ₱473.00 with the service charge line', await F.shown('Bill #1') && await F.shown('₱473.00') && (await F.text()).includes('Service charge 10%'));
  await floor.clickText('Split evenly');
  await F.clickExact('2');
  check('6. floor: split evenly, this check ₱236.50 (server preview)', await money(floor, '₱236.50'));

  // ---- 7. Settle payments
  await floor.clickText('₱250.00');
  await F.shown('₱13.50');
  await floor.clickText('Take payment');
  await F.shown('NOT AN OFFICIAL INVOICE');
  check('7. floor: check 1 paid in cash (change ₱13.50), receipt with the service charge', (await F.text()).includes('Service charge 10%') && (await F.text()).includes('R1-000001'));
  await floor.clickText('Next check');
  await money(floor, '₱236.50');
  await F.clickExact('Card');
  await F.shown('Approved');
  await floor.clickText('Take payment');
  check('7. floor: check 2 paid by card; the bill is settled', await F.shown('The bill is paid'));
  await floor.clickText('Back to the floor');
  check('7. floor: T1 free again', await floor.waitFor(`[...document.querySelectorAll('[aria-label^="T1 —"]')].some((x) => x.getAttribute('aria-label').endsWith('Free'))`).then(() => true, () => false));

  // ---- 8. Stock consumption (2 burgers = 2 buns + 0.3 kg beef; 2 cheese slices sold as choices)
  check('8. stock: buns 50 → 48, beef 5 → 4.7 kg, cheese 40 → 38', [await balance(bun), await balance(beef), await balance(cheese)].join() === '48,4.7,38');
  await admin.go(`/reports/ingredient-usage?branch=${branchId}`);
  await A.shown('Over expected');
  check('8. admin: ingredient usage — bun 2 expected = 2 actual, beef 0.3 = 0.3, no over-use', /Bun[\s\S]*2 PC[\s\S]*2 PC/.test(await A.text()) && /Ground beef[\s\S]*0\.3 KG[\s\S]*0\.3 KG/.test(await A.text()));
  await admin.shot('service-usage.png');

  // ---- 9. Accounting and reporting
  await admin.go(`/reports?branch=${branchId}`);
  await A.shown('Item performance');
  check('9. admin: item performance — burger ₱300.00, its cheese ₱40.00, tea ₱90.00, total ₱430.00', /Burger[\s\S]*₱300\.00[\s\S]*Cheese[\s\S]*₱40\.00/.test(await A.text()) && /Iced tea[\s\S]*₱90\.00/.test(await A.text()) && (await A.text()).includes('₱430.00'));
  await admin.go(`/reports/service-charge?branch=${branchId}`);
  await A.shown('To distribute');
  check('9. admin: service charge ₱43.00, ₱38.39 to distribute, equal to the books', (await A.text()).includes('₱43.00') && (await A.text()).includes('₱38.39') && (await A.text()).includes('Equals the service charge liability'));
  await admin.go('/books/trial-balance');
  check('9. admin: the trial balance balances', await A.shown('Debits equal credits.'));
  const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const tb = await call('GET', `/v1/reports/trial-balance?legalEntityId=${le.id}&from=${day}&to=${day}`, tk);
  const net = (k) => { const a = tb.data.find((x) => x.systemKey === k); return a ? (Number(a.debit) - Number(a.credit)).toFixed(2) : null; };
  const books = { SALES: net('SALES'), SERVICE_CHARGE_PAYABLE: net('SERVICE_CHARGE_PAYABLE'), OUTPUT_VAT: net('OUTPUT_VAT'), COGS: net('COGS'), CASH_ON_HAND: net('CASH_ON_HAND'), PAYMENT_CLEARING: net('PAYMENT_CLEARING') };
  const want = { SALES: '-383.93', SERVICE_CHARGE_PAYABLE: '-38.39', OUTPUT_VAT: '-50.68', COGS: '136.00', CASH_ON_HAND: '236.50', PAYMENT_CLEARING: '236.50' };
  if (JSON.stringify(books) !== JSON.stringify(want)) console.log('books', books);
  check('9. books: Sales 383.93 Cr, service charge payable 38.39 Cr, output VAT 50.68 Cr, COGS 136.00, cash 236.50, card clearing 236.50', JSON.stringify(books) === JSON.stringify(want));

  // ---- 10. Reconcile the shift
  await floor.clickText('Close shift');
  check('10. floor: expected drawer ₱1,236.50 (float + the cash check)', await F.shown('₱1,236.50'));
  await floor.waitFor(`document.getElementById('counted')`);
  await floor.fill('counted', '1236.50');
  await floor.evaluate(`[...document.querySelectorAll('form .btn-primary')].find((e) => e.getClientRects().length).click()`);
  check('10. floor: drawer balanced on close', await F.shown('Drawer balanced'));
  await floor.shot('service-close.png', false);
  const sessions = (await call('GET', '/v1/cashier-sessions', tk)).data;
  check('10. server: the one shift is RECONCILED (zero variance reconciles without approval)', sessions.length === 1 && sessions[0].status === 'RECONCILED');
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  admin.close();
  floor.close();
  kds.close();
}
finish();
