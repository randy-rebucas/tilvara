// End-to-end test of integrations in the back office (session 20, ADR-0019): the plan callout, an
// API key made, shown once and used for a read (and refused a write), a webhook to a local receiver
// that checks every signature, a test and a real sale delivered by the worker, a delivery that gives
// up and is sent again, a new secret, turning it off, revoking the key, the guide line, Filipino and
// phone width. Needs the API and the worker started with WEBHOOK_ALLOW_INSECURE=true (the receiver is
// on 127.0.0.1). The plan is set to Enterprise in the dev database as onepos_owner (DRILL_ADMIN_URL
// from .env, pointed at the API's database), as only the platform may change a subscription.
// Usage: node apps/admin-web/e2e/integrations.mjs [baseUrl] [screenshotDir] [apiUrl]
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- a receiver: records what arrives, answers 500 while `failing` ----
const received = [];
let failing = false;
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.writeHead(failing ? 500 : 200).end();
  });
});
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${receiver.address().port}/tilvara`;
const signedBy = (secret, m) => {
  const parts = Object.fromEntries(String(m.headers['tilvara-signature'] ?? '').split(',').map((p) => p.split('=', 2)));
  return !!parts.v1 && createHmac('sha256', secret).update(`${parts.t}.${m.body}`).digest('hex') === parts.v1;
};
const arrival = async (pred, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const m = received.find((x) => pred(JSON.parse(x.body)));
    if (m) return m;
  }
  return null;
};

// ---- arrangement (API) ----
const slug = `int-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lito Cruz', businessName: 'Cruz Hardware', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Cruz Hardware Trading', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'PAS-01', name: 'Pasig' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const nails = (await call('POST', '/v1/products', tk, { name: 'Nails 2in (box)', taxCategoryId: vat, uomId: pc, trackInventory: false, variants: [{ sku: `NL-${slug}`, price: '85.00' }] }, idem())).variants[0].id;
const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' });
const setPlan = async (code) => {
  const url = new URL(process.env.DRILL_ADMIN_URL);
  url.pathname = '/onepos';
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(`SELECT platform_set_subscription($1, $2, 'ACTIVE', null, null)`, [owner.activeTenantId, code]);
  } finally {
    await db.end();
  }
};

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9356 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
// textContent: section titles and serials are uppercased by CSS.
const shown = (s, ms) => waitFor(`document.body.textContent.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const submitVisible = (label) => evaluate(`void [...document.querySelectorAll('form button.btn-primary')].find((x) => x.getClientRects().length && x.textContent.includes(${JSON.stringify(label)})).click()`);
const shownOnce = () => evaluate(`document.querySelector('[data-testid="shown-once"] code')?.textContent ?? null`);
const onCard = (cardText, label) => evaluate(`(() => {
  const card = [...document.querySelectorAll('main li')].find((li) => li.innerText.includes(${JSON.stringify(cardText)}));
  const btn = card && [...card.querySelectorAll('button, a')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!btn) return false;
  btn.click();
  return true;
})()`);
const apiGet = (path, key) => fetch(`${API}${path}`, { headers: { authorization: `ApiKey ${key}` } });

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  // ---- on the trial plan: explained, nothing to create ----
  await go('/subscription');
  check('the subscription tabs include Integrations', await evaluate(`[...document.querySelectorAll('main a')].some((a) => a.getAttribute('href') === '/subscription/integrations')`));
  await go('/subscription/integrations');
  check('a plan without API access says so', await shown('part of the Enterprise plan'));
  check('and offers no new key or webhook', !(await evaluate(`document.body.innerText.includes('New API key') || document.body.innerText.includes('New webhook')`)));
  await shot('integrations-trial.png', false);

  // ---- Enterprise: a key, shown once ----
  await setPlan('enterprise');
  await go('/subscription/integrations');
  check('on Enterprise there is no callout', !(await evaluate(`document.body.innerText.includes('part of the Enterprise plan')`)));
  await clickText('New API key');
  await fill('keyName', 'Bookkeeping');
  await submitVisible('Create key');
  await waitFor(`!!document.querySelector('[data-testid="shown-once"] code')`, 8000);
  const key = await shownOnce();
  check('the new key is shown once, in full', /^tlv_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/.test(key ?? ''));
  await shot('integrations-key-made.png', false);
  await clickText('I have copied it');
  await waitFor(`!document.querySelector('[data-testid="shown-once"]')`);
  await go('/subscription/integrations');
  check('the key is listed by its prefix and scopes, never in full', await evaluate(`document.body.innerText.includes(${JSON.stringify(key.slice(0, 15))}) && !document.documentElement.outerHTML.includes(${JSON.stringify(key)}) && document.body.textContent.includes('Entities and branches, Reports')`));
  const branches = await apiGet('/v1/branches', key);
  check('the key reads the branches', branches.status === 200 && (await branches.json()).data.some((x) => x.id === br.id));
  check('outside its scopes it is refused', (await apiGet('/v1/products', key)).status === 403);
  const write = await fetch(`${API}/v1/branches`, { method: 'POST', headers: { authorization: `ApiKey ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ legalEntityId: le.id, code: 'X', name: 'x' }) });
  check('and it can never write', write.status === 403 && (await write.json()).error.code === 'API_KEY_READ_ONLY');
  await go('/subscription/integrations');
  check('the list shows when it was last used', await shown('Last used'));

  // ---- session 22: a key that expires, and renaming the business ----
  await clickText('New API key');
  await fill('keyName', 'Auditor, 30 days');
  await fill('validDays', '30');
  await submitVisible('Create key');
  await waitFor(`!!document.querySelector('[data-testid="shown-once"] code')`, 8000);
  await clickText('I have copied it');
  await go('/subscription/integrations');
  check('a key made for 30 days shows when it expires', await evaluate(`[...document.querySelectorAll('main li')].some((li) => li.innerText.includes('Auditor, 30 days') && li.innerText.includes('Expires'))`));
  const listed = (await (await fetch(`${API}/v1/api-keys`, { headers: { authorization: `Bearer ${tk}` } })).json()).data.find((k) => k.name === 'Auditor, 30 days');
  const days = Math.round((Date.parse(listed.expiresAt) - Date.now()) / 86_400_000);
  check('the API holds an expiry 30 days out', days === 30);
  await evaluate(`window.confirm = () => true`);
  await onCard('Auditor, 30 days', 'Revoke');
  await shown('Revoked', 8000);
  await go('/subscription/business');
  await fill('businessName', 'Cruz Hardware & Tools');
  await submitVisible('Save');
  check('the business is renamed, and the band shows the new name', await shown('Name saved.', 8000) && await waitFor(`document.querySelector('header').innerText.includes('Cruz Hardware & Tools')`, 8000).then(() => true, () => false));
  await go('/subscription/integrations');

  // ---- a webhook to the local receiver ----
  await clickText('New webhook');
  await fill('hookUrl', 'http://');
  await submitVisible('Create webhook');
  check('an address that is not one is refused in place', await shown('Invalid URL', 8000));
  await fill('hookUrl', hookUrl);
  await fill('hookDescription', 'Bookkeeping sync');
  await submitVisible('Create webhook');
  await waitFor(`!!document.querySelector('[data-testid="shown-once"] code')`, 8000);
  let secret = await shownOnce();
  check('the signing secret is shown once', (secret ?? '').startsWith('whsec_'));
  await clickText('I have copied it');
  await go('/subscription/integrations');
  check('the webhook is listed with its events', await shown('Bookkeeping sync') && await shown('Sale completed'));
  check('the secret is not on the page any more', !(await evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`)));

  check('Send a test is pressed', await onCard('Bookkeeping sync', 'Send a test'));
  const ping = await arrival((x) => x.type === 'webhook.ping');
  check('the worker delivers the test', !!ping);
  check('signed with the secret shown at creation', !!ping && signedBy(secret, ping));

  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: nails, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '200.00' }] }, idem());
  const done = await arrival((x) => x.type === 'sale.completed' && JSON.stringify(x).includes(sale.id), 30000);
  check('a sale is delivered as sale.completed with its id', !!done);
  check('the event carries ids, not the receipt', !!done && !done.body.includes('Nails') && !done.body.includes('170.00'));
  check('signed too', !!done && signedBy(secret, done));

  await go('/subscription/integrations');
  check('Deliveries is opened', await onCard('Bookkeeping sync', 'Deliveries'));
  await waitFor(`location.pathname.startsWith('/subscription/integrations/webhooks/')`);
  check('the deliveries list the test and the sale as delivered', await shown('Sale completed') && await shown('Test') && await shown('Delivered'));
  await shot('integrations-deliveries.png', false);

  // ---- a test that fails gives up at once (one try); it can be sent again ----
  failing = true;
  await go('/subscription/integrations');
  await onCard('Bookkeeping sync', 'Send a test');
  const pings = () => received.filter((x) => JSON.parse(x.body).type === 'webhook.ping').length;
  await waitFor(`true`);
  for (const end = Date.now() + 20000; pings() < 2 && Date.now() < end; await sleep(250));
  check('the failing test reached the receiver', pings() === 2);
  await sleep(1000);
  await go(`/subscription/integrations`);
  check('the list counts one that gave up', await shown('1 gave up', 8000));
  await onCard('Bookkeeping sync', 'Deliveries');
  await waitFor(`document.body.innerText.includes('Gave up')`, 8000).catch(() => {});
  check('the deliveries show it gave up with the answer it got', await shown('Gave up') && await shown('500'));
  failing = false;
  await clickText('Send again');
  for (const end = Date.now() + 20000; pings() < 3 && Date.now() < end; await sleep(250));
  check('sent again, it arrives', pings() === 3);

  // ---- a new secret: the old one stops ----
  await go('/subscription/integrations');
  await evaluate(`window.confirm = () => true`);
  await onCard('Bookkeeping sync', 'New secret');
  await waitFor(`!!document.querySelector('[data-testid="shown-once"] code')`, 8000);
  const rotated = await shownOnce();
  check('a new secret is shown, different from the first', (rotated ?? '').startsWith('whsec_') && rotated !== secret);
  await clickText('I have copied it');
  await onCard('Bookkeeping sync', 'Send a test');
  const after = await arrival((x) => x.type === 'webhook.ping' && !received.slice(0, 3).some((r) => JSON.parse(r.body).id === x.id));
  check('the next message is signed with the new secret only', !!after && signedBy(rotated, after) && !signedBy(secret, after));
  secret = rotated;

  // ---- turn it off; revoke the key ----
  await go('/subscription/integrations');
  await onCard('Bookkeeping sync', 'Turn off');
  check('turned off, it says Off and offers no test', await waitFor(`[...document.querySelectorAll('main li')].some((li) => li.innerText.includes('Bookkeeping sync') && li.innerText.includes('Off') && !li.innerText.includes('Send a test'))`, 8000).then(() => true, () => false));
  await evaluate(`window.confirm = () => true`);
  await onCard('Bookkeeping', 'Revoke');
  // Its own card (the 30-day key above is already revoked).
  check('the revoked key says so', await waitFor(`[...document.querySelectorAll('main li')].some((li) => li.querySelector('p.font-semibold')?.textContent === 'Bookkeeping' && li.innerText.includes('Revoked'))`, 8000).then(() => true, () => false));
  check('and no longer reads', (await apiGet('/v1/branches', key)).status === 401);

  // ---- the guide, Filipino, phone width ----
  await go('/help#subscription');
  check('the guide explains integrations', await shown('Integrations (Enterprise)'));
  await viewport(390, 844);
  await go('/subscription/integrations');
  check('at 390 px nothing scrolls sideways', await noHorizontalScroll());
  await shot('integrations-390.png', false);
  await viewport(1440, 900);
  await evaluate(`fetch('/api/auth/lang', { method: 'POST', headers: { 'content-type': 'application/json', 'x-onepos-request': '1' }, body: JSON.stringify({ lang: 'fil' }) })`);
  await go('/subscription/integrations');
  check('in Filipino', await shown('Mga integrasyon') && await shown('Mga API key'));
  await shot('integrations-fil.png', false);
  await evaluate(`fetch('/api/auth/lang', { method: 'POST', headers: { 'content-type': 'application/json', 'x-onepos-request': '1' }, body: JSON.stringify({ lang: 'en' }) })`);
} finally {
  b.close();
  receiver.close();
}
finish();
