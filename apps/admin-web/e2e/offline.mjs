// End-to-end test of the admin's offline-sales review (ADR-0015 §5, Phase 5 slice 4). A till delivers
// three offline sales through the real terminal API: one recorded, one with a total its price list does
// not give, one naming a person who is not a member. A manager reviews them in the admin.
// Usage: node e2e/offline.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

// --- a shop with a till that was offline for a while
const call = client(API);
const slug = `off-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const cola = (await call('POST', '/v1/products', tk, { name: 'Cola', taxCategoryId: vat, uomId: pc, variants: [{ sku: 'COLA-1', price: '22.40' }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const term = await call('POST', '/v1/terminals', tk, { registerId: reg.id, name: 'Till 1' });
const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
const terminal = { 'x-terminal-id': term.terminal.id, authorization: `Terminal ${term.credential}` };
const snap = await call('GET', '/v1/terminal/snapshot', null, undefined, terminal);
const sale = (seq, over = {}) => ({
  terminalTxnId: randomUUID(), deviceSeq: seq, snapshotId: snap.snapshotId, cashierSessionId: shift.id, cashierUserId: owner.user.id,
  occurredAt: new Date().toISOString(), localReference: `R1-T${term.terminal.credentialHint}-${String(seq).padStart(6, '0')}`,
  lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '50.00' }], amountDue: '22.40', ...over,
});
const synced = await call('POST', '/v1/sync/sales', null, { sales: [sale(1), sale(2, { amountDue: '20.00', tenders: [{ method: 'CASH', tendered: '20.00' }] }), sale(3, { cashierUserId: randomUUID() })] }, terminal);
const statuses = synced.results.map((r) => r.status).join();
if (statuses !== 'RECORDED,QUARANTINED,QUARANTINED') throw new Error(`arrangement: ${statuses}`);

// --- the manager reviews them
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9344 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Overview')`);
  check('nav shows Offline sales for the owner', await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.textContent === 'Offline')`));

  await go('/offline-sales');
  check('two sales wait for review, with the till, cashier and amount', await shown('To review') && (await text()).includes('R1-T') && (await text()).includes('Till 1') && (await text()).includes('₱20.00'));
  check('the wrong total is explained with both figures', await shown('The till charged a different total than its price list gives (₱20.00 vs ₱22.40)'));
  check('the unknown cashier is explained', (await text()).includes('not an active member of the business'));
  await shot('offline-review.png');

  // Recording the wrong total again is refused and counted.
  await evaluate(`[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('₱20.00')).querySelector('button.btn-primary').click()`);
  check('record again refused: still not recordable', await shown('Still not recordable'));
  // Serial lines are upper-cased by CSS, and innerText reflects that.
  check('the attempt is counted (2 tries)', await waitFor(`document.body.innerText.toLowerCase().includes('2 tries')`).then(() => true, () => false));

  // Dismiss it with a reason.
  await evaluate(`[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('₱20.00')).querySelector('button.btn-danger').click()`);
  await waitFor(`document.querySelector('[name="reason"]')`);
  await fill('reason', 'Overcharged by mistake; counted in the drawer');
  await evaluate(`[...document.querySelectorAll('form button.btn-danger')].at(-1).click()`);
  check('dismissed: one sale left to review', await waitFor(`!document.body.innerText.includes('₱20.00')`).then(() => true, () => false));
  const server = await call('GET', '/v1/sync/transactions?status=DISMISSED', tk);
  check('server: dismissed with the reason, by the owner', server.data.length === 1 && server.data[0].resolveReason === 'Overcharged by mistake; counted in the drawer');

  await clickText('Dismissed');
  check('dismissed tab shows the reason', await shown('Dismissed: Overcharged by mistake'));
  await clickText('Recorded');
  check('recorded tab shows the sale with its register number', await shown('Sale R1-000001'));

  await viewport(390, 844, true);
  await go('/offline-sales');
  await sleep(300);
  check('390px: no horizontal page scroll, actions reachable', await noHorizontalScroll() && await evaluate(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.trim() === 'Record again')`));
  await shot('offline-review-390.png');
  await viewport(1440, 900);
  await clickText('FIL');
  check('Filipino review screen', await shown('Offline na benta') && (await text()).includes('Susuriin'));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
