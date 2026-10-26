// End-to-end test of packs, expiry dates and recalls in a retail shop's back office (ADR-0020,
// ADR-0025 §5; retail only since 2026-10-25): sign up (no type of business to choose); "Keeps expiry
// dates" on a new product; link a pack to its pieces on the pack's page; a till sale of pieces opens a
// pack by itself and Inventory → Packs shows it for that sale; open a pack by hand; Inventory → Batch
// trace follows a lot; Inventory → Lot holds places a hold (shown on the expiry list) and releases it;
// Inventory → Expiry lists an expired lot and writes it off; the expired-stock rule (no choice = allow)
// and the expiry alert days are set; the guide's "Packs, expiry dates and recalls" part; Filipino;
// phone width.
// Usage: node apps/admin-web/e2e/packs.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/api.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

const slug = `packs-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Aling Nena', tenantSlug: slug });
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
// Lot codes are optional: the expired lot has one, the fresh lot has another (for the hold).
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Delivery', items: [
  { variantId: milkId, quantity: '4', unitCost: '33.00', expiresOn: day(-3), lotCode: 'EV-OLD' },
  { variantId: milkId, quantity: '6', unitCost: '33.00', expiresOn: day(20), lotCode: 'EV-NEW' },
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
  check('no Appointments or Pharmacy tab', !(await evaluate(`[...document.querySelectorAll('header a')].some((a) => ['Appointments', 'Pharmacy'].includes(a.textContent.trim()))`)));

  // ---- a new product offers "Keeps expiry dates", off until ticked ----
  await go('/products');
  await clickText('Add product');
  await waitFor(`document.querySelector('input[name="tracksExpiry"]')`);
  check('“Keeps expiry dates” is offered, not ticked, and no medicine or kind of product is asked', await evaluate(`!document.querySelector('input[name="tracksExpiry"]').checked && !document.querySelector('[name="productType"], [name="drugClass"], [name="genericName"]')`));

  // ---- link the pack to its pieces ----
  await go(`/products/${coffeeTie.id}`);
  check('the pack’s page has Packs and pieces, not linked yet', await shownAnyCase('Packs and pieces (tingi)') && (await text()).includes('Not linked to a pack'));
  await clickText('Link a pack and its pieces');
  await waitFor(`document.querySelector('[name="piecesPerPack"]')`);
  await fill('pieceVariantId', sachetId);
  await fill('piecesPerPack', '10');
  await submitFormOf('piecesPerPack');
  check('the link reads 1 × tie = 10 × sachet, opening by itself', await shown('1 × Coffee 3-in-1 (tie of 10) = 10 × Coffee 3-in-1 sachet', 8000) && (await text()).toLowerCase().includes('opens by itself'));
  await shot('packs-pack-link.png', false);
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
  await shot('packs-packs.png');

  // ---- batch trace: where a lot came from and what is left ----
  await go('/inventory');
  check('Inventory has Lot holds and Batch trace tabs', await shown('Lot holds') && (await text()).includes('Batch trace'));
  await go(`/inventory/batches?${new URLSearchParams({ variant: milkId, lot: 'EV-OLD' })}`);
  check('the batch trace shows lot EV-OLD on hand (4) and its delivery', await shownAnyCase('Lot EV-OLD: on hand now', 8000) && await evaluate(`[...document.querySelectorAll('[data-trace-onhand]')].some((x) => x.textContent.trim() === '4')`) && (await text()).includes('Stock adjustment'));
  check('the batch trace shows no branch picker (it covers every branch)', !(await evaluate(`[...document.querySelectorAll('nav a')].some((a) => a.getAttribute('href')?.startsWith('/inventory/batches?branch='))`)));
  await shot('packs-batch-trace.png');

  // ---- lot holds: place one, see it on the expiry list, release it ----
  await go('/inventory/holds');
  await clickText('Hold a batch');
  await waitFor(`document.querySelector('[name="lotCode"]')`);
  await fill('variantId', milkId);
  await fill('lotCode', 'EV-NEW');
  await fill('reason', 'Recall by the supplier');
  await fill('reference', 'Advisory 2026-77');
  await submitFormOf('lotCode');
  check('the hold is listed, in force', await waitFor(`!!document.querySelector('[data-hold-lot="EV-NEW"]') && !!document.querySelector('[data-hold-open]')`, 8000).then(() => true, () => false) && (await text()).toLowerCase().includes('advisory 2026-77'));
  const holds = (await call('GET', '/v1/stock/lot-holds', tk)).data;
  check('the API agrees: one hold on EV-NEW at every branch', holds.length === 1 && holds[0].lotCode === 'EV-NEW' && holds[0].branchId === null);
  await shot('packs-holds.png');
  await go(`/inventory/expiry?branch=${br.id}`);
  check('the expiry list marks the held lot “On hold”', await waitFor(`!!document.querySelector('[data-lot-held]')`, 8000).then(() => true, () => false));
  await go('/inventory/holds');
  await clickText('Release');
  await waitFor(`[...document.querySelectorAll('[name="reason"]')].some((x) => x.getClientRects().length)`);
  await fill('reason', 'Supplier cleared the batch');
  await submitFormOf('reason');
  check('released: no hold in force', await waitFor(`!document.querySelector('[data-hold-open]')`, 8000).then(() => true, () => false));
  const released = (await call('GET', '/v1/stock/lot-holds?includeReleased=true', tk)).data;
  check('the API agrees: the hold is released with its reason', released.length === 1 && !!released[0].releasedAt && released[0].releaseReason === 'Supplier cleared the batch');

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
  await shot('packs-expiry.png');

  // ---- settings: the expired-stock rule and the alert days ----
  await go(`/inventory/settings?branch=${br.id}`);
  check('expired stock: two choices, a branch never set reads as Allow; holds never sell', await evaluate(`document.querySelectorAll('input[name="expiredStock"]').length === 2 && document.querySelector('input[name="expiredStock"][value="ALLOW"]')?.checked === true`) && (await text()).includes('Lots on hold (Lot holds) are never sold') && !(await text()).toLowerCase().includes('pharmac'));
  await evaluate(`document.querySelector('input[name="expiredStock"][value="BLOCK"]').click()`);
  await fill('expiryAlertDays', '7');
  await submitFormOf('expiryAlertDays');
  const settings = await shown('Saved', 8000).then(() => call('GET', `/v1/branches/${br.id}/inventory-settings`, tk));
  check('the rule and the expiry alert days are saved', settings.expiryAlertDays === 7 && settings.expiredStock === 'BLOCK' && settings.expiredStockRule === 'BLOCK');

  // ---- the guide ----
  await go('/help');
  check('the guide has the “Packs, expiry dates and recalls” part', await shown('Packs, expiry dates and recalls') && (await text()).includes('Inventory → Batch trace'));
  for (const path of [`/inventory/packs?branch=${br.id}`, '/inventory/holds', '/inventory/batches']) {
    await go(path);
    check(`the help button on ${path.split('?')[0]} opens that part`, await evaluate(`[...document.querySelectorAll('a[href^="/help"]')].some((a) => a.getAttribute('href') === '/help#tingi')`));
  }

  await go(`/inventory/packs?branch=${br.id}`);
  await clickText('FIL');
  check('Filipino: the Packs page is translated', await shownAnyCase('Mga binuksang pakete', 8000));
  await go(`/inventory/expiry?branch=${br.id}`);
  check('Filipino: the Expiry page is translated', await shownAnyCase('Expired at malapit nang mag-expire', 8000));
  await go('/inventory/holds');
  check('Filipino: the Lot holds page is translated', await shownAnyCase('Hold sa lot', 8000) && (await text()).includes('I-hold ang batch'));
  await clickText('EN');
  await viewport(390, 844, true);
  for (const path of [`/inventory/expiry?branch=${br.id}`, `/inventory/packs?branch=${br.id}`, '/inventory/holds', `/inventory/batches?${new URLSearchParams({ variant: milkId, lot: 'EV-NEW' })}`, `/products/${coffeeTie.id}`]) {
    await go(path);
    check(`390px: no sideways scroll on ${path.split('?')[0]}`, await noHorizontalScroll());
  }
  await go(`/inventory/expiry?branch=${br.id}`);
  await shot('packs-expiry-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
