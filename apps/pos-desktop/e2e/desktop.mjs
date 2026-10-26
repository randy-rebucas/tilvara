// End-to-end test of the desktop till (Tauri shell, ADR-0015 slice 5) through a real outage.
// Usage: node apps/pos-desktop/e2e/desktop.mjs [tillExe] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) on apiUrl and a built till
//   (cd apps/pos-desktop && pnpm tauri build --debug --no-bundle). At set-up the script points the till
//   at its own proxy (127.0.0.1:4399), which it cuts to simulate the outage.
// Each run uses its own till profile (database + credential entry), never a real till's.
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { checklist, openDesktop, sleep } from '../../admin-web/e2e/cdp.mjs';

const EXE = process.argv[2] ?? 'apps/pos-desktop/src-tauri/target/debug/onepos-till.exe';
const OUT = process.argv[3] ?? '.impeccable/review/desktop';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const PROXY_PORT = 4399;
const PASSWORD = 'correct horse battery staple';
const PROFILE = `e2e-${Date.now().toString(36)}`;

// --- the till reaches the API through this proxy; the test cuts it
const upstream = new URL(API);
const sockets = new Set();
let dropNextSaleAnswer = false;
const proxy = net.createServer((client) => {
  const server = net.connect(Number(upstream.port), upstream.hostname);
  sockets.add(client).add(server);
  let dropAnswer = false;
  client.on('data', (chunk) => {
    // Lose the answer to the next checkout: the request reaches the API, the reply never returns.
    if (dropNextSaleAnswer && chunk.toString('latin1').startsWith('POST /v1/sales ')) {
      dropNextSaleAnswer = false;
      dropAnswer = true;
    }
    server.write(chunk);
  });
  server.on('data', (chunk) => {
    if (dropAnswer) {
      // Cut after the status line has started: had no byte arrived, Chromium would resend the POST on
      // a fresh connection by itself (same Idempotency-Key, so the API replays) and nothing is lost.
      client.end(chunk.subarray(0, 9), () => client.destroy());
      server.destroy();
    } else client.write(chunk);
  });
  const end = () => { client.destroy(); server.destroy(); sockets.delete(client); sockets.delete(server); };
  client.on('close', end).on('error', end);
  server.on('close', end).on('error', end);
});
const proxyUp = () => new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
const proxyDown = () => new Promise((r) => { proxy.close(() => r()); for (const s of sockets) s.destroy(); });

