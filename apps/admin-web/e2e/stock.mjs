// End-to-end test of stock rules and count sheets (session 16): the branch's negative-stock policy
// and low-stock switch, a blind count sheet counted by someone who may only count (they never see
// the frozen quantities), a sale during the count, the manager's review and posting (counted − the
// book when counted, so the sale is deducted once; ADR-0012 amendment 3), the "below zero" mark on the movements report, phone width, Filipino.
// The count-only member is arranged in the dev database as the migrator (DATABASE_MIGRATOR_URL from
// .env), as invitation links never leave the API process.
// Usage: node apps/admin-web/e2e/stock.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `stk-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = (name, sku, price) => call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, variants: [{ sku, price }] }, idem());
const cola = (await product('Coke Mismo 290ml', `CK-${slug}`, '22.00')).variants[0].id;
const canton = (await product('Pancit Canton', `PC-${slug}`, '16.50')).variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '10', unitCost: '15.00' }, { variantId: canton, quantity: '4', unitCost: '11.00' }] }, idem());
await call('POST', '/v1/roles', tk, { key: 'stock_counter', name: 'Stock counter', permissions: ['inventory.count'] });
const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
const sell = (variantId, quantity) =>
  call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId, quantity }], tenders: [{ method: 'CASH', tendered: '500.00' }] }, idem());
