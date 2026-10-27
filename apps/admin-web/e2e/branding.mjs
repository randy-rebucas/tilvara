// End-to-end test of Subscription → Branding (session 39): an owner adds a logo and a background,
// sets the colour (a too-light one is refused before it is sent), the till name, receipt messages,
// contact details and the customer display's words; the band follows; the shop's own sign-in page at
// /s/<slug> shows only once switched on, signs a member straight into the business and refuses an
// outsider; the page reads in Filipino and fits a phone; removing the logo brings the wordmark back.
// Usage: node apps/admin-web/e2e/branding.mjs [baseUrl] [screenshotDir] [apiUrl]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';

/** A PNG of `w`×`h` pixels, coloured by `px(x, y)` → [r, g, b]. */
function png(w, h, px) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = mkdtempSync(join(tmpdir(), 'tilvara-brand-'));
const logoFile = join(dir, 'logo.png');
const backgroundFile = join(dir, 'background.png');
const svgFile = join(dir, 'logo.svg');
// A maroon ring on white (the logo) and a soft green-to-gold wash (the background).
writeFileSync(logoFile, png(160, 160, (x, y) => (Math.abs(Math.hypot(x - 80, y - 80) - 55) < 14 ? [122, 31, 61] : [255, 255, 255])));
writeFileSync(backgroundFile, png(640, 360, (x, y) => [60 + Math.round((x / 640) * 150), 110 + Math.round((y / 360) * 80), 70]));
writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

const call = client(API);
const stamp = Date.now().toString(36);
const slug = `brand-${stamp}`;
const email = `brand-${stamp}@example.ph`;
const outsider = `brand-out-${stamp}@example.ph`;
await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Santos', businessName: `Tindahan ni Nena ${stamp}`, tenantSlug: slug });
await call('POST', '/v1/auth/signup', null, { email: outsider, password: PASSWORD, displayName: 'Other Owner', businessName: `Other ${stamp}`, tenantSlug: `brand-out-${stamp}` });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9357 });
const { send, evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll, bff } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const bandColor = () => evaluate(`getComputedStyle(document.querySelector('header.band')).backgroundColor`);
const bandLogoLoaded = () => evaluate(`(() => { const i = document.querySelector('header.band img'); return !!i && i.complete && i.naturalWidth > 0; })()`);

/** Put a file into a (hidden) file input, as choosing it in the dialog would. */
async function choose(selector, file) {
  const { result } = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  await send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
}

async function signIn(path, who) {
  await go(path);
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
}

