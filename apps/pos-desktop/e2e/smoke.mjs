// End-to-end smoke test for the POS counter (browser mode), over CDP with local Edge/Chrome.
// Usage: node apps/pos-desktop/e2e/smoke.mjs [posUrl] [screenshotDir] [apiUrl]
// Requires the API (RATE_LIMITS_ENABLED=false) and the POS (vite preview, port 3330) running.
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const PASSWORD = 'correct horse battery staple';

// --- arrange a shop through the API (owner holds every permission, incl. manager actions)
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
const slug = `pos-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Reyes', businessName: 'Tindahan ni Aling Nena', tenantSlug: slug, businessType: 'RETAIL' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Nena Reyes Trading', tradeName: 'Tindahan ni Aling Nena', tin: '123-456-789', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter 1' });
const taxes = Object.fromEntries((await call('GET', '/v1/tax-categories', tk)).data.map((x) => [x.code, x.id]));
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const product = async (name, sku, barcode, price, tax = 'VAT') =>
  (await call('POST', '/v1/products', tk, { name, taxCategoryId: taxes[tax], uomId: pc, variants: [{ sku, barcodes: barcode ? [barcode] : [], price }] }, { 'idempotency-key': randomUUID() })).variants[0].id;
const cola = await product('Coke Mismo 290ml', 'CK-290', '4801981116072', '22.40');
await product('Dinorado Rice 1kg', 'RICE-1', null, '56.00', 'VAT_EXEMPT');
await product('Pancit Canton Chilimansi', 'PC-CHILI', '4807770270017', '16.50');
// Sold by the kilo, labelled by the scale: scale code 212345 (session 16).
const kg = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'KG').id;
await call('POST', '/v1/products', tk, { name: 'Pork belly', taxCategoryId: taxes.VAT_EXEMPT, uomId: kg, soldBy: 'WEIGHT', trackInventory: false, variants: [{ sku: 'PORK-KG', barcodes: ['212345'], price: '320.00' }] }, { 'idempotency-key': randomUUID() });
const ean13 = (first12) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1); return `${first12}${(10 - (sum % 10)) % 10}`; };
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '24' }] }, { 'idempotency-key': randomUUID() });

// --- drive the counter
const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9336 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const scan = async (code) => {
  await evaluate(`(() => { const el = document.getElementById('scan'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
  await sleep(500);
};
const setInput = (id, value) =>
  evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
// The Sell view stays mounted (hidden) behind other tabs: act on the visible form only.
const submitVisible = () => evaluate(`[...document.querySelectorAll('form .btn-primary')].find((e) => e.getClientRects().length).click()`);
const shown = (s) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`).then(() => true, () => false);
const totalShows = (amount) => waitFor(`document.querySelector('[aria-label="Total due"] .money')?.textContent.includes(${JSON.stringify(amount)})`, 8000).then(() => true, () => false);

try {
  await viewport(1440, 900);
  await go('/');
  check('sign-in screen with browser-mode notice', (await text()).toLowerCase().includes('browser mode'));
  await shot('sign-in.png', false);
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Counter 1')`);
  await clickText('Open shift');
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  check('shift opened; counter shows the scan field focused', await evaluate(`document.activeElement?.id === 'scan'`));
  check('retail shop: the counter tabs are Sell, This shift and Close shift', (await evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].filter((x) => x.offsetParent !== null).map((x) => x.textContent.trim()).join('|')`)) === 'Sell|This shift|Close shift');

  // Customer display (session 16): opened before the sale. A same-origin iframe stands in for the
  // second window (the till feeds it over a BroadcastChannel, which reaches both alike).
  check('the counter offers the customer display', await evaluate(`Boolean(document.querySelector('button[title="Open the customer display"]'))`));
  await evaluate(`(() => { const f = document.createElement('iframe'); f.id = 'cd'; f.src = '/?display=customer'; f.style.cssText = 'position:fixed;right:0;bottom:0;width:480px;height:320px;'; document.body.appendChild(f); })()`);
  const display = () => evaluate(`document.getElementById('cd')?.contentDocument?.body?.innerText ?? ''`);
  check('the display greets while the cart is empty', await waitFor(`(document.getElementById('cd')?.contentDocument?.body?.innerText ?? '').includes('Welcome')`).then(() => true, () => false));

  // Sale 1: barcode + SKU, cash with change
  await scan('4801981116072');
  await scan('RICE-1');
  check('server-priced total for barcode + SKU items (₱78.40)', await totalShows('₱78.40'));
  check('VAT breakdown shows VATable and exempt sales', /VATable sales[\s\S]*₱20\.00/.test(await text()) && /VAT-exempt sales[\s\S]*₱56\.00/.test(await text()));
  check('the customer display shows the lines and the server-priced total ₱78.40', await waitFor(`(document.getElementById('cd')?.contentDocument?.body?.innerText ?? '').includes('₱78.40')`).then(() => true, () => false) && /Coke Mismo|Rice/.test(await display()));
  await shot('sell-cart.png', false);

  // User guide (? in the band, or F1): opens over the counter at the part you are on; the cart stays.
  // Sent to the focused element, as a keyboard does (the guide holds back the counter's keys in the capture phase).
  const pressKey = (k) => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  const cashValue = () => evaluate(`document.getElementById('cash')?.value ?? null`);
  const cashBefore = await cashValue();
  await evaluate(`document.querySelector('header button[title^="Help and user guide"]').click()`);
  await waitFor(`document.getElementById('guide-sell')`);
  check('the ? button opens the guide at Sell, marked "You are here"', await evaluate(`document.getElementById('guide-sell').innerText.includes('You are here') && !document.getElementById('guide-start').innerText.includes('You are here')`));
  check('the guide has the counter parts only, with the desktop till and problems', await evaluate(`[...document.querySelectorAll('[id^="guide-"][aria-labelledby]')].map((e) => e.id).join(',') === 'guide-start,guide-sell,guide-shift,guide-close,guide-till,guide-trouble'`));
  check('the counter is hidden behind the guide, which lists the counter keys', await evaluate(`document.querySelector('main').hidden`) && (await text()).includes('F8 exact cash'));
  await shot('guide-sell.png', false);
  await pressKey('F8');
  await pressKey('Escape');
  await waitFor(`!document.querySelector('main').hidden`);
  check('Esc returns to the same cart (₱78.40), and F8 behind the guide did not fill in the cash', await totalShows('₱78.40') && (await cashValue()) === cashBefore);
  await pressKey('F1');
  check('F1 opens the guide too', await waitFor(`document.getElementById('guide-sell')`).then(() => true, () => false));
  const lang = (l) => evaluate(`[...document.querySelectorAll('[role=group][data-testid=language] button')].find((x) => x.textContent === ${JSON.stringify(l)}).click()`);
  await lang('fil');
  check('Filipino: the guide is translated', await shown('Gabay sa paggamit') && (await text()).includes('Narito ka'));
  await lang('en');
  await shown('User guide');
  await clickText('Back');
  await waitFor(`!document.querySelector('main').hidden`);
  check('Back returns to the cart', await totalShows('₱78.40'));

  await clickText('₱100.00');
  await sleep(200);
  check('change preview ₱21.60', (await text()).includes('₱21.60'));
  await clickText('Complete sale');
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const r1 = await text();
  check('receipt: not an invoice, VAT REG TIN, reference R1-000001', r1.includes('VAT REG TIN 123-456-789-00000') && r1.includes('R1-000001'));
  check('the customer display thanks and shows the change ₱21.60', await waitFor(`(document.getElementById('cd')?.contentDocument?.body?.innerText ?? '').includes('Thank you')`).then(() => true, () => false) && (await display()).includes('₱21.60'));
  await evaluate(`document.getElementById('cd').remove()`);
  await shot('receipt-cash.png');
  await clickText('New sale');

  // Sale 2: SC/PWD on a line, paid by card
  await scan('PC-CHILI');
  await clickText('SC/PWD');
  await waitFor(`document.querySelector('input[name="name"]')`);
  await fill('name', 'Corazon Dela Cruz');
  await fill('idNumber', 'OSCA-0001');
  await clickText('Apply');
  check('SC computed by server: ₱16.50 → ₱11.78 due', await totalShows('₱11.78'));
  check('pending-review notice shown for SC/PWD', (await text()).includes('tax-professional sign-off'));
  await shot('sell-sc.png', false);
  await clickText('Card');
  await waitFor(`document.body.innerText.includes('Approved')`);
  await clickText('Complete sale');
  await waitFor(`document.body.innerText.includes('Signature')`);
  const r2 = await text();
  check('card sale receipt carries the SC block with ID and signature line', r2.includes('OSCA-0001') && r2.includes('CARD'));
  await shot('receipt-sc-card.png');
  await clickText('New sale');

  // Return one Coke from sale 1 (owner has sales.refund)
  await clickText('This shift');
  await waitFor(`document.body.innerText.includes('#000001')`);
  await clickText('#000001');
  await waitFor(`document.body.innerText.includes('Return items')`);
  await clickText('Return items');
  await waitFor(`document.querySelector('[id^="qty-"]')`);
  const qtyId = await evaluate(`document.querySelector('[id^="qty-"]').id`);
  await setInput(qtyId, '1');
  await setInput('reason', 'Dented can');
  await submitVisible();
  check('cash refund for the returned item (₱22.40)', await waitFor(`document.body.innerText.includes('Refund ₱22.40')`).then(() => true, () => false));
  check('the refund slip is shown to print: against R1-000001, REFUND ₱22.40, never an invoice', await shown('RETURN / REFUND — NOT AN OFFICIAL INVOICE')
    && (await text()).toLowerCase().includes('return 1 of r1-000001') && (await text()).includes('Reason: Dented can') && /REFUND\s+₱22\.40/.test(await text()));
  await shot('history-refund-slip.png');
  await clickText('Show the sale receipt');
  await shot('history-return.png');
  check('shift history tags: #000001 cash with items returned, #000002 card', await evaluate(`(() => {
    // innerText follows CSS text-transform (the time line is a serial): compare in lower case.
    const rows = [...document.querySelectorAll('li button')].filter((b) => b.getClientRects().length).map((b) => b.innerText.toLowerCase());
    const one = rows.find((r) => r.includes('#000001')) ?? '';
    const two = rows.find((r) => r.includes('#000002')) ?? '';
    return one.includes('cash') && one.includes('items returned') && two.includes('card') && !two.includes('items returned');
  })()`));

  // Close: expected = 1000 + 78.40 cash − 22.40 refund (card sale moves no cash)
  await clickText('Close shift');
  check('expected drawer ₱1,056.00', await waitFor(`document.body.innerText.includes('₱1,056.00')`).then(() => true, () => false));
  await fill('counted', '1056.00');
  await submitVisible();
  check('drawer balanced on close', await waitFor(`document.body.innerText.includes('Drawer balanced')`).then(() => true, () => false));
  await shot('close-balanced.png', false);

  const openShift = async () => {
    await clickText('Back');
    await waitFor(`document.body.innerText.includes('Counter 1')`);
    await clickText('Open shift');
    await fill('float', '0');
    await submitVisible();
    await waitFor(`document.getElementById('scan')`);
  };

  // Phase 2 exit drills at the counter: the cart survives a look at the shift, a double-clicked
  // Complete records one sale, and a card payment with no sale blocks the close until settled.
  await openShift();
  await scan('4801981116072');
  await clickText('This shift');
  await sleep(300);
  await clickText('Sell');
  check('cart survives switching to the shift history and back', await totalShows('₱22.40'));
  await clickText('₱50.00');
  await sleep(200);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Complete sale')); b.click(); b.click(); })()`);
  await waitFor(`document.body.innerText.includes('NOT AN OFFICIAL INVOICE')`);
  const ws = (await call('GET', '/v1/pos/workstations', tk)).data.find((w) => w.openSession?.mine);
  const shiftSales = (await call('GET', `/v1/sales?cashierSessionId=${ws.openSession.id}`, tk)).data;
  check('double-clicked Complete sale records exactly one sale (R1-000003)', shiftSales.length === 1 && (await text()).includes('R1-000003'));
  await clickText('New sale');
  await scan('4801981116072');
  await clickText('Card');
  await waitFor(`document.body.innerText.includes('Approved')`);
  await clickText('Close shift');
  await waitFor(`document.getElementById('counted')`);
  await fill('counted', '22.40');
  await submitVisible();
  check('close refused while a card payment belongs to no sale', await shown('not part of a sale') && (await text()).includes('Cancel payment'));
  await shot('close-blocked.png', false);
  await clickText('Cancel payment');
  await waitFor(`!document.body.innerText.includes('Cancel payment')`);
  await submitVisible();
  check('after cancelling the card payment the drawer closes balanced (₱22.40)', await shown('Drawer balanced'));

  // Keyboard: F8 exact cash, F9 complete, F2 a new sale (a scanner-and-keyboard counter needs no mouse).
  await openShift();
  const key = (k) => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`);
  await scan('4801981116072');
  await totalShows('₱22.40');
  await key('F8');
  check('F8 enters the exact cash', await waitFor(`document.getElementById('cash')?.value === '22.40'`).then(() => true, () => false));
  await key('F9');
  check('F9 completes the sale', await shown('NOT AN OFFICIAL INVOICE'));
  await key('F2');
  check('F2 starts a new sale with the scan field focused', await waitFor(`document.activeElement?.id === 'scan'`).then(() => true, () => false));

  // A weighing-scale label: the pork belly at the printed 1.234 kg (1.234 × ₱320.00 = ₱394.88).
  await scan(ean13('212345012340'));
  check('a scale label rings up the weighed item at its printed weight (₱394.88)', await totalShows('₱394.88') && (await text()).includes('Pork belly'));
  await evaluate(`[...document.querySelectorAll('button[aria-label="Remove"]')].filter((x) => x.getClientRects().length).forEach((x) => x.click())`);
  await waitFor(`!document.body.innerText.includes('Pork belly')`);

  // Layout at a tablet counter and a phone width (three lines push the payment panel below the fold)
  await scan('4801981116072');
  await scan('RICE-1');
  await scan('PC-CHILI');
  await totalShows('₱94.90');
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await viewport(w, h, w < 500);
    await evaluate('window.scrollTo(0, 0)');
    await sleep(400);
    check(`no horizontal scroll at ${w}px`, await noHorizontalScroll());
    await shot(`sell-${w}.png`, false);
  }
  check('phone: total and Pay stay at the bottom while the cart scrolls', await evaluate(`(() => {
    const bar = document.querySelector('[data-testid="pay-bar"]');
    if (!bar || !bar.getClientRects().length) return false;
    const r = bar.getBoundingClientRect();
    return getComputedStyle(bar).position === 'fixed' && Math.abs(r.bottom - window.innerHeight) < 2 && bar.innerText.includes('₱94.90') && bar.innerText.includes('3 lines');
  })()`));
  await evaluate(`document.querySelector('[data-testid="pay-bar"] button').click()`);
  check('Pay brings the payment panel up and the bar steps aside', await waitFor(`!document.querySelector('[data-testid="pay-bar"]') && document.activeElement?.id === 'cash'`).then(() => true, () => false));
  await viewport(1440, 900);
  check('desktop: no pay bar; the shortcut keys are listed', await evaluate(`!document.querySelector('[data-testid="pay-bar"]')?.getClientRects().length && document.body.innerText.includes('exact cash')`));

  // Filipino
  await clickText('fil');
  await sleep(200);
  check('Filipino UI', (await text()).includes('Kabuuang babayaran'));
  await shot('sell-fil.png', false);
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  b.close();
}
finish();
