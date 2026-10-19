// End-to-end test of the admin user guide (/help): the band's help button on every page opens the
// part about that page; the guide lists every area the business offers, marks none for an owner,
// links to each area; the band still fits all twelve tabs at 1440px with a long business name;
// a retail shop sees no restaurant part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/guide.mjs [baseUrl] [screenshotDir] [apiUrl]
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

const call = client(API);
const stamp = Date.now().toString(36);
const email = `guide-${stamp}@example.ph`;
// Long on purpose: the help button joins the band, which must still fit every tab at 1440px.
const BUSINESS = `Sari-sari Store at Karinderya ni Aling Lorna sa Kanto ng Mabini ${stamp}`;
await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Lorna Reyes', businessName: BUSINESS, tenantSlug: `guide-${stamp}`, businessType: 'HYBRID' });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9349 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const helpHref = () => evaluate(`document.querySelector('header a[href^="/help"]')?.getAttribute('href') ?? null`);
const sectionIds = () => evaluate(`[...document.querySelectorAll('main article[id]')].map((a) => a.id)`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);

  check('1440px, long business name: the help button is in the band and all twelve tabs still fit', await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    const help = document.querySelector('header a[href^="/help"]');
    const r = help?.getBoundingClientRect();
    return nav.querySelectorAll('a').length === 12 && nav.scrollWidth <= nav.clientWidth + 1 && !!r && r.right <= innerWidth && r.width > 0;
  })()`));
  check('…and it has a label for screen readers and a tooltip', await evaluate(`(() => { const a = document.querySelector('header a[href^="/help"]'); return a.title === 'Help and user guide' && a.innerText.includes('Help and user guide'); })()`));
  await shot('guide-band-1440.png', false);
  check('on the overview it opens Getting started', (await helpHref()) === '/help#start');
  check('the setup checklist links to the guide', await evaluate(`[...document.querySelectorAll('aside a')].some((a) => a.getAttribute('href') === '/help#start' && a.textContent.includes('Read the user guide'))`));

  // The button follows the page.
  const pages = [['/products', 'products'], ['/prices', 'prices'], ['/inventory/counts', 'inventory'], ['/purchasing', 'purchasing'], ['/books/periods', 'books'], ['/restaurant/menus', 'restaurant'], ['/reports/z-readings', 'reports'], ['/offline-sales', 'offline'], ['/shifts', 'drawers'], ['/locations', 'locations'], ['/team', 'team'], ['/audit', 'team'], ['/subscription/export', 'subscription']];
  const wrong = [];
  for (const [path, topic] of pages) {
    await go(path);
    const href = await helpHref();
    if (href !== `/help#${topic}`) wrong.push(`${path} → ${href}`);
  }
  check(`the help button opens the part about each page (${pages.length} pages) ${wrong.join(', ')}`, wrong.length === 0);

  // From Inventory, through the button.
  await go('/inventory');
  await evaluate(`document.querySelector('header a[href^="/help"]').click()`);
  await waitFor(`location.pathname === '/help' && location.hash === '#inventory'`);
  await waitFor(`document.getElementById('inventory') && Math.abs(document.getElementById('inventory').getBoundingClientRect().top - 96) < 40`, 5000).catch(() => undefined);
  check('clicking it lands on the Inventory part, below the sticky band', await evaluate(`(() => { const r = document.getElementById('inventory').getBoundingClientRect(); return r.top >= 64 && r.top < 200; })()`));
  check('on the guide page the button is marked current', await evaluate(`document.querySelector('header a[href^="/help"]').getAttribute('aria-current') === 'page'`));
  await shot('guide-inventory-1440.png', false);

  await go('/help');
  const all = ['start', 'products', 'prices', 'inventory', 'purchasing', 'restaurant', 'reports', 'books', 'offline', 'drawers', 'locations', 'team', 'subscription', 'account', 'till'];
  check('a business that does both sees every part, in set-up order', JSON.stringify(await sectionIds()) === JSON.stringify(all));
  check('the contents link to every part', await evaluate(`[...document.querySelectorAll('nav[aria-label="Contents"] a')].map((a) => a.getAttribute('href')).join() === ${JSON.stringify(all.map((i) => `#${i}`).join())}`));
  check('each part has numbered steps', await evaluate(`[...document.querySelectorAll('main article')].every((a) => a.querySelectorAll('ol li').length >= 3)`));
  check('an owner has no part marked as outside the role', !(await text()).includes('Not in your role'));
  check('parts link to their area (Open Inventory → /inventory, Open Getting started → /)', await evaluate(`(() => {
    const link = (id) => document.getElementById(id).querySelector('a.btn')?.getAttribute('href');
    return link('inventory') === '/inventory' && link('reports') === '/reports/sales' && link('start') === '/' && link('account') === '/account';
  })()`));
  check('restaurant steps and selling-by-weight tips both show for a business that does both', (await text()).includes('Restaurant reports: item performance') && (await text()).includes('set “Sold by” to Weight'));
  await shot('guide-1440.png');

  // Filipino.
  await clickText('FIL');
  // Section titles are set in caps by CSS, which innerText reflects.
  check('Filipino: the guide is translated', await shown('Gabay sa paggamit') && (await text()).toLowerCase().includes('mabuting malaman') && (await text()).includes('Pagsisimula'));
  check('Filipino: the help button label too', await evaluate(`document.querySelector('header a[href^="/help"]').title === 'Tulong at gabay sa paggamit'`));
  await shot('guide-fil-1440.png', false);
  await clickText('EN');
  await shown('User guide');

  // Phone.
  await viewport(390, 844, true);
  await go('/help');
  check('390px: no sideways scroll on the guide', await noHorizontalScroll());
  check('390px: the help button is still in the band', await evaluate(`(() => { const r = document.querySelector('header a[href^="/help"]').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })()`));
  await shot('guide-390.png', false);
  await viewport(1440, 900);

  // A retail shop.
  const changed = await bff('PATCH', '/api/v1/business', { businessType: 'RETAIL' }, true);
  check('the business becomes a retail shop', changed.status === 200);
  await go('/help');
  const retail = await sectionIds();
  check('retail: no restaurant part, everything else stays', !retail.includes('restaurant') && retail.length === all.length - 1);
  check('retail: no restaurant lines in other parts, selling by weight still explained', !(await text()).includes('Restaurant reports: item performance') && !(await text()).includes('Servers can “Work the floor”') && (await text()).includes('set “Sold by” to Weight'));
  await go('/restaurant');
  check('retail: on a restaurant page the help button opens the part about changing the type of business', (await helpHref()) === '/help#subscription');

  const back = await bff('PATCH', '/api/v1/business', { businessType: 'RESTAURANT' }, true);
  await go('/help');
  check('restaurant: the part is back, and selling by weight is not explained', back.status === 200 && (await sectionIds()).includes('restaurant') && !(await text()).includes('set “Sold by” to Weight'));
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
