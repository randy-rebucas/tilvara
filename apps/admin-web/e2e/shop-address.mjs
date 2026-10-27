// End-to-end test of a business's own address (session 40): `<slug>.<ONEPOS_SHOP_DOMAIN>` sends to
// the main sign-in until the business switches its sign-in page on; then its /sign-in is the shop's
// page under the same address, signs a member into that business only, refuses an outsider, keeps
// sign-up, choosing a business and support on the main admin, refuses switching to another business,
// keeps its session apart from the main admin's, ignores a shop header a browser sends, and fits a phone.
// Needs `next start` with ONEPOS_SHOP_DOMAIN=localhost and ONEPOS_ADMIN_URL=<baseUrl> on another host
// (the main admin at http://127.0.0.1:<port>, shops at <slug>.localhost:<port>).
// Usage: node apps/admin-web/e2e/shop-address.mjs [baseUrl] [screenshotDir] [apiUrl] [shopDomain]
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const SHOP_DOMAIN = process.argv[5] ?? 'localhost';

const call = client(API);
const stamp = Date.now().toString(36);
const slug = `addr-${stamp}`;
const email = `addr-${stamp}@example.ph`;
const outsider = `addr-out-${stamp}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lito Reyes', businessName: `Reyes Hardware ${stamp}`, tenantSlug: slug });
const other = await call('POST', '/v1/auth/signup', null, { email: outsider, password: PASSWORD, displayName: 'Other Owner', businessName: `Other ${stamp}`, tenantSlug: `addr-out-${stamp}` });
const reserved = await fetch(`${API}/v1/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `addr-www-${stamp}@example.ph`, password: PASSWORD, displayName: 'X', businessName: 'X', tenantSlug: 'www' }),
});

