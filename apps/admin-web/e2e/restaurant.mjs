// End-to-end test of the restaurant set-up in the admin (ADR-0014, Phase 4 slice 6c): station,
// floor, choice group, menu draft → publish, recipe, branch settings and 86 — all through the UI,
// checked against what the POS will read (GET /v1/branches/:id/menu).
// Usage: node e2e/restaurant.mjs [baseUrl] [screenshotDir]
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9339 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
/** Case-insensitive: serial lines and section titles are upper-cased by CSS. */
const shownI = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const visibleForms = `[...document.querySelectorAll('form')].filter((f) => f.getClientRects().length).length`;
/** Submit an inline panel and wait until it has closed (saved), so the next step never types into it. */
const submitPanel = async () => {
  const before = await evaluate(visibleForms);
  await submitOpen();
  await waitFor(`(${visibleForms}) < ${before}`).catch(() => undefined);
};
const submitOpen = () => evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
/** Confirm dialogs (archive, publish) answer yes; set after every full navigation. */
const autoConfirm = () => evaluate('window.confirm = () => true');
/** Open an inline panel and wait until its first field is on screen. */
const panel = async (label, field) => {
  await clickText(label);
  await waitFor(`[...document.querySelectorAll('[name="${field}"]')].some((x) => x.getClientRects().length)`);
};
const open = async (path) => {
  await go(path);
  await autoConfirm();
};

