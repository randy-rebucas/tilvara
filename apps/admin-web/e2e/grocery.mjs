// End-to-end test of a sari-sari store (ADR-0020) in the back office: sign up as "Sari-sari store or
// grocery" (no Restaurant tab, the box "Keeps expiry dates" ticked on a new product); link a pack to
// its pieces on the pack's page; a till sale of pieces opens a pack by itself and Inventory → Packs
// shows it for that sale; open a pack by hand; Inventory → Expiry lists an expired lot and writes it
// off; the expiry alert days are set; the guide's "Tingi and expiry dates" part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/grocery.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

const slug = `sari-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Sari-sari ni Aling Nena', tenantSlug: slug, businessType: 'GROCERY' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Store', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'TON-01', name: 'Tondo' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const tag = slug.slice(-5).toUpperCase();
const product = async (name, sku, price, extra = {}) => (await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, ...extra, variants: [{ sku, price }] }, idem()));
const coffeeTie = await product('Coffee 3-in-1 (tie of 10)', `TIE-${tag}`, '85.00', { tracksExpiry: true });
const coffee = await product('Coffee 3-in-1 sachet', `SCH-${tag}`, '9.00', { tracksExpiry: true });
const tieId = coffeeTie.variants[0].id;
const sachetId = coffee.variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Delivery', items: [{ variantId: tieId, quantity: '3', unitCost: '70.00', expiresOn: day(120) }] }, idem());
const milk = await product('Evap milk 370ml', `EVP-${tag}`, '42.00', { tracksExpiry: true });
const milkId = milk.variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Delivery', items: [
  { variantId: milkId, quantity: '4', unitCost: '33.00', expiresOn: day(-3), lotCode: 'EV-OLD' },
  { variantId: milkId, quantity: '6', unitCost: '33.00', expiresOn: day(20) },
] }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9356 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
// Section titles and serial lines are uppercased by CSS: compare those without case.
const shownAnyCase = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary') ?? undefined);
})()`);

try {
  await viewport(1440, 900);
  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  check('a sari-sari store has no Restaurant tab', !(await evaluate(`[...document.querySelectorAll('header a')].some((a) => a.textContent.trim() === 'Restaurant')`)));
  await go('/subscription/business');
  check('the business page shows the type chosen at sign-up', await evaluate(`document.querySelector('input[name=businessType][value=GROCERY]').checked`));

  // ---- a new product starts with "Keeps expiry dates" ticked ----
  await go('/products');
  await clickText('Add product');
  await waitFor(`document.querySelector('input[name="tracksExpiry"]')`);
  check('“Keeps expiry dates” is ticked for a new product', await evaluate(`document.querySelector('input[name="tracksExpiry"]').checked`));

  // ---- link the pack to its pieces ----
  await go(`/products/${coffeeTie.id}`);
  check('the pack’s page has Packs and pieces, not linked yet', await shownAnyCase('Packs and pieces (tingi)') && (await text()).includes('Not linked to a pack'));
  await clickText('Link a pack and its pieces');
  await waitFor(`document.querySelector('[name="piecesPerPack"]')`);
  await fill('pieceVariantId', sachetId);
  await fill('piecesPerPack', '10');
  await submitFormOf('piecesPerPack');
  check('the link reads 1 × tie = 10 × sachet, opening by itself', await shown('1 × Coffee 3-in-1 (tie of 10) = 10 × Coffee 3-in-1 sachet', 8000) && (await text()).toLowerCase().includes('opens by itself'));
  await shot('grocery-pack-link.png', false);
  await go(`/products/${coffee.id}`);
  check('the piece’s page shows the same link', await shown('= 10 × Coffee 3-in-1 sachet'));

  // ---- a sale of sachets opens a tie by itself ----
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' });
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: sachetId, quantity: '3' }], tenders: [{ method: 'CASH', tendered: '100.00' }] }, idem());
  await go(`/inventory/packs?branch=${br.id}`);
  check('Inventory → Packs lists the tie opened for the sale', await shown(`For sale #${sale.saleNumber}`, 8000) && (await text()).includes('Coffee 3-in-1 (tie of 10)'));
  const stock = (await call('GET', `/v1/stock/balances?branchId=${br.id}`, tk)).data;
  const onHand = (id) => stock.find((s) => s.variantId === id)?.quantity;
  check('the API agrees: 2 ties and 7 sachets left', onHand(tieId) === '2' && onHand(sachetId) === '7');

  // ---- open a tie by hand ----
  await clickText('Open a pack');
  await waitFor(`document.querySelector('[name="packs"]')`);
  await fill('packs', '1');
  await fill('reason', 'For the shelf');
  await submitFormOf('packs');
  check('the tie opened by hand is listed with its reason', await shown('For the shelf', 8000));
  await shot('grocery-packs.png');

  // ---- expiry ----
  await go(`/inventory/expiry?branch=${br.id}`);
  check('Inventory → Expiry lists the expired evaporated milk first, with its lot', await shown('Expired 3 d ago', 8000) && (await text()).includes('EV-OLD'));
  check('the expired total is shown at cost (4 × ₱33)', (await text()).includes('₱132.00'));
  check('the lot due in 20 days is listed, the coffee due in 120 is not', (await text()).includes('In 20 d') && !(await text()).includes('Coffee 3-in-1'));
  await evaluate(`window.confirm = () => true`);
  await clickText('Write off');
  check('written off: no expired lot left', await waitFor(`!document.body.innerText.includes('EV-OLD')`, 8000).then(() => true, () => false));
  const lots = (await call('GET', `/v1/stock/lots?branchId=${br.id}&variantId=${milkId}`, tk));
  check('the API agrees: 6 left, all dated in 20 days', lots.onHand === '6' && lots.data.length === 1 && lots.data[0].quantity === '6');
  await go(`/inventory/expiry?branch=${br.id}&days=90`);
  check('a wider window shows more (90 days still leaves the coffee out)', await shown('In 20 d') && !(await text()).includes('Coffee 3-in-1 (tie'));
  await shot('grocery-expiry.png');

  // ---- settings and the guide ----
  await go(`/inventory/settings?branch=${br.id}`);
  await fill('expiryAlertDays', '7');
  await submitFormOf('expiryAlertDays');
  check('the expiry alert days are saved', await shown('Saved', 8000).then(async (ok) => ok && (await call('GET', `/v1/branches/${br.id}/inventory-settings`, tk)).expiryAlertDays === 7));
  await go('/help');
  check('the guide has the “Tingi and expiry dates” part', await shown('Tingi and expiry dates'));
  await go(`/inventory/packs?branch=${br.id}`);
  check('the help button on Packs opens that part', await evaluate(`[...document.querySelectorAll('a[href^="/help"]')].some((a) => a.getAttribute('href') === '/help#tingi')`));

  await clickText('FIL');
  check('Filipino: the Packs page is translated', await shownAnyCase('Mga binuksang pakete', 8000));
  await go(`/inventory/expiry?branch=${br.id}`);
  check('Filipino: the Expiry page is translated', await shownAnyCase('Expired at malapit nang mag-expire', 8000));
  await clickText('EN');
  await viewport(390, 844, true);
  for (const path of [`/inventory/expiry?branch=${br.id}`, `/inventory/packs?branch=${br.id}`, `/products/${coffeeTie.id}`]) {
    await go(path);
    check(`390px: no sideways scroll on ${path.split('?')[0]}`, await noHorizontalScroll());
  }
  await go(`/inventory/expiry?branch=${br.id}`);
  await shot('grocery-expiry-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
