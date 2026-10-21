// End-to-end test of a pharmacy or drugstore (ADR-0025) in the back office: the sign-up offers
// "Pharmacy or drugstore"; the band has Pharmacy (and no Restaurant); a new product starts as a
// medicine that keeps expiry dates, and the Medicine section saves its class, generic name, strength
// and form (badge and generic on the list, search by generic name); a box → strip → piece chain is
// linked; a stock adjustment of the medicine with an expiry date is refused without its lot code and
// posted with one; a prescription is recorded, edited and voided, another is filled by a till sale
// (through the API, as the till does) and shows its fill and its sale's medicine line; a dangerous
// drug is sold against a yellow-form prescription by the owner once their pharmacist licence is
// recorded; the prescription and dangerous drugs books with their CSV; the SC/PWD book's booklet
// column; a batch is traced to its sale, held for every branch (On hold on the expiry list) and
// released; the expired-stock rule per branch; the customer's prescriptions; the BFF keeps the
// till's approval route out; the guide's part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/pharmacy.mjs [baseUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review/pharmacy';
const API = (process.argv[4] ?? 'http://127.0.0.1:4320').replace(/\/v1\/?$/, '');
mkdirSync(OUT, { recursive: true });
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));
const today = day(0);

const slug = `rx-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Rosa Mercado', businessName: 'Botika ni Rosa', tenantSlug: slug, businessType: 'PHARMACY' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Rosa Mercado Drugstore', tin: '234-567-890', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Cubao' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'R1', name: 'Counter' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const tag = slug.slice(-5).toUpperCase();
const medicine = async (name, sku, price, drug) => (await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, tracksExpiry: true, drug, variants: [{ sku, price }] }, idem()));
const amox = (form) => ({ drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: form });
const box = await medicine('Amoxil 500 mg (box of 10 strips)', `BOX-${tag}`, '900.00', amox('CAPSULE'));
const strip = await medicine('Amoxil 500 mg (strip of 10)', `STR-${tag}`, '95.00', amox('CAPSULE'));
const tramadol = await medicine('Tramal 50 mg capsule', `TRM-${tag}`, '25.00', { drugClass: 'DANGEROUS', genericName: 'Tramadol', strength: '50 mg', dosageForm: 'CAPSULE' });
const biogesic = await medicine('Biogesic 500 mg tablet', `BIO-${tag}`, '5.00', { drugClass: 'OTC', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET' });
const ddId = tramadol.variants[0].id;
const bioId = biogesic.variants[0].id;
await call('POST', '/v1/stock/adjustments', tk, { branchId: br.id, reason: 'Opening stock', items: [
  { variantId: ddId, quantity: '30', unitCost: '18.00', expiresOn: day(300), lotCode: 'TRM-77' },
  { variantId: bioId, quantity: '100', unitCost: '3.00', expiresOn: day(400), lotCode: 'BIO-12' },
] }, idem());
const customer = await call('POST', '/v1/customers', tk, { displayName: 'Lito Garcia', phone: '0917 555 0404' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9391 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, bff, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
// Section titles, tags and serial lines are uppercased by CSS: compare those without case.
const lower = () => evaluate('document.body.innerText.toLowerCase()');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const shownAnyCase = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const present = (sel, ms = 8000) => waitFor(`Boolean([...document.querySelectorAll(${JSON.stringify(sel)})].some((x) => x.getClientRects().length))`, ms).then(() => true, () => false);
const clickButton = (label) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!el) throw new Error('no button ${label}');
  el.click();
})()`);
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary, button.btn-danger') ?? undefined);
})()`);
const hintOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  return el?.closest('.field')?.querySelector('.hint')?.textContent ?? '';
})()`);
const csv = (q) => evaluate(`fetch('/reports/export?' + ${JSON.stringify(new URLSearchParams(q).toString())}).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.text() }))`);