// --- arrange a shop and a terminal through the API (owner = cashier and manager)
async function call(method, path, token, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const slug = `till-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Aling Nena', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Aling Nena', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = async (name, sku, barcode, price, tax = 'VAT') =>
  (await call('POST', '/v1/products', tk, { name, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku, barcodes: barcode ? [barcode] : [], price }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const cola = await product('Coke Mismo 290ml', 'CK-290', '4801981116072', '22.40');
const canton = await product('Pancit Canton Chilimansi', 'PC-CHILI', '4807770270017', '16.50');
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '24', unitCost: '15.00' }, { variantId: canton, quantity: '24', unitCost: '11.00' }] }, { 'idempotency-key': randomUUID() });
const term = await call('POST', '/v1/terminals', tk, { registerId: reg.id, name: 'Front till' });

// --- drive the till
const list = checklist();
const finish = list.finish;
// A failing check prints what the till showed, for the record.
const check = async (name, ok) => {
  if (!ok) {
    console.log('  screen:', JSON.stringify(await text().catch(() => '?')).slice(0, 1200));
    console.log('  errors:', JSON.stringify(await evaluate('window.__errors').catch(() => '?')).slice(0, 2000));
  }
  list.check(name, ok);
};
await proxyUp();
const launch = () => openDesktop({ exe: EXE, out: OUT, env: { ONEPOS_TILL_PROFILE: PROFILE } });
let app = await launch();
let { evaluate, waitFor, fill, clickText, shot } = app;
const text = () => evaluate('document.body.innerText');
// Case-insensitive: the band sets some labels in capitals (text-transform shows in innerText).
const shown = (s, ms = 15000) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(600);
};
const totalShows = (amount) => waitFor(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`, 8000).then(() => true, () => false);
const submitForm = () => evaluate(`document.querySelector('form button.btn-primary').click()`);
// The submit button is disabled while the cart is re-priced (e.g. right after going offline).
const clickEnabled = async (label) => {
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes(${JSON.stringify(label)}) && b.getClientRects().length && !b.disabled)`);
  await clickText(label);
};
const signIn = async () => {
  await fill('email', email);
  await fill('password', PASSWORD);
  await submitForm();
};

try {
  await check('first launch asks to set up the till', await shown('Set up this till'));
  await fill('terminalId', term.terminal.id);
  await fill('credential', term.credential);
  await fill('apiUrl', 'http://192.168.1.10:4320');
  await submitForm();
  await check('set-up refuses a plain-http server on the network (the key would travel unencrypted)', await shown('https:// address'));
  await fill('apiUrl', `http://127.0.0.1:${PROXY_PORT}`);
  await fill('credential', 'tpk_not-the-key');
  await submitForm();
  await check('a wrong key is refused at set-up', await shown('did not accept'));
  await fill('credential', term.credential);
  await submitForm();
  const signInShown = await waitFor(`document.querySelector('[name="email"]')`).then(() => true, () => false);
  await check('set up: sign-in shows the desktop-till notice and Online', signInShown && (await shown('keeps selling cash')) && (await text()).includes('Online'));
  await shot('setup-done.png', false);

  await signIn();
  await waitFor(`document.body.innerText.includes('Counter 1')`);
  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await submitForm();
  await waitFor(`document.getElementById('scan')`);
  const shiftId = (await call('GET', `/v1/cashier-sessions?registerId=${reg.id}&status=OPEN`, tk).catch(() => null))?.data?.[0]?.id;

  // 1. Online, as in browser mode.
  await scan('4801981116072');
  await check('online: server-priced total ₱22.40', await totalShows('₱22.40'));
  await clickText('₱50.00');
  await clickEnabled('Complete sale');
  await check('online receipt R1-000001', await shown('R1-000001'));
  await clickText('New sale');

  // 2. The answer to a checkout is lost (the API recorded it): the till goes offline, and recording the
  //    same checkout offline must not count it twice.
  await scan('PC-CHILI');
  await check('online: ₱16.50', await totalShows('₱16.50'));
  await clickText('₱20.00');
  dropNextSaleAnswer = true;
  await clickEnabled('Complete sale');
  const lost = (await shown('Could not confirm')) && (await shown('Offline.'));
  await check('lost answer: the cashier is told it may not be recorded and the till goes offline', lost);
  await proxyDown();
  await check('offline: the submit button records the cash sale on the till', await shown('Record cash sale offline'));
  await clickEnabled('Record cash sale offline');
  const kept = (await shown('NOT AN OFFICIAL INVOICE', 30000)) && /R1-T\w+-000001/.test(await text());
  if (!kept) console.log('  errors:', JSON.stringify(await evaluate('window.__errors')));
  await check('offline receipt: local reference, not an invoice', kept);
  await check('offline receipt prints the TIN as online receipts do (VAT REG TIN 123-456-789-00000)', (await text()).includes('VAT REG TIN 123-456-789-00000'));
  await shot('offline-receipt-dup.png');
  await clickText('New sale');

  // 3. A plain offline sale: scan from the till's price list, cash only, no card/QR.
  await scan('CK-290');
  await scan('4807770270017');
  await check('offline: priced from the snapshot (₱38.90)', await totalShows('₱38.90'));
  await check('offline: card and QR are not offered', (await text()).includes('Card and QR need the connection'));
  await check('offline: no SC/PWD button on the lines (discounts need the connection)', !(await text()).includes('SC/PWD'));
  await shot('offline-cart.png', false);
  await clickText('₱50.00');
  await clickEnabled('Record cash sale offline');
  await check('offline receipt 2 kept on the till', await shown('R1-T') && /000002/.test(await text()));
  // The screen reads as the print does: the cash applied, then what was handed over and the change.
  await check('offline receipt on screen: CASH ₱38.90, Tendered ₱50.00, Change ₱11.10', /CASH\s+₱38\.90\s+Tendered\s+₱50\.00\s+Change\s+₱11\.10/.test(await text()));
  await shot('offline-receipt.png');
  await clickText('New sale');
  await check('band: 2 to send', await shown('2 to send'));
  await shot('offline-band.png', false);

  // 4. The till restarts during the outage: the queue survives (selling needs sign-in, which needs the API).
  // Wait for the old process to be gone: a new one would otherwise find its debugging port still taken.
  const exited = new Promise((r) => app.child.once('exit', r));
  app.close();
  await exited;
  await sleep(1000);
  app = await launch();
  ({ evaluate, waitFor, fill, clickText, shot } = app);
  await check('after a restart offline: still 2 to send, no set-up asked', (await shown('2 to send', 20000)) && !(await text()).includes('Set up this till'));

  // 5. The connection comes back: the till sends both, in order.
  await proxyUp();
  await check('back online: nothing left to send', await waitFor(`!document.body.innerText.includes('to send') && document.body.innerText.includes('Online')`, 90000).then(() => true, () => false));
  const session = shiftId ? await call('GET', `/v1/cashier-sessions/${shiftId}`, tk) : null;
  // Float 1000 + 22.40 (online) + 16.50 (recorded online, answer lost) + 38.90 (offline) — the duplicate counted once.
  await check('drawer counts every sale once: expected ₱1,077.80', session?.expectedCash === '1077.80');
  const q = await call('GET', '/v1/sync/transactions?status=QUARANTINED', tk);
  await check('the offline copy of the lost-answer sale waits for review as a duplicate of sale 2',
    q.data.length === 1 && q.data[0].errorCode === 'DUPLICATE_TRANSACTION' && q.data[0].errorDetail?.details?.saleNumber === 2);
  const rec = await call('GET', '/v1/sync/transactions?status=RECORDED', tk);
  await check('the plain offline sale was recorded', rec.data.length === 1);
  await shot('synced.png', false);

  // 6. A price changed in the back office reaches the till within half a minute (session 16), long before
  //    its 10-minute refresh: after the change, cut the connection and price the item from the till.
  await signIn(); // the restart above signed the cashier out (tokens live in memory)
  await waitFor(`document.body.innerText.includes('Continue shift')`);
  await clickText('Continue shift');
  await waitFor(`document.getElementById('scan')`);
  const lists = (await call('GET', '/v1/price-lists', tk)).data;
  await call('POST', `/v1/price-lists/${lists.find((l) => l.isDefault).id}/prices`, tk, { items: [{ variantId: cola, amount: '25.00' }] });
  await sleep(40_000);
  await proxyDown();
  await scan('CK-290');
  await check('a price changed online is on the till at once: offline, Coke is ₱25.00', await totalShows('₱25.00'));
} catch (e) {
  console.error(e);
  await check('no unexpected error', false);
} finally {
  app.close();
  await proxyDown().catch(() => undefined);
}
finish();
