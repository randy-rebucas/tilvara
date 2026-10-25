// End-to-end test of drawer count approval (session 18): two shifts closed short and over, one
// counted by the owner and one by a branch manager. The overview tells a manager they wait; Drawer
// counts lists them with the difference; whoever counted a drawer is told someone else approves it
// (no button), the other manager approves with a note (required), from the list or the shift page;
// approved counts move to "Recently closed"; the help button opens the guide's Drawer counts part;
// the Offline page links here; phone width; Filipino.
// The branch manager is arranged in the dev database as the migrator (DATABASE_MIGRATOR_URL from
// .env), as invitation links never leave the API process.
// Usage: node apps/admin-web/e2e/drawers.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `drw-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const cola = (await call('POST', '/v1/products', tk, { name: 'Coke Mismo 290ml', taxCategoryId: vat, uomId: pc, trackInventory: false, variants: [{ sku: `CK-${slug}`, price: '22.00' }] }, idem())).variants[0].id;

// The second manager: Jun, Branch Manager at Cubao (holds cash.reconcile).
const managerEmail = `${slug}-mgr@example.ph`;
{
  const { PasswordService } = await import('../../api/dist/auth/password.service.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [owner.activeTenantId]);
    const u = await db.query('SELECT auth_register_user($1, $2, $3) AS id', [managerEmail, 'Jun Santos', await new PasswordService().hash(PASSWORD)]);
    const m = await db.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [owner.activeTenantId, u.rows[0].id]);
    await db.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'BRANCH', $3 FROM roles WHERE tenant_id = $1 AND key = 'branch_manager'`,
      [owner.activeTenantId, m.rows[0].id, br.id],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}
const mgr = (await call('POST', '/v1/auth/login', null, { email: managerEmail, password: PASSWORD })).tokens.accessToken;

// Shift A: the owner sells one Coke on a ₱1,000 float and counts ₱2 short (counted by the owner).
const shiftA = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
await call('POST', '/v1/sales', tk, { cashierSessionId: shiftA.id, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '22.00' }] }, idem());
await call('POST', `/v1/cashier-sessions/${shiftA.id}/close`, tk, { countedCash: '1020.00', note: 'Coins short' });
// Shift B: Jun's own shift on the same register, counted ₱5 over by Jun.
const shiftB = await call('POST', '/v1/cashier-sessions', mgr, { registerId: reg.id, openingFloat: '500.00' });
await call('POST', `/v1/cashier-sessions/${shiftB.id}/close`, mgr, { countedCash: '505.00' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9351 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const signIn = async (who) => {
  await go('/sign-in');
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
};
/** The text of the waiting-list row (desktop table) for a shift. */
const waitingRow = (shiftId) => evaluate(`(() => {
  const sec = document.querySelector('section[aria-labelledby="waiting"]');
  const link = [...sec.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/shifts/${shiftId}' && a.getClientRects().length);
  return link ? link.closest('tr')?.innerText ?? '' : null;
})()`);
const approveButtons = () => evaluate(`[...document.querySelectorAll('section[aria-labelledby="waiting"] button')].filter((x) => x.getClientRects().length && x.textContent.includes('Approve the count')).length`);

try {
  await viewport(1440, 900);
  await signIn(email);
  check('overview: the owner is told two drawer counts wait, with a link', await shown('Drawer counts waiting for approval: 2.') && await evaluate(`[...document.querySelectorAll('aside a')].some((a) => a.getAttribute('href') === '/shifts')`));
  await evaluate(`[...document.querySelectorAll('aside a')].find((a) => a.getAttribute('href') === '/shifts').click()`);
  await waitFor(`location.pathname === '/shifts'`);
  await shown('Waiting for approval');
  const rowA = await waitingRow(shiftA.id);
  const rowB = await waitingRow(shiftB.id);
  check('both shifts wait, with expected, counted and the signed difference', !!rowA && !!rowB && /₱1,022\.00/.test(rowA) && /₱1,020\.00/.test(rowA) && /−₱2\.00\s*short/.test(rowA) && /\+₱5\.00\s*over/.test(rowB));
  check('the row names the register, branch, cashier and who counted', /R1 · Cubao/i.test(rowA) && rowA.includes('Nena Reyes') && rowB.includes('Jun Santos'));
  check('the owner counted shift A: told someone else approves it, and only shift B has a button', rowA.includes('You counted this drawer') && !rowB.includes('You counted this drawer') && (await approveButtons()) === 1);
  check('the help button opens the Drawer counts part of the guide', await evaluate(`document.querySelector('header a[href^="/help"]').getAttribute('href') === '/help#drawers'`));
  await shot('drawers-waiting-1440.png');

  // Approve B from the list: the note is required.
  await clickText('Approve the count');
  await waitFor(`document.querySelector('input[name="note"]')`);
  check('the approval panel explains itself', await shown('Ask the cashier first'));
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.textContent.includes('Approve the count')).click()`);
  check('approving without a note is refused in words', await shown('This field is required.'));
  await fill('note', 'Counted a ₱5 coin from the float twice');
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.textContent.includes('Approve the count')).click()`);
  await waitFor(`!document.querySelector('input[name="note"]')`, 10000).catch(() => undefined);
  await waitFor(`(() => { const sec = document.querySelector('section[aria-labelledby="waiting"]'); return ![...sec.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/shifts/${shiftB.id}'); })()`, 10000).catch(() => undefined);
  check('B leaves the waiting list; A stays', (await waitingRow(shiftB.id)) === null && (await waitingRow(shiftA.id)) !== null);
  const recent = await evaluate(`document.querySelector('section[aria-labelledby="recent"]').innerText`);
  check('B shows under Recently closed, approved by the owner with the note', recent.includes('Nena Reyes') && recent.includes('Counted a ₱5 coin from the float twice') && /\+₱5\.00/.test(recent));
  const apiB = await call('GET', `/v1/cashier-sessions/${shiftB.id}`, tk);
  check('the API agrees: B is reconciled, approved by the owner', apiB.status === 'RECONCILED' && apiB.reconciliation.approvedBy === owner.user.id);

  // Shift A's own page, as the owner who counted it.
  await go(`/shifts/${shiftA.id}`);
  check('shift page, counted by me: waiting for a manager, told someone else approves, no button', await shown('Waiting for a manager') && (await text()).includes('You counted this drawer') && !(await evaluate(`[...document.querySelectorAll('main button')].some((x) => x.textContent.includes('Approve the count'))`)));

  await go('/offline-sales');
  check('the Offline page links to Drawer counts', await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/shifts' && a.textContent.includes('Drawer counts'))`));

  // The branch manager approves A from its shift page.
  await bff('POST', '/api/auth/logout');
  await signIn(managerEmail);
  check('overview: the branch manager is told one count waits', await shown('Drawer counts waiting for approval: 1.'));
  await go(`/shifts/${shiftA.id}`);
  check('a branch manager sees who counted (names come with the shift, not from the team list)', await evaluate(`[...document.querySelectorAll('main div')].some((d) => d.innerText.startsWith('Counted by') && d.innerText.includes('Nena Reyes'))`));
  await clickText('Approve the count');
  await waitFor(`document.querySelector('input[name="note"]')`);
  await fill('note', 'Two ₱1 coins under the drawer tray');
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].find((x) => x.textContent.includes('Approve the count')).click()`);
  check('approved from the shift page: reconciled, approved by Jun, with the note', await shown('Reconciled', 10000) && (await text()).includes('Jun Santos') && (await text()).includes('Two ₱1 coins under the drawer tray'));
  await shot('drawers-shift-approved.png');
  await go('/');
  check('overview: nothing waits any more, so no notice', !(await text()).includes('Drawer counts waiting'));
  await go('/shifts');
  check('Drawer counts: nothing waiting', await shown('No drawer count is waiting.'));

  // Phone and Filipino.
  await viewport(390, 844, true);
  await go('/shifts');
  check('390px: no sideways scroll on Drawer counts', await noHorizontalScroll());
  await shot('drawers-390.png', false);
  await viewport(1440, 900);
  await clickText('FIL');
  check('Filipino: the page is translated', await shown('Mga bilang ng drawer') && (await text()).toLowerCase().includes('kamakailang naisara'));
  await clickText('EN');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
