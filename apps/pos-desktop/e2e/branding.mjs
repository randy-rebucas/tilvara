// End-to-end test of branding at the counter in browser mode (session 39): before sign-in the till is
// Tilvara's; once signed in its band takes the business's colour and logo, its background sits behind
// the register screen, a sale's receipt prints the business's messages and contact lines around the
// names a receipt must show, and the customer display is told the welcome and thank-you words.
// Usage: node apps/pos-desktop/e2e/branding.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './api.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

/** A solid-colour PNG (enough for the till to show and the test to measure). */
function png(w, h, [r, g, bl]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, bl][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- arrangement (API) ----
const slug = `posbrand-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Santos', businessName: 'Nena Store', tenantSlug: slug });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Santos Trading', tradeName: 'Tindahan ni Nena', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'B1', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Front' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const SKU = `COLA-${slug}`.toUpperCase();
const cola = (await call('POST', '/v1/products', tk, { name: 'Cola', taxCategoryId: vat, uomId: pc, variants: [{ sku: SKU, price: '25.00' }] }, idem())).variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '10', unitCost: '15.00' }] }, idem());
await call('PUT', '/v1/business/branding', tk, {
  displayName: 'Tindahan ni Nena', brandColor: '#1e5b3a', receiptHeader: 'Bukas araw-araw', receiptFooter: 'Salamat po!',
  contactPhone: '0917 123 4567', instagram: 'nena.store', displayWelcome: 'Maligayang pagdating!', displayThanks: 'Salamat, balik po kayo!',
});
await call('PUT', '/v1/business/branding/logo', tk, { data: png(96, 96, [30, 91, 58]).toString('base64') });
await call('PUT', '/v1/business/branding/background', tk, { data: png(320, 180, [212, 162, 39]).toString('base64') });

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9358 });
const { evaluate, viewport, waitFor, go, fill, shot } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const bandColor = () => evaluate(`getComputedStyle(document.querySelector('header.band')).backgroundColor`);

try {
  await viewport(1440, 900);
  await go('/');
  check('before sign-in a till in a browser is Tilvara’s', (await evaluate(`document.querySelector('header.band').innerText.includes('Tilvara')`)) && (await bandColor()) === 'rgb(42, 93, 168)');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Front')`);
  await waitFor(`(() => { const i = document.querySelector('[data-testid=brand-logo]'); return !!i && i.complete && i.naturalWidth > 0; })()`, 10000).catch(() => {});
  check('signed in: the band shows the logo', await evaluate(`(() => { const i = document.querySelector('[data-testid=brand-logo]'); return !!i && i.naturalWidth === 96; })()`));
  check('…in the business’s colour', (await bandColor()) === 'rgb(30, 91, 58)');
  check('…and the main buttons take it too', await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-blue').trim() === '#1e5b3a'`));
  check('the register screen has the background behind it', await evaluate(`getComputedStyle(document.querySelector('[data-testid=brand-backdrop]')).backgroundImage.includes('blob:')`));
  await shot('branding-registers.png', false);

  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === 'Front').querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  check('the counter has no background behind the sale', await evaluate(`!document.querySelector('[data-testid=brand-backdrop]')`));

  // The customer display asks for the look when it opens: the till answers with the words and images.
  const display = await evaluate(`new Promise((resolve) => {
    const ch = new BroadcastChannel('tilvara-customer-display');
    ch.onmessage = (e) => { if (e.data?.kind === 'brand') { ch.close(); resolve(e.data.brand); } };
    ch.postMessage({ kind: 'hello' });
    setTimeout(() => resolve(null), 4000);
  })`);
  check('the customer display is told the welcome and thank-you words, colour and images', display?.welcome === 'Maligayang pagdating!' && display?.thanks === 'Salamat, balik po kayo!' &&
    display?.brandColor === '#1e5b3a' && String(display?.logoUrl).startsWith('blob:') && String(display?.backgroundUrl).startsWith('blob:'));

  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(SKU)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(800);
  await evaluate(`(() => { const el = document.getElementById('cash'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '50'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`!document.getElementById('pay-submit').disabled`, 8000);
  await evaluate(`document.getElementById('pay-submit').click()`);
  check('the receipt shows', await shown('Tindahan ni Nena', 10000) && (await shown('Nena Santos Trading', 10000)));
  const receipt = await evaluate(`document.querySelector('.printable')?.innerText ?? ''`);
  const at = (s) => receipt.indexOf(s);
  check('the message prints above the names a receipt must show', at('Bukas araw-araw') >= 0 && at('Bukas araw-araw') < at('Nena Santos Trading'));
  check('the footer and contact lines print last, after the cashier', at('Cashier:') >= 0 && at('Salamat po!') > at('Cashier:') && at('0917 123 4567') > at('Salamat po!') && receipt.includes('instagram.com/nena.store'));
  check('the not-an-invoice notice is still there', receipt.includes('NOT AN OFFICIAL INVOICE') || receipt.includes('NOT AN INVOICE') || receipt.includes('TEST'));
  check('the receipt carries the logo', await evaluate(`!!document.querySelector('.printable img')`));
  await shot('branding-receipt.png', false);
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