try {
  await viewport(1440, 900);
  const slug = `rest-${Date.now().toString(36)}`;
  await go('/sign-up');
  await fill('businessName', 'Kainan Smoke Test');
  await fill('tenantSlug', slug);
  await fill('displayName', 'Lito Santos');
  await fill('email', `${slug}@example.ph`);
  await fill('password', 'correct horse battery staple');
  await evaluate(`document.querySelector('input[name=businessType][value=RESTAURANT]').click()`);
  await b.finishSteps();
  await waitFor(`document.body.innerText.includes('Overview')`);

  // Catalog through the BFF: dishes (no stock of their own) and stocked ingredients.
  const le = await bff('POST', '/api/v1/legal-entities', { registeredName: 'Kainan Smoke Corp', vatStatus: 'VAT' }, true);
  const br = await bff('POST', '/api/v1/branches', { legalEntityId: le.body.id, code: 'MKT-01', name: 'Makati' }, true);
  const branchId = br.body.id;
  const uoms = (await evaluate(`fetch('/api/v1/uoms').then((r) => r.json())`)).data;
  const vat = (await evaluate(`fetch('/api/v1/tax-categories').then((r) => r.json())`)).data.find((x) => x.code === 'VAT').id;
  const uom = (c) => uoms.find((u) => u.code === c).id;
  const product = async (name, sku, price, trackInventory, unit = 'PC') =>
    (await bff('POST', '/api/v1/products', { name, uomId: uom(unit), taxCategoryId: vat, trackInventory, variants: [{ sku, price }] }, true)).body.variants[0].id;
  const burger = await product('Burger', 'BRG-1', '150.00', false);
  await product('Iced tea', 'TEA-1', '45.00', false);
  await product('Bun', 'BUN-1', '10.00', true);
  await product('Ground beef', 'BEEF-1', '500.00', true, 'KG');
  await go('/');
  check('nav shows Restaurant for the owner', await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.textContent === 'Restaurant')`));

  // Floor & kitchen
  await open('/restaurant');
  check('restaurant set-up opens on Floor & kitchen', await shown('Kitchen stations') && (await text()).includes('No stations yet'));
  await panel('Add station', 'code');
  await fill('code', 'grill');
  await fill('name', 'Grill');
  await evaluate(`document.querySelector('input[name="isDefault"]').click()`);
  await submitPanel();
  check('station GRILL added (upper-cased) as the default', await shown('GRILL') && (await text()).includes('Default'));
  await panel('Add area', 'name');
  await fill('name', 'Hall');
  await submitPanel();
  if (!(await shown('0 tables'))) console.log(await text());
  await panel('Add table', 'code');
  await fill('code', 'T1');
  await fill('seats', '4');
  await submitPanel();
  check('table T1 (4 seats) in the Hall', await shown('4 seats') && (await text()).includes('T1'));
  await panel('Add table', 'code');
  await fill('code', 'T2');
  await submitPanel();
  await shown('T2');
  await shot('restaurant-floor.png');

  // Choices
  await open('/restaurant/modifiers');
  await panel('Add choice group', 'minSelect');
  await fill('name', 'Doneness');
  await fill('minSelect', '1');
  await fill('maxSelect', '1');
  await fill('lines.0.name', 'Medium');
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add option').click()`);
  await waitFor(`document.querySelector('[name="lines.1.name"]')`);
  await fill('lines.1.name', 'Well done');
  await submitPanel();
  check('choice group Doneness: required, pick 1, two free options', await shownI('Required · pick 1') && (await text()).includes('Well done') && (await text()).includes('Free'));

  // Menu: draft → publish
  await open('/restaurant/menus');
  await panel('New menu', 'name');
  await fill('name', 'All day');
  await submitPanel();
  await waitFor(`location.pathname.startsWith('/restaurant/menus/')`);
  await autoConfirm();
  check('new menu opens on its empty draft v1', await shownI('Draft · v1') && (await text()).includes('This draft is empty'));
  await clickText('Add section');
  await fill('sections.0.name', 'Mains');
  await clickText('Add item');
  await waitFor(`document.querySelector('[name="sections.0.items.0.variantId"]')`);
  await fill('sections.0.items.0.variantId', burger);
  await fill('sections.0.items.0.stationCode', 'GRILL');
  await evaluate(`[...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Doneness').querySelector('input').click()`);
  await clickText('Save draft');
  check('draft saved', await waitFor(`!document.body.innerText.includes('Unsaved changes')`).then(() => true, () => false));
  await shot('restaurant-menu-draft.png');
  await clickText('Publish');
  check('published: v1 frozen, no draft left', await shownI('Published · v1') && await shown('No draft'));
  await shot('restaurant-menu-published.png');

  // Recipe
  await open('/restaurant/recipes');
  check('recipes list the dishes only (no stocked ingredients)', await shown('Burger') && !(await text()).includes('Ground beef'));
  await clickText('Burger');
  await waitFor(`document.body.innerText.includes('No recipe yet')`);
  await autoConfirm();
  await clickText('New recipe version');
  const options = await evaluate(`[...document.querySelector('[name="lines.0.variantId"]').options].map((o) => [o.value, o.textContent])`);
  await fill('lines.0.variantId', options.find(([, l]) => l.includes('Bun'))[0]);
  await fill('lines.0.quantity', '1');
  await clickText('Add line');
  await waitFor(`document.querySelector('[name="lines.1.variantId"]')`);
  await fill('lines.1.variantId', options.find(([, l]) => l.includes('Ground beef'))[0]);
  await fill('lines.1.quantity', '0.15');
  await submitPanel();
  check('recipe v1 in force: 1 bun + 0.15 kg beef', await shown('In force') && (await text()).includes('0.15'));
  await shot('restaurant-recipe.png');

  // Branch settings: serve the menu, 10 % service charge on dine-in
  await open(`/restaurant/settings?branch=${branchId}`);
  const menus = (await evaluate(`fetch('/api/v1/menus').then((r) => r.json())`)).data;
  await fill('dineInMenuId', menus[0].id);
  await fill('takeawayMenuId', menus[0].id);
  await fill('rate', '10');
  await submitOpen();
  check('settings saved', await shown('Saved.'));
  const settings = (await bff('GET', `/api/v1/branches/${branchId}/restaurant-settings`)).body;
  check('server: service charge rate 0.1 on dine-in, menu served', settings.serviceChargeRate === '0.1' && settings.serviceChargeDineIn === true && settings.dineInMenuId === menus[0].id);
  await open(`/restaurant/settings?branch=${branchId}`);
  check('rate shows back as 10 (%)', await evaluate(`document.querySelector('[name="rate"]').value === '10'`));

  // Counter service (session 25): explained beside its switch, refused without a takeaway menu, then on.
  check('counter service switch is off and explained', await evaluate(`document.querySelector('[name="counterService"]').checked === false`) && await shown('Counter service (pay first)') && await shown('For cafés and food trucks'));
  await fill('takeawayMenuId', '');
  await evaluate(`document.querySelector('[name="counterService"]').click()`);
  await submitOpen();
  check('counter service without a takeaway menu: the message sits on the takeaway menu field', await shown('Counter service sells from the takeaway menu: choose one first.'));
  check('server: nothing changed by the refused save', (await bff('GET', `/api/v1/branches/${branchId}/restaurant-settings`)).body.counterService === false);
  await fill('takeawayMenuId', menus[0].id);
  await submitOpen();
  check('counter service saved with the takeaway menu', await shown('Saved.'));
  check('server: counter service on', (await bff('GET', `/api/v1/branches/${branchId}/restaurant-settings`)).body.counterService === true);
  await open(`/restaurant/settings?branch=${branchId}`);
  check('counter service shows back as on', await evaluate(`document.querySelector('[name="counterService"]').checked === true`));
  await evaluate(`document.querySelector('[name="counterService"]').click()`);
  await submitOpen();
  check('counter service off again', await shown('Saved.') && (await bff('GET', `/api/v1/branches/${branchId}/restaurant-settings`)).body.counterService === false);

  // 86: the burger runs out, then comes back
  await panel('Mark sold out', 'note');
  await fill('variantId', burger);
  await fill('note', 'No buns');
  await submitPanel();
  check('burger marked sold out with its note', await shown('No buns'));
  const pos = (await bff('GET', `/api/v1/branches/${branchId}/menu?orderType=DINE_IN`)).body;
  const item = pos.menu?.sections[0]?.items[0];
  check('POS menu: Mains → Burger, Doneness, GRILL, sold out', item?.name === 'Burger' && item.stationCode === 'GRILL' && item.modifierGroups[0]?.name === 'Doneness' && item.soldOut === true);
  await shot('restaurant-settings.png');
  await clickText('Back on');
  check('back on: nothing sold out', await shown('Nothing is sold out'));

  // Archive a table
  await open('/restaurant');
  await evaluate(`[...document.querySelectorAll('li')].find((l) => l.textContent.startsWith('T2')).querySelector('button').click()`);
  check('table T2 archived', await waitFor(`!document.body.innerText.includes('T2')`).then(() => true, () => false));

  // Layout and language
  for (const path of ['/restaurant', `/restaurant/menus/${menus[0].id}`, '/restaurant/modifiers', `/restaurant/settings?branch=${branchId}`]) {
    await viewport(390, 844, true);
    await open(path);
    await sleep(300);
    check(`${path.split('?')[0]}: no horizontal page scroll at 390px`, await noHorizontalScroll());
  }
  await shot('restaurant-390.png');
  await viewport(1440, 900);
  await open('/restaurant');
  await clickText('FIL');
  check('Filipino restaurant set-up', await shown('Mga kitchen station'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
