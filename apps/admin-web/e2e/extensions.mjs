// End-to-end test of Subscription → Extensions (ADR-0026): with nothing in the catalog the page says so;
// with a demo extension in the catalog an owner switches it on and off, /me follows, the page reads in
// Filipino, a plan without it shows why it cannot be switched on, and the page fits a phone.
// No extension ships yet, so the demo catalog row (`e2e_demo`, on Growth) is arranged in the dev database
// as the migrator (DATABASE_MIGRATOR_URL from .env) and withdrawn again at the end.
// Usage: node apps/admin-web/e2e/extensions.mjs [baseUrl] [screenshotDir] [apiUrl]
import { createRequire } from 'node:module';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');

const DEMO = 'e2e_demo';
const call = client(API);
const stamp = Date.now().toString(36);
const email = `ext-${stamp}@example.ph`;
const tk = (await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Ana Cruz', businessName: `Botika ni Ana ${stamp}`, tenantSlug: `ext-${stamp}` })).tokens.accessToken;

const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
await db.connect();
/** The demo extension in the catalog, offered on Growth (the trial plan), or withdrawn. */
async function demo(offered) {
  if (offered) {
    await db.query(
      `INSERT INTO extensions (code, name, description) VALUES ($1, 'E2E demo', 'Checks the extension switch from the admin.')
       ON CONFLICT (code) DO UPDATE SET active = true`,
      [DEMO],
    );
    await db.query(`UPDATE plans SET extensions = extensions || $1::jsonb WHERE code = 'growth' AND NOT extensions ? $2`, [JSON.stringify([DEMO]), DEMO]);
  } else {
    await db.query(`UPDATE plans SET extensions = extensions - $1`, [DEMO]);
    await db.query(`UPDATE extensions SET active = false WHERE code = $1`, [DEMO]);
  }
}
const allowOnGrowth = (on) =>
  on
    ? db.query(`UPDATE plans SET extensions = extensions || $1::jsonb WHERE code = 'growth' AND NOT extensions ? $2`, [JSON.stringify([DEMO]), DEMO])
    : db.query(`UPDATE plans SET extensions = extensions - $1 WHERE code = 'growth'`, [DEMO]);

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9351 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll, bff } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
// Lower-cased: the status line is drawn in capitals (innerText follows text-transform).
const card = async () => (await evaluate(`document.querySelector('[data-extension="${DEMO}"]')?.innerText ?? ''`)).toLowerCase();
const meExtensions = async () => (await call('GET', '/v1/me', tk))?.activeTenant?.extensions ?? null;

try {
  await demo(false);
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  await go('/subscription');
  check('Subscription has an Extensions tab', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/subscription/extensions' && a.textContent.trim() === 'Extensions')`));
  await go('/subscription/extensions');
  check('with nothing in the catalog the page says none are available yet', await shown('No extensions are available yet', 8000));
  check('the help button opens the Subscription part', await evaluate(`document.querySelector('header a[href^="/help"]')?.getAttribute('href') === '/help#subscription'`));
  await shot('extensions-empty-1440.png', false);

  await demo(true);
  await go('/subscription/extensions');
  await waitFor(`!!document.querySelector('[data-extension="${DEMO}"]')`);
  const off = await card();
  check('the demo extension is listed, off, with its description and Switch on', off.includes('e2e demo') && off.includes('off') && off.includes('checks the extension switch') && off.includes('switch on'));
  check('/me lists no extension yet', JSON.stringify(await meExtensions()) === '[]');

  await clickText('Switch on');
  await waitFor(`document.querySelector('[data-extension="${DEMO}"]')?.innerText.includes('Switch off')`);
  check('Switch on: it shows On with Switch off', (await card()).split('\n').includes('on'));
  check('/me now lists it', JSON.stringify(await meExtensions()) === JSON.stringify([DEMO]));
  await shot('extensions-on-1440.png', false);

  await clickText('FIL');
  await shown('Mga extension');
  const fil = await card();
  check('Filipino: the page and the switch', fil.includes('naka-on') && fil.includes('i-off') && (await shown('Mga extension', 2000)));
  await shot('extensions-fil-1440.png', false);
  await clickText('EN');
  await shown('Extensions');

  await evaluate('window.confirm = () => true');
  await clickText('Switch off');
  await waitFor(`document.querySelector('[data-extension="${DEMO}"]')?.innerText.includes('Switch on')`);
  check('Switch off (after the confirmation): it shows Off again', (await card()).split('\n').includes('off'));
  check('/me lists none again', JSON.stringify(await meExtensions()) === '[]');

  await allowOnGrowth(false);
  await go('/subscription/extensions');
  await waitFor(`!!document.querySelector('[data-extension="${DEMO}"]')`);
  const notOnPlan = await card();
  check('a plan without it: "Not on your plan" and no switch', notOnPlan.includes('not on your plan') && !notOnPlan.includes('switch on'));
  const refused = await bff('POST', `/api/v1/extensions/${DEMO}/enable`, {});
  check('…and the API refuses switching it on (403 ENTITLEMENT_REQUIRED)', refused.status === 403 && refused.body?.error?.code === 'ENTITLEMENT_REQUIRED');

  await viewport(390, 844, true);
  await go('/subscription/extensions');
  await waitFor(`!!document.querySelector('[data-extension="${DEMO}"]')`);
  check('390px: no sideways scroll', await noHorizontalScroll());
  await shot('extensions-390.png', false);
  await viewport(1440, 900);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
} finally {
  await demo(false).catch((e) => console.error('could not withdraw the demo extension', e));
  await db.end();
}
finish();