// The counter: an account in this business with only inventory.count at Cubao.
const counterEmail = `${slug}-counter@example.ph`;
{
  const { PasswordService } = await import('../../api/dist/auth/password.service.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [owner.activeTenantId]);
    const u = await db.query('SELECT auth_register_user($1, $2, $3) AS id', [counterEmail, 'Jun Santos', await new PasswordService().hash(PASSWORD)]);
    const m = await db.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [owner.activeTenantId, u.rows[0].id]);
    await db.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'BRANCH', $3 FROM roles WHERE tenant_id = $1 AND key = 'stock_counter'`,
      [owner.activeTenantId, m.rows[0].id, br.id],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9349 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText.toLowerCase()');
const has = async (...all) => { const t = await text(); return all.every((s) => t.includes(s.toLowerCase())); };
const shown = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const signIn = async (who) => {
  await go('/sign-in');
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`location.pathname !== '/sign-in'`);
};
/** Line text on the sheet page, by item name. */
const lineText = (name) => evaluate(`([...document.querySelectorAll('main li')].find((li) => li.innerText.includes(${JSON.stringify(name)}))?.innerText ?? '').toLowerCase()`);
const typeCount = (name, value) => evaluate(`(() => {
  const li = [...document.querySelectorAll('main li')].find((x) => x.innerText.includes(${JSON.stringify(name)}));
  const el = li.querySelector('input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

try {
  await viewport(1440, 900);
  await signIn(email);

  // 1. Branch stock rules.
  await go(`/inventory/settings?branch=${br.id}`);
  check('settings tab: the three policies, today Allow, and the low-stock switch on', (await shown('Stock rules for this branch')) && await evaluate(`document.querySelector('input[value="ALLOW"]').checked && document.querySelector('[name="lowStockAlerts"]').checked`));
  await evaluate(`document.querySelector('input[value="BLOCK"]').click()`);
  await clickText('Save');
  check('choosing Block is saved', await shown('Saved.'));
  await go(`/inventory/settings?branch=${br.id}`);
  check('…and still chosen after a reload', await evaluate(`document.querySelector('input[value="BLOCK"]').checked`));
  await shot('stock-settings.png');
  const refused = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: canton, quantity: '5' }], tenders: [{ method: 'CASH', tendered: '500.00' }] }, idem()).then(() => null, (e) => e);
  check('with Block, the till is refused a sale of 5 when 4 are on hand, naming the item', String(refused?.message ?? refused).includes('INSUFFICIENT_STOCK') || String(refused?.message ?? '').includes('Pancit Canton'));

  // 2. A blind count sheet, started by the owner.
  await go(`/inventory/counts?branch=${br.id}`);
  check('counts tab: count sheets section, none yet', (await shown('Count sheets')) && await has('No count sheets yet.'));
  await clickText('Start a count sheet');
  await waitFor(`document.querySelector('[name="blind"]')`);
  check('a new sheet is blind by default', await evaluate(`document.querySelector('[name="blind"]').checked`));
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.textContent.includes('Start a count sheet')).click()`);
  await waitFor(`location.pathname.startsWith('/inventory/count-sheets/')`);
  const sheetPath = await evaluate('location.pathname');
  check('the sheet opens with both items, nothing counted yet', (await shown('0 of 2 items counted')) && await has('Coke Mismo 290ml', 'Pancit Canton'));
  check('the owner sees frozen quantities only after asking for them', !(await lineText('Coke Mismo')).includes('expected'));
  await evaluate(`[...document.querySelectorAll('label')].find((l) => l.textContent.includes('Show expected quantities')).querySelector('input').click()`);
  check('…then Expected 10 for Coke', (await lineText('Coke Mismo')).includes('expected 10'));
  await shot('stock-sheet-owner.png');
  await bff('POST', '/api/auth/logout');

  // 3. The counter counts blind; a sale happens meanwhile.
  await signIn(counterEmail);
  await go('/inventory');
  check('someone who may only count lands on Counts from the Inventory tab', await waitFor(`location.pathname === '/inventory/counts'`).then(() => true, () => false));
  await go(sheetPath);
  await shown('items counted');
  check('the counter sees the items but no expected quantities and no toggle', (await has('Coke Mismo 290ml', 'Count what you find on the shelf')) && !(await has('Expected', 'Show expected quantities')));
  await sell(cola, '2');
  await typeCount('Coke Mismo', '9');
  check('the save button says how many counts are waiting', await shown('Save 1 counts'));
  await clickText('Save 1 counts');
  check('saved: 1 of 2 counted, the counter named on the line', (await shown('1 of 2 items counted')) && (await lineText('Coke Mismo')).includes('jun santos'));
  check('the counter cannot post or cancel', !(await has('Post 1 counted items', 'Cancel this sheet')));
  await shot('stock-sheet-counter.png');
  await viewport(390, 844, true);
  await sleep(300);
  check('390px: the sheet has no horizontal scroll', await noHorizontalScroll());
  await shot('stock-sheet-390.png');
  await viewport(1440, 900);
  await bff('POST', '/api/auth/logout');

  // 4. The owner reviews and posts.
  await signIn(email);
  await go(sheetPath);
  await shown('1 of 2 items counted');
  await evaluate(`[...document.querySelectorAll('label')].find((l) => l.textContent.includes('Show expected quantities')).querySelector('input').click()`);
  const coke = await lineText('Coke Mismo');
  check('review: expected 10, the 2 sold since the freeze shown, counted 9 against a book of 8: variance +1', coke.includes('expected 10') && /variance\s*\+?1\b/.test(coke) && /[−-]2 moved since the freeze/.test(coke));
  await clickText('Post 1 counted items');
  await waitFor(`location.pathname.startsWith('/inventory/counts/')`);
  check('posting opens the count: the column says Expected, Coke 8 → 9', (await shown('Expected')) && await has('Coke Mismo 290ml'));
  await shot('stock-count-posted.png');
  const bal = (await call('GET', `/v1/stock/balances?branchId=${br.id}&variantId=${cola}`, tk)).data[0];
  check('stock after posting: what was counted, 9 (10 − 2 sold + 1 found)', bal.quantity === '9');
  await go(sheetPath);
  check('the sheet is now posted and links to its count', (await shown('Posted')) && await has('Open the posted count'));

  // 4b. Two people on one sheet: a colleague's count saved meanwhile is kept, never sent back blank;
  // one open sheet per branch, and no quick count of an item on it.
  const sheet2 = await call('POST', '/v1/stock/count-sheets', tk, { branchId: br.id, blind: false });
  check('a second open sheet at the branch is refused (SHEET_OPEN)', await call('POST', '/v1/stock/count-sheets', tk, { branchId: br.id }).then(() => false, (e) => String(e?.message ?? e).includes('SHEET_OPEN')));
  await go(`/inventory/count-sheets/${sheet2.id}`);
  await shown('0 of 2 items counted');
  // The colleague (another session) counts the noodles while this page is open.
  await call('PUT', `/v1/stock/count-sheets/${sheet2.id}/lines`, tk, { lines: [{ variantId: canton, countedQuantity: '3' }] });
  await typeCount('Coke Mismo', '7.0');
  await clickText('Save 1 counts');
  check("after saving: the colleague's count shows and nothing waits to be saved", (await shown('2 of 2 items counted')) && (await shown('All counts saved')));
  const after = (await call('GET', `/v1/stock/count-sheets/${sheet2.id}`, tk)).lines;
  check("the colleague's 3 is kept and 7.0 was saved as 7", after.find((l) => l.variantId === canton)?.countedQuantity === '3' && after.find((l) => l.variantId === cola)?.countedQuantity === '7');
  check('Post is offered (no "save first")', (await has('Post 2 counted items')) && !(await has('Save the counts first.')));
  check('a quick count of an item on the open sheet is refused (ITEM_ON_OPEN_SHEET)', await call('POST', '/v1/stock/counts', tk, { branchId: br.id, lines: [{ variantId: cola, countedQuantity: '1' }] }, idem()).then(() => false, (e) => String(e?.message ?? e).includes('ITEM_ON_OPEN_SHEET')));
  await go(`/inventory/counts?branch=${br.id}`);
  check('Counts says a sheet is open and offers no second one', (await shown('already has an open count sheet')) && !(await has('Start a count sheet')));
  await call('POST', `/v1/stock/count-sheets/${sheet2.id}/cancel`, tk, { reason: 'E2E: two counters' });

  // 5. Below zero is marked on the movements report.
  await call('PUT', `/v1/branches/${br.id}/inventory-settings`, tk, { negativeStockPolicy: 'ALLOW_WITH_FLAG', lowStockAlerts: true });
  await sell(canton, '5');
  await go(`/inventory/movements?branch=${br.id}`);
  check('movements: a Below zero column marks Pancit Canton once', (await shown('Below zero')) && await evaluate(`[...document.querySelectorAll('main tr')].some((tr) => tr.innerText.includes('Pancit Canton') && tr.innerText.includes('1×'))`));
  await shot('stock-movements-below-zero.png');

  // 6. Filipino.
  await bff('POST', '/api/auth/lang', { lang: 'fil' });
  await go(`/inventory/settings?branch=${br.id}`);
  check('Filipino: stock rules', (await shown('Mga patakaran sa stock ng branch na ito')) && await has('Payagan, at markahan'));
  await go(`/inventory/counts?branch=${br.id}`);
  check('Filipino: count sheets', await shown('Mga count sheet'));
  await bff('POST', '/api/auth/lang', { lang: 'en' });
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
}
b.close();
finish();