try {
  await viewport(1440, 900);
  // Before the business switches it on, its sign-in page is not there.
  await go(`/s/${slug}`);
  check('/s/<slug> is not found until the business switches the page on', !(await shown('Sign in to', 1500)));

  await signIn('/sign-in', email);
  await waitFor(`location.pathname === '/'`);
  check('the band shows the business name before any branding (session 41)', (await evaluate(`document.querySelector('header.band a[href="/"]').textContent.trim()`)) === `Tindahan ni Nena ${stamp}`);

  await go('/subscription');
  check('Subscription has a Branding tab', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/subscription/branding' && a.textContent.trim() === 'Branding')`));
  await go('/subscription/branding');
  check('the Branding page opens with its sections', (await shown('Logo and background')) && (await shown('Receipts')) && (await shown('Customer display')) && (await shown('Your sign-in page')));
  check('the help button opens the Subscription part', await evaluate(`document.querySelector('header a[href^="/help"]')?.getAttribute('href') === '/help#subscription'`));

  const field = (name) => evaluate(`document.querySelector('[name="${name}"]').value`);
  check('a new business starts with suggested receipt messages', (await field('receiptHeader')) === 'Open daily, 8:00 AM to 8:00 PM' &&
    (await field('receiptFooter')) === 'Thank you for shopping with us!\nKeep this receipt for returns within 7 days.');
  check('…shown in the receipt preview', (await evaluate(`document.querySelector('[aria-label="Receipt preview"]').innerText`)).includes('Thank you for shopping with us!'));
  await fill('receiptFooter', 'Changed');
  await clickText('Use suggested text');
  check('"Use suggested text" puts the suggestion back', (await field('receiptFooter')).startsWith('Thank you for shopping with us!'));

  await choose('#brand-logo-file', svgFile);
  check('an SVG is refused with words', await shown('Use a PNG, JPEG or WebP image.', 8000));
  await choose('#brand-logo-file', logoFile);
  await waitFor(`(() => { const i = document.querySelector('header.band img'); return !!i && i.complete && i.naturalWidth > 0; })()`, 15000).catch(() => {});
  check('a PNG logo is saved and the band shows it at once', await bandLogoLoaded());
  await go('/');
  await waitFor(`document.querySelector('header.band img')?.complete`, 8000).catch(() => {});
  check('1440px: the band shows the logo and the name together, and every tab still fits (session 41)', await evaluate(`(() => {
    const nav = document.querySelector('header nav');
    return !!document.querySelector('header.band a[href="/"] img') && document.querySelector('[data-testid="band-name"]')?.textContent === ${JSON.stringify(`Tindahan ni Nena ${stamp}`)}
      && nav.querySelectorAll('a').length > 10 && nav.scrollWidth <= nav.clientWidth + 1;
  })()`));
  await go('/subscription/branding');
  await shown('Logo and background');
  check('its size is shown', await shown('160 × 160 px'));
  await choose('#brand-background-file', backgroundFile);
  check('the background is saved', await shown('640 × 360 px', 15000));

  // A colour white text cannot be read on: refused on the page, nothing sent.
  await fill('brandColor', '#f5e663');
  check('a too-light colour is refused before saving', await shown('Too light'));
  const before = (await bff('GET', '/api/v1/business/branding')).body;
  await clickText('Save');
  await sleep(600);
  check('…and nothing was saved', (await bff('GET', '/api/v1/business/branding')).body.brandColor === before.brandColor);

  await fill('displayName', 'Tindahan ni Nena');
  await fill('brandColor', '#7a1f3d');
  await fill('receiptHeader', 'Bukas araw-araw, 7am–9pm');
  await fill('receiptFooter', 'Salamat po!\nReturns within 7 days with this slip');
  await fill('contactPhone', '0917 123 4567');
  await fill('facebook', '@TindahanNiNena');
  await fill('website', 'nena.example.ph');
  await fill('displayWelcome', 'Maligayang pagdating!');
  await fill('displayThanks', 'Salamat, balik po kayo!');
  const preview = await evaluate(`document.querySelector('[aria-label="Receipt preview"]')?.innerText ?? ''`);
  check('the receipt preview shows the messages and contact lines', preview.includes('Bukas araw-araw') && preview.includes('Salamat po!') && preview.includes('facebook.com/TindahanNiNena') && preview.includes('nena.example.ph'));
  check('the band preview takes the colour', (await evaluate(`getComputedStyle(document.querySelector('[data-testid="brand-band-preview"]')).backgroundColor`)) === 'rgb(122, 31, 61)');
  await evaluate(`[...document.querySelectorAll('input[type="checkbox"]')].find((x) => x.getClientRects().length).click()`);
  // The /s/ address, or the business's own one where the server has a shop domain (session 41).
  check('switching the sign-in page on shows its address', (await shown(`/s/${slug}`, 2000)) || (await shown(`//${slug}.`, 2000)));
  await clickText('Save');
  check('saved', await shown('Branding saved.', 8000));
  await waitFor(`getComputedStyle(document.querySelector('header.band')).backgroundColor === 'rgb(122, 31, 61)'`, 8000).catch(() => {});
  check('the band takes the brand colour', (await bandColor()) === 'rgb(122, 31, 61)');
  const saved = (await bff('GET', '/api/v1/business/branding')).body;
  check('the API has it all, the website with https:// and the page name without @', saved.website === 'https://nena.example.ph' && saved.facebook === 'TindahanNiNena' && saved.publicSignIn === true && saved.receiptFooter.includes('\n'));
  const me = (await bff('GET', '/api/v1/me')).body.activeTenant.branding;
  check('/me carries the name, colour and image hashes', me.displayName === 'Tindahan ni Nena' && me.brandColor === '#7a1f3d' && /^[0-9a-f]{64}$/.test(me.logoSha256) && /^[0-9a-f]{64}$/.test(me.backgroundSha256));
  await shot('branding-1440.png', true);

  // The other pages keep their denomination colours: only the band changed.
  await go('/products');
  check('other pages: the band is branded, primary buttons stay Tilvara blue', (await bandColor()) === 'rgb(122, 31, 61)' &&
    (await evaluate(`getComputedStyle(document.querySelector('main .btn-primary') ?? document.body).backgroundColor`)) !== 'rgb(122, 31, 61)');
  check('the band still fits at 1440 (no sideways scroll)', await noHorizontalScroll());

  // Filipino.
  await go('/subscription/branding');
  await clickText('FIL');
  check('Filipino: the page and its tab', (await shown('Logo at background')) && (await shown('Mga resibo')) && (await shown('Tatak ng tindahan')));
  await shot('branding-fil-1440.png', false);
  await clickText('EN');
  await shown('Logo and background');

  // The shop's own sign-in page, signed out.
  await send('Network.clearBrowserCookies');
  await go(`/s/${slug}`);
  check('/s/<slug>: "Sign in to" the shop, in its colour, with its logo and background', (await shown('Sign in to Tindahan ni Nena', 8000)) &&
    (await bandColor()) === 'rgb(122, 31, 61)' && (await bandLogoLoaded()) &&
    (await evaluate(`getComputedStyle(document.querySelector('header.band').parentElement).backgroundImage.includes('/api/public/shops/${slug}/background')`)));
  await shot('branding-shop-sign-in-1440.png', false);
  await signIn(`/s/${slug}`, outsider);
  check('an account outside the shop is refused with words', await shown('not part of this shop', 8000));
  await signIn(`/s/${slug}`, email);
  await waitFor(`location.pathname === '/'`, 15000);
  check('a member signs straight into the business', (await bff('GET', '/api/v1/me')).body.activeTenant?.branding?.displayName === 'Tindahan ni Nena');

  await viewport(390, 844, true);
  await go('/subscription/branding');
  await shown('Logo and background');
  check('390px: the Branding page has no sideways scroll', await noHorizontalScroll());
  await shot('branding-390.png', true);
  await send('Network.clearBrowserCookies');
  await go(`/s/${slug}`);
  await shown('Sign in to');
  check('390px: the shop sign-in page has no sideways scroll', await noHorizontalScroll());
  await shot('branding-shop-sign-in-390.png', false);
  await viewport(1440, 900);

  // Removing the logo and switching the page off.
  await signIn('/sign-in', email);
  await waitFor(`location.pathname === '/'`, 15000);
  await go('/subscription/branding');
  await shown('Logo and background');
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Remove' && x.getClientRects().length).click()`);
  await waitFor(`document.querySelector('header.band a[href="/"]').textContent.trim() === 'Tindahan ni Nena'`, 8000).catch(() => {});
  check('removing the logo brings the brand name back', (await evaluate(`document.querySelector('header.band a[href="/"]').textContent.trim()`)) === 'Tindahan ni Nena');
  const off = await bff('PUT', '/api/v1/business/branding', { ...saved, publicSignIn: false });
  check('switching the page off (API)', off.status === 200 && off.body.publicSignIn === false);
  const gone = await fetch(`${BASE}/api/public/shops/${slug}/background`);
  check('…and its images are no longer served', gone.status === 404);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