const main = new URL(BASE);
const port = main.port ? `:${main.port}` : '';
const shopUrl = `${main.protocol}//${slug}.${SHOP_DOMAIN}${port}`;
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9361 });
const { send, evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll, bff } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const at = () => evaluate('location.href');
async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`);
  await sleep(400);
}
// Which business this browser's session on the current address is in: the band names it (the proxy
// forwards no GET of /me, only what the browser loads itself).
const bandName = () => evaluate(`document.querySelector('[data-testid="band-name"]')?.textContent ?? null`);
/** The hand-off page redeems its code only on a click (audit 2026-10-27 #23). */
const continueHandoff = () => evaluate(`[...document.querySelectorAll('button.btn-primary')].filter((x) => x.getClientRects().length).at(-1)?.click()`);
async function signIn(who) {
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
}

try {
  await viewport(1440, 900);
  check('sign-up refuses a reserved web address', reserved.status === 422 && (await reserved.json()).error.code === 'SLUG_RESERVED');

  await goto(`${shopUrl}/`);
  check('before the page is on, the address goes to the main sign-in', (await at()).startsWith(`${BASE}/sign-in`));
  await goto(`${main.protocol}//nobody-${stamp}.${SHOP_DOMAIN}${port}/sign-in`);
  check('…as does a subdomain nobody uses', (await at()).startsWith(`${BASE}/sign-in`));

  // The owner switches the page on in Branding, which then shows the business's own address.
  await go('/sign-in');
  await signIn(email);
  await waitFor(`location.pathname === '/'`);
  await go('/subscription/branding');
  await evaluate(`[...document.querySelectorAll('input[type="checkbox"]')].find((x) => x.getClientRects().length).click()`);
  check('Branding shows the own address once the page is switched on', await waitFor(`document.querySelector('[data-testid="own-address"]')?.textContent === ${JSON.stringify(shopUrl)}`).then(() => true, () => false));
  await clickText('Save');
  check('…and saves', await shown('Saved'));
  await sleep(10_500); // the earlier miss is remembered for 10 s

  await goto(`${shopUrl}/`);
  check('signed out, the own address opens its sign-in page under the same address', (await at()) === `${shopUrl}/sign-in` && (await shown(`Sign in to Reyes Hardware ${stamp}`)));
  await shot('shop-address-sign-in');

  await goto(`${BASE}/s/${slug}?next=/products`);
  check('the main address’s /s/<slug> moves to the own address’s sign-in (session 41)', decodeURIComponent(await at()) === `${shopUrl}/sign-in?next=/products`);
  await goto(`${BASE}/s/addr-out-${stamp}`);
  check('…but not for a shop whose page is off', (await at()) === `${BASE}/s/addr-out-${stamp}`);
  await goto(`${shopUrl}/`);

  await signIn(outsider);
  check('an outsider is refused there', await shown('not part of this shop’s team', 8000));

  await goto(`${shopUrl}/sign-up`);
  check('sign-up lives on the main admin', (await at()).startsWith(`${BASE}/sign-up`));
  await goto(`${shopUrl}/s/addr-out-${stamp}`);
  check('another shop’s /s/ page is not served on this address', (await at()) === `${shopUrl}/sign-in`);

  await signIn(email);
  await waitFor(`location.pathname === '/'`, 15000);
  check('a member lands in the back office on the own address', (await at()) === `${shopUrl}/`);
  check('…signed in to this business', (await bandName()) === `Reyes Hardware ${stamp}`);
  check('the band names the business, not Tilvara (session 41)', (await evaluate(`document.querySelector('[data-testid="band-name"]')?.textContent`)) === `Reyes Hardware ${stamp}`);
  const sw = await bff('POST', '/api/auth/switch', { tenantId: other.activeTenantId });
  check('switching to another business is refused here', sw.status === 403);
  await goto(`${shopUrl}/select-business`);
  check('choosing a business lives on the main admin', (await at()).startsWith(`${BASE}/`) && !(await at()).startsWith(shopUrl));

  // Main host: a login sent with a forged shop header signs in by the body only.
  await go('/sign-in');
  const viaHeader = await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-onepos-request': '1', 'x-onepos-shop-tenant': ${JSON.stringify(owner.activeTenantId)} }, body: JSON.stringify({ email: ${JSON.stringify(outsider)}, password: ${JSON.stringify(PASSWORD)} }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  check('a shop header from the browser is ignored', viaHeader.status === 200 && viaHeader.body.activeTenantId === other.activeTenantId);

  await goto(`${shopUrl}/`);
  check('the own address kept its own session', (await at()) === `${shopUrl}/` && (await bandName()) === `Reyes Hardware ${stamp}`);

  // Session 41: signing in on the main address continues on the business's own address, signed in there.
  await bff('POST', '/api/auth/logout', {});
  await goto(`${BASE}/sign-in?next=/products`);
  await signIn(email);
  check('the own address asks before taking the sign-in over', await waitFor(`location.href.startsWith(${JSON.stringify(`${shopUrl}/handoff`)})`, 15000).then(() => true, () => false) && (await shown('Continue to', 8000)));
  check('…with the code already out of the address', !(await at()).includes('code='));
  await shot('shop-address-handoff-confirm');
  await continueHandoff();
  check('a sign-in on the main address lands on the own address', await waitFor(`location.href === ${JSON.stringify(`${shopUrl}/products`)}`, 15000).then(() => true, () => false));
  check('…without the code left in the address', !(await at()).includes('code='));
  check('…signed in there to this business', (await bandName()) === `Reyes Hardware ${stamp}`);
  await goto(`${shopUrl}/handoff#code=${'x'.repeat(43)}`);
  check('a hand-off while signed in here names who is signed in', await shown('You are signed in here as Lito Reyes', 8000));
  await continueHandoff();
  check('a spent or made-up code asks to sign in', await shown('expired or was already used', 8000));
  await shot('shop-address-handoff-failed');
  await goto(`${BASE}/handoff#code=${'x'.repeat(43)}`);
  await continueHandoff();
  check('…and the main address takes no code', await shown('expired or was already used', 8000));
  await goto(`${BASE}/`);
  check('the main address keeps its own session', (await at()) === `${BASE}/`);

  await viewport(390, 844);
  await goto(`${shopUrl}/`);
  await bff('POST', '/api/auth/logout', {});
  await goto(`${shopUrl}/`);
  check('signed out there, it is back at its sign-in page', (await at()) === `${shopUrl}/sign-in`);
  check('the page fits a phone', await noHorizontalScroll());
  await goto(`${shopUrl}/forgot-password`);
  check('other sign-in pages on the own address carry the business name too', (await evaluate(`document.querySelector('header.band').textContent`)).includes(`Reyes Hardware ${stamp}`));
  await goto(`${BASE}/forgot-password`);
  check('…and on the main address, Tilvara', (await evaluate(`document.querySelector('header.band').textContent`)).startsWith('Tilvara'));
  await shot('shop-address-390');
} finally {
  await b.close?.();
}
finish();