try {
  await viewport(1440, 900);
  // ---- sign-up offers the pharmacy type ----
  await go('/sign-up');
  check('sign-up offers “Pharmacy or drugstore”', await evaluate(`Boolean(document.querySelector('input[name=businessType][value=PHARMACY]')) && document.body.textContent.includes('Pharmacy or drugstore')`));

  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  const tabs = await evaluate(`[...document.querySelectorAll('header nav a')].map((a) => a.textContent.trim())`);
  check('a pharmacy has the Pharmacy tab and no Restaurant, Laundry or Appointments', tabs.includes('Pharmacy') && !tabs.includes('Restaurant') && !tabs.includes('Laundry') && !tabs.includes('Appointments'));
  check('the band fits at 1440px', await evaluate(`(() => { const n = document.querySelector('nav[data-testid=main-nav]'); return n.scrollWidth <= n.clientWidth + 1; })()`) && (await noHorizontalScroll()));
  await go('/subscription/business');
  check('the business page shows the type chosen at sign-up', await evaluate(`document.querySelector('input[name=businessType][value=PHARMACY]').checked`));

  // ---- a medicine on the product form ----
  await go('/products');
  await clickButton('Add product');
  await waitFor(`document.querySelector('[name="genericName"]')`);
  check('a new product starts as a medicine that keeps expiry dates', await evaluate(`document.querySelector('input[name="isDrug"]').checked && document.querySelector('input[name="tracksExpiry"]').checked`));
  check('every class is offered to a pharmacy', await evaluate(`[...document.querySelector('[name="drugClass"]').options].map((o) => o.value).join() === 'OTC,RX,ANTIBIOTIC,DANGEROUS'`));
  await fill('name', 'Amoxil 500 mg capsule');
  await fill('sku', `CAP-${tag}`);
  await fill('price', '10.00');
  await fill('drugClass', 'ANTIBIOTIC');
  await fill('genericName', 'Amoxicillin');
  await fill('strength', '500 mg');
  await fill('dosageForm', 'CAPSULE');
  await fill('fdaRegistrationNo', 'DR-XY45678');
  await shot('pharmacy-product-form.png', false);
  await submitFormOf('genericName');
  const listed = await waitFor(`[...document.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Amoxil 500 mg capsule')`, 10000).then(() => true, () => false);
  check('the product list shows the new medicine with its generic and the Antibiotic badge', listed && (await evaluate(`(() => { const a = [...document.querySelectorAll('main a')].find((x) => x.textContent.trim() === 'Amoxil 500 mg capsule'); const tr = a.closest('tr'); return tr.querySelector('[data-testid=generic]')?.textContent === 'Amoxicillin 500 mg capsule' && !!tr.querySelector('[data-drug-class="ANTIBIOTIC"]'); })()`)));
  const created = (await call('GET', '/v1/products?limit=200', tk)).data.find((p) => p.variants.some((v) => v.sku === `CAP-${tag}`));
  check('the API has the medicine: class, generic, strength, form, FDA no., keeps expiry dates', created?.drugClass === 'ANTIBIOTIC' && created.genericName === 'Amoxicillin' && created.strength === '500 mg' && created.dosageForm === 'CAPSULE' && created.fdaRegistrationNo === 'DR-XY45678' && created.tracksExpiry === true);
  const pieceId = created.variants[0].id;
  await go('/products?q=amoxicillin');
  check('product search matches the generic name (box, strip and capsule)', await shown(`Amoxil 500 mg (box of 10 strips)`) && (await text()).includes('Amoxil 500 mg (strip of 10)') && (await text()).includes('Amoxil 500 mg capsule') && !(await text()).includes('Tramal'));
  await shot('pharmacy-products.png');
  await go(`/products/${created.id}`);
  check('the product page shows the badge, the generic and the FDA no.', await shown('Amoxicillin 500 mg capsule') && (await text()).includes('FDA DR-XY45678') && (await present('[data-drug-class="ANTIBIOTIC"]')));

  // ---- box → strip → piece ----
  await go(`/products/${box.id}`);
  await clickText('Link a pack and its pieces');
  await waitFor(`document.querySelector('[name="piecesPerPack"]')`);
  await fill('pieceVariantId', strip.variants[0].id);
  await fill('piecesPerPack', '10');
  await submitFormOf('piecesPerPack');
  check('the box is linked to 10 strips', await shown('1 × Amoxil 500 mg (box of 10 strips) = 10 × Amoxil 500 mg (strip of 10)', 8000));
  await call('POST', '/v1/pack-conversions', tk, { packVariantId: strip.variants[0].id, pieceVariantId: pieceId, piecesPerPack: '10' }, idem());
  await go(`/products/${strip.id}`);
  check('the strip’s page shows both links: from the box and into capsules', await shown('= 10 × Amoxil 500 mg (strip of 10)') && (await text()).includes('1 × Amoxil 500 mg (strip of 10) = 10 × Amoxil 500 mg capsule'));
  await shot('pharmacy-pack-chain.png', false);

  // ---- receiving with a lot code ----
  await go(`/inventory?branch=${br.id}`);
  await clickText('Adjust stock or record waste');
  await waitFor(`document.querySelector('[name="lines.0.lotCode"]')`);
  await fill('reason', 'Delivery DR-1001');
  await fill('lines.0.variantId', pieceId);
  await fill('lines.0.quantity', '30');
  await fill('lines.0.expiresOn', day(60));
  await submitFormOf('reason');
  const refused = await waitFor(`document.body.innerText.includes('needs its lot (batch) number')`, 8000).then(() => true, () => false);
  check('without the lot code the medicine is refused, the message on the lot field', refused && (await hintOf('lines.0.lotCode')).includes('lot (batch) number'));
  await shot('pharmacy-lot-required.png', false);
  await fill('lines.0.lotCode', 'AMX-001');
  await submitFormOf('reason');
  check('with the lot code it is posted', await waitFor(`location.pathname.startsWith('/inventory/adjustments/')`, 10000).then(() => true, () => false));
  const lots = await call('GET', `/v1/stock/lots?branchId=${br.id}&variantId=${pieceId}`, tk);
  check('the API agrees: 30 capsules in lot AMX-001', lots.onHand === '30' && lots.data[0]?.lotCode === 'AMX-001');

  // ---- a prescription recorded, edited and voided ----
  await go(`/pharmacy?branch=${br.id}`);
  check('Pharmacy opens on the prescriptions, none yet', await shown('No prescriptions to show.'));
  await clickText('New prescription');
  await waitFor(`document.querySelector('[name="patientName"]')`);
  await fill('patientName', 'Ana Santos');
  await fill('prescriberName', 'Dr. Ben Lim');
  await fill('prescriberLicenseNo', '0123456');
  await fill('issuedOn', today);
  await fill('items.0.genericName', 'Amoxicillin');
  await fill('items.0.strength', '500 mg');
  await fill('items.0.dosageForm', 'CAPSULE');
  await fill('items.0.quantity', '21');
  await fill('items.0.drugClass', 'ANTIBIOTIC');
  await fill('items.0.directions', '1 capsule every 8 hours for 7 days');
  await shot('pharmacy-rx-form.png');
  await submitFormOf('patientName');
  check('saved: the prescription page shows 21 left', await waitFor(`/^\\/pharmacy\\/prescriptions\\/[0-9a-f-]{36}$/.test(location.pathname)`, 10000).then(() => true, () => false) && (await shown('Amoxicillin 500 mg capsule', 8000)) && (await evaluate(`document.querySelector('[data-rx-left]')?.textContent === '21'`)));
  const voidRxId = await evaluate(`location.pathname.split('/').at(-1)`);
  await clickText('Edit prescription');
  await waitFor(`document.querySelector('[name="items.0.quantity"]')`);
  await fill('items.0.quantity', '14');
  await submitFormOf('patientName');
  check('edited: 14 left', await waitFor(`location.pathname === '/pharmacy/prescriptions/${voidRxId}' && document.querySelector('[data-rx-left]')?.textContent === '14'`, 10000).then(() => true, () => false));
  await clickButton('Void prescription');
  await waitFor(`document.querySelector('[name="reason"]')`);
  await fill('reason', 'Entered twice');
  await submitFormOf('reason');
  check('voided with its reason', await shown('Entered twice', 8000) && (await present('[data-rx-status="VOIDED"]')));
  check('a voided prescription can no longer be edited or voided', !(await text()).includes('Edit prescription') && !(await text()).includes('Void prescription'));

  // ---- a prescription filled at the till ----
  const rx = await call('POST', '/v1/prescriptions', tk, { branchId: br.id, customerId: customer.id, patientName: 'Lito Garcia', prescriberName: 'Dr. Carla Reyes', prescriberLicenseNo: '0654321', issuedOn: today, items: [{ genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE', quantity: '21', drugClass: 'ANTIBIOTIC', directions: 'Every 8 hours' }] }, idem());
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '1000.00' });
  let saleErr = '';
  const refusedSale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: pieceId, quantity: '7' }], tenders: [{ method: 'CASH', tendered: '100.00' }] }, idem()).catch((e) => { saleErr = e.message; return null; });
  check('the API refuses the antibiotic without a prescription (PRESCRIPTION_REQUIRED)', !refusedSale && saleErr.includes('PRESCRIPTION_REQUIRED'));
  const sale = await call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), customerId: customer.id, lines: [{ variantId: pieceId, quantity: '7', prescription: { itemId: rx.items[0].id } }], tenders: [{ method: 'CASH', tendered: '100.00' }] }, idem());
  await go(`/pharmacy/prescriptions/${rx.id}`);
  check('the prescription shows 7 dispensed, 14 left and the sale', await shown('Partly filled', 8000) && (await evaluate(`document.querySelector('[data-rx-left]')?.textContent === '14'`)) && (await present('[data-fill-sale]')));
  await shot('pharmacy-rx-filled.png');
  await evaluate(`document.querySelector('[data-fill-sale]').click()`);
  check('the fill links to its sale, whose line shows the generic and the class', await waitFor(`location.pathname === '/sales/${sale.id}'`, 8000).then(() => true, () => false) && (await shown('Amoxicillin 500 mg capsule', 8000)) && (await present('[data-testid="line-drug"] [data-drug-class="ANTIBIOTIC"]')));
  await go(`/customers/${customer.id}`);
  check('the customer’s page lists the open prescription', await shownAnyCase('Prescriptions with medicine left', 8000) && (await present('[data-customer-rx]')));
  await go(`/pharmacy?branch=${br.id}`);
  check('the list (left to dispense) has the filled one, not the voided one', await present('[data-rx-status="PARTLY_FILLED"]') && !(await text()).includes('Ana Santos'));
  await go(`/pharmacy?branch=${br.id}&filter=all&q=Santos`);
  check('search with “All” finds the voided one', await shown('Ana Santos') && (await present('[data-rx-status="VOIDED"]')));
  await go(`/pharmacy?branch=${br.id}`);
  await shot('pharmacy-prescriptions.png');

  // ---- pharmacist licence, then a dangerous drug against a yellow form ----
  await go('/pharmacy/setup');
  check('set-up lists the owner without a licence', await shown('Rosa Mercado') && (await text()).includes('No licence'));
  await clickText('Add licence');
  await waitFor(`document.querySelector('[name="licenseNo"]')`);
  await fill('licenseNo', 'PH-0099887');
  await fill('validUntil', day(365));
  await submitFormOf('licenseNo');
  check('the licence is recorded and in force', await shown('PH-0099887', 8000) && (await text()).includes('In force'));
  await evaluate(`document.querySelector('input[name="requirePurchaseBooklet"]').click()`);
  await submitFormOf('requirePurchaseBooklet');
  check('the purchase booklet rule is saved (off)', await shown('Saved', 8000) && (await call('GET', '/v1/pharmacy/settings', tk)).requirePurchaseBooklet === false);
  await go('/pharmacy/setup');
  await evaluate(`document.querySelector('input[name="requirePurchaseBooklet"]').click()`);
  await submitFormOf('requirePurchaseBooklet');
  check('…and back on', await shown('Saved', 8000) && (await call('GET', '/v1/pharmacy/settings', tk)).requirePurchaseBooklet === true);
  await shot('pharmacy-setup.png');
  const yellow = `YF-${tag}`;
  const ddSale = await call('POST', '/v1/sales', tk, {
    cashierSessionId: shift.id, clientTransactionId: randomUUID(),
    prescriptions: [{ ref: 'p1', patientName: 'Pedro Cruz', patientAddress: '12 Aurora Blvd, Quezon City', prescriberName: 'Dr. Carla Reyes', prescriberLicenseNo: '0654321', prescriberS2No: 'S2-5544', yellowFormNo: yellow, issuedOn: today, items: [{ ref: 'i1', genericName: 'Tramadol', strength: '50 mg', dosageForm: 'CAPSULE', quantity: '10', drugClass: 'DANGEROUS' }] }],
    lines: [{ variantId: ddId, quantity: '10', prescription: { prescriptionRef: 'p1', itemRef: 'i1' } }],
    tenders: [{ method: 'CASH', tendered: '300.00' }],
  }, idem());
  const scSale = await call('POST', '/v1/sales', tk, {
    cashierSessionId: shift.id, clientTransactionId: randomUUID(),
    beneficiaries: [{ ref: 'b1', scheme: 'SC', name: 'Lola Remedios', idNumber: 'OSCA-1234', purchaseBooklet: true }],
    lines: [{ variantId: bioId, quantity: '10', statutory: { scheme: 'SC', beneficiary: 'b1' } }],
    tenders: [{ method: 'CASH', tendered: '100.00' }],
  }, idem());
  check('the dangerous drug and an SC medicine sale are recorded', !!ddSale.id && !!scSale.id);

  // ---- the books ----
  await go(`/pharmacy/prescription-book?branch=${br.id}&from=${today}&to=${today}`);
  check('the prescription book has the antibiotic and the dangerous drug, with the prescriber and the brand', await shown('Lito Garcia', 8000) && (await lower()).includes('pedro cruz') && (await lower()).includes('prc 0654321') && (await lower()).includes(`yellow form ${yellow}`.toLowerCase()) && (await lower()).includes('amoxil 500 mg capsule'));
  const bookCsv = await csv({ report: 'prescriptionBook', branch: br.id, from: today, to: today });
  check('its CSV downloads with the header and both fills', bookCsv.status === 200 && bookCsv.type.startsWith('text/csv') && bookCsv.body.includes('Patient,Prescriber,PRC licence no.') && bookCsv.body.includes('Lito Garcia') && bookCsv.body.includes(yellow));
  await shot('pharmacy-prescription-book.png');
  await go(`/pharmacy/dangerous-drugs?branch=${br.id}&from=${today}&to=${today}`);
  const ddFig = (k) => evaluate(`document.querySelector('[data-dd-figure="${k}"]')?.textContent`);
  check('the dangerous drugs book: Tramal, 30 in (opening stock adjusted), 20 closing, the dispensing with its yellow form and address', await shown('Tramal 50 mg capsule', 8000) && (await ddFig('adjusted')) === '30' && (await ddFig('closing')) === '20' && (await text()).includes(yellow) && (await text()).includes('12 Aurora Blvd'));
  const ddCsv = await csv({ report: 'dangerousDrugs', branch: br.id, from: today, to: today });
  check('its CSV downloads with the register and the dispensing', ddCsv.status === 200 && ddCsv.body.includes(`TRM-${tag}`) && ddCsv.body.includes(yellow));
  await shot('pharmacy-dangerous-drugs.png');
  await go(`/reports/statutory?branch=${br.id}&from=${today}&to=${today}`);
  check('the SC/PWD book shows the purchase booklet', await shown('Lola Remedios', 8000) && (await present('[data-booklet="true"]')));
  const scCsv = await csv({ report: 'statutory', branch: br.id, from: today, to: today });
  check('…and its CSV has the Booklet column', scCsv.body.split('\r\n')[0].endsWith(',Booklet') && scCsv.body.includes('Lola Remedios'));
  await go(`/sales/${scSale.id}`);
  check('the SC sale’s page says the booklet was presented', await shown('Purchase booklet presented', 8000));

  // ---- batch trace, hold and release ----
  await go(`/pharmacy/batches?variant=${pieceId}&lot=AMX-001`);
  check('the trace shows the delivery and the sale, 23 left at Cubao', await present('[data-trace-type="ADJUSTMENT"]') && (await present('[data-trace-type="SALE"]')) && (await present('[data-trace-sale]')) && (await evaluate(`document.querySelector('[data-trace-onhand]')?.textContent === '23'`)));
  await shot('pharmacy-trace.png');
  await go('/pharmacy/holds');
  check('no batch is on hold yet', await shown('No batch is on hold.'));
  await clickText('Hold a batch');
  await waitFor(`document.querySelector('[name="lotCode"]')`);
  await fill('variantId', pieceId);
  await fill('lotCode', 'AMX-001');
  await fill('holdBranchId', '');
  await fill('reason', 'Supplier recall');
  await fill('reference', 'FDA Advisory 2026-77');
  await submitFormOf('lotCode');
  check('the hold is placed for every branch', await waitFor(`Boolean(document.querySelector('[data-hold-open]'))`, 8000).then(() => true, () => false) && (await lower()).includes('all branches') && (await lower()).includes('fda advisory 2026-77'));
  await shot('pharmacy-holds.png');
  await go(`/inventory/expiry?branch=${br.id}&days=90`);
  check('the expiry list shows the lot On hold', await shown('AMX-001', 8000) && (await present('[data-lot-held]')));
  await go('/pharmacy/holds');
  await clickButton('Release');
  await waitFor(`document.querySelector('[name="reason"]')`);
  await fill('reason', 'Recall withdrawn');
  await submitFormOf('reason');
  check('released: no hold in force', await shown('No batch is on hold.', 8000));
  await go('/pharmacy/holds?released=1');
  check('…and with released ones shown, it is there with its reason', await shownAnyCase('Released') && (await lower()).includes('recall withdrawn'));

  // ---- the expired-stock rule ----
  await go(`/inventory/settings?branch=${br.id}`);
  check('the branch never sells expired stock (the pharmacy default)', await shown('In force at this branch: Never sell expired') && (await evaluate(`document.querySelector('input[name=expiredStock][value=""]').checked`)));
  await evaluate(`document.querySelector('input[name=expiredStock][value=ALLOW]').click()`);
  await submitFormOf('expiryAlertDays');
  check('set to Allow', await shown('In force at this branch: Allow', 8000) && (await call('GET', `/v1/branches/${br.id}/inventory-settings`, tk)).expiredStock === 'ALLOW');
  await evaluate(`document.querySelector('input[name=expiredStock][value=""]').click()`);
  await submitFormOf('expiryAlertDays');
  check('back to the business default (never sell expired)', await shown('In force at this branch: Never sell expired', 8000).then(async (ok) => { const s = await call('GET', `/v1/branches/${br.id}/inventory-settings`, tk); return ok && s.expiredStock === null && s.expiredStockRule === 'BLOCK'; }));
  await shot('pharmacy-expired-rule.png', false);

  // ---- the BFF lets only the admin's own pharmacy writes through ----
  check('the BFF does not forward the till’s pharmacist approval', (await bff('POST', '/api/v1/pharmacy/dispense-approvals', { branchId: br.id }, true)).status === 404);

  // ---- the guide ----
  await go('/help');
  check('the guide has the “Medicines, prescriptions and batches” part', await shown('Medicines, prescriptions and batches'));
  await go(`/pharmacy/holds`);
  check('the help button on Pharmacy opens that part', await evaluate(`document.querySelector('header a[href^="/help"]')?.getAttribute('href') === '/help#pharmacy'`));

  // ---- Filipino ----
  await go(`/pharmacy?branch=${br.id}`);
  await clickText('FIL');
  check('Filipino: the Pharmacy area is translated', await shownAnyCase('Mga reseta', 8000) && (await text()).includes('Talaan ng reseta'));
  await go(`/pharmacy/prescriptions/${rx.id}`);
  check('Filipino: the prescription page is translated', await shownAnyCase('Bahagyang naibigay', 8000) && (await lower()).includes('naibigay sa mga benta'));
  await shot('pharmacy-fil.png');
  await clickText('EN');
  await shown('Partly filled', 8000);

  // ---- phone width ----
  await viewport(390, 844, true);
  const paths = [`/pharmacy?branch=${br.id}`, `/pharmacy/prescriptions/${rx.id}`, '/pharmacy/prescriptions/new', `/pharmacy/prescription-book?branch=${br.id}&from=${today}&to=${today}`, `/pharmacy/dangerous-drugs?branch=${br.id}&from=${today}&to=${today}`, `/pharmacy/batches?variant=${pieceId}&lot=AMX-001`, '/pharmacy/holds?released=1', '/pharmacy/setup', `/products/${created.id}`];
  const wide = [];
  for (const path of paths) {
    await go(path);
    if (!(await noHorizontalScroll())) wide.push(path.split('?')[0]);
  }
  check(`390px: no sideways scroll on the pharmacy pages (${paths.length}) ${wide.join(', ')}`, wide.length === 0);
  await go(`/pharmacy/prescriptions/${rx.id}`);
  await shot('pharmacy-rx-390.png');
  await go(`/pharmacy/dangerous-drugs?branch=${br.id}&from=${today}&to=${today}`);
  await shot('pharmacy-dd-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
