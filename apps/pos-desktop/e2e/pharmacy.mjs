// End-to-end test of a pharmacy at the counter (ADR-0025, session 30):
// - a PHARMACY business has no Tables tab;
// - search by generic name: a medicine hit shows its generic label and class badge (DD for a dangerous drug,
//   nothing for OTC); an OTC sale prints the generic and the lot (batch, expiry) on the receipt;
// - an antibiotic cannot be paid for without its prescription; "Equivalents" lists the cheaper brand of the
//   same generic with its stock and swaps the line; the prescription is recorded at the till;
// - a pharmacy assistant needs the pharmacist's approval: a wrong password is refused, the right one shows
//   "Approved by …" and the sale is recorded with the prescription filled;
// - SC/PWD on a medicine: refused without the purchase booklet in plain words, recorded with the tick, and
//   the receipt says "Purchase booklet presented";
// - expired stock: the lookup's "Expired stock" hint, and the sale refused with what to do;
// - the pharmacist refills the customer's prescription on record (what is left shown);
// - the guide's medicines part, Filipino, phone width.
// The offline side (a medicine sold with a prescription recorded at the till; a dangerous drug refused) needs
// the desktop till's engine, which browser mode does not have: it is covered by packages/pos-offline's unit
// tests ("medicines offline (ADR-0025)").
// The assistant and the pharmacist are arranged in the dev database as the migrator (DATABASE_MIGRATOR_URL
// from .env), as invitation links never leave the API process.
// Usage: node apps/pos-desktop/e2e/pharmacy.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
// The API origin; a trailing /v1 is accepted (the routes below carry it).
const API = (process.argv[4] ?? 'http://127.0.0.1:4320').replace(/\/v1\/?$/, '');
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const day = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));
const mmYyyy = (d) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;

// ---- arrangement (API) ----
const slug = `botika-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Rosa Aquino', businessName: 'Botika ni Rosa', tenantSlug: slug, businessType: 'PHARMACY' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Botika ni Rosa Inc', tradeName: 'Botika ni Rosa', tin: '456-789-123', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'QC-01', name: 'Quezon City' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'C1', name: 'Counter' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'C2', name: 'Window' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const pc = (await call('GET', '/v1/uoms', tk)).data.find((u) => u.code === 'PC').id;
const sku = (s) => `${s}-${slug}`.toUpperCase();
const medicine = async (name, code, price, drug) => {
  const p = await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, trackInventory: true, tracksExpiry: true, drug, variants: [{ sku: sku(code), price }] }, idem());
  return { id: p.variants[0].id, sku: p.variants[0].sku };
};
const PARA = { drugClass: 'OTC', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET' };
const AMOX = { drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE' };
const biogesic = await medicine('Biogesic', 'BIO', '5.50', PARA);
const amoxil = await medicine('Amoxil 500', 'AMOXIL', '18.00', AMOX);
const ritemed = await medicine('RiteMed Amoxicillin', 'AMOXG', '9.00', AMOX);
const losartan = await medicine('Cozaar 50', 'COZ', '30.00', { drugClass: 'RX', genericName: 'Losartan', strength: '50 mg', dosageForm: 'TABLET' });
const valium = await medicine('Valium 5', 'VAL', '25.00', { drugClass: 'DANGEROUS', genericName: 'Diazepam', strength: '5 mg', dosageForm: 'TABLET' });
const neozep = await medicine('Neozep', 'NEO', '7.00', { drugClass: 'OTC', genericName: 'Phenylephrine', strength: '10 mg', dosageForm: 'TABLET' });
await call('POST', '/v1/stock/adjustments', tk, {
  branchId: br.id, kind: 'ADJUSTMENT', reason: 'Opening stock',
  items: [
    { variantId: biogesic.id, quantity: '100', unitCost: '2.00', expiresOn: day(300), lotCode: 'P-1' },
    { variantId: amoxil.id, quantity: '50', unitCost: '8.00', expiresOn: day(300), lotCode: 'A-1' },
    { variantId: ritemed.id, quantity: '50', unitCost: '4.00', expiresOn: day(300), lotCode: 'G-1' },
    { variantId: losartan.id, quantity: '60', unitCost: '12.00', expiresOn: day(300), lotCode: 'L-1' },
    { variantId: valium.id, quantity: '20', unitCost: '10.00', expiresOn: day(300), lotCode: 'D-1' },
    // Only expired Neozep is left: the branch blocks it (a pharmacy's default).
    { variantId: neozep.id, quantity: '10', unitCost: '3.00', expiresOn: day(-5), lotCode: 'N-OLD' },
  ],
}, idem());
const maria = await call('POST', '/v1/customers', tk, { displayName: 'Maria Clara', phone: '0917 222 3344' });
const onRecord = await call('POST', '/v1/prescriptions', tk, {
  branchId: br.id, customerId: maria.id, patientName: 'Maria Clara', prescriberName: 'Dr. Jose Rizal', prescriberLicenseNo: 'PRC-998877', issuedOn: day(-2),
  items: [{ genericName: 'Losartan', strength: '50 mg', dosageForm: 'TABLET', quantity: '30', drugClass: 'RX', directions: '1 tablet a day' }],
}, idem());

const member = async (who, name, roleKey) => {
  const { PasswordService } = await import('../../api/dist/auth/password.service.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [owner.activeTenantId]);
    const u = await db.query('SELECT auth_register_user($1, $2, $3) AS id', [who, name, await new PasswordService().hash(PASSWORD)]);
    const m = await db.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [owner.activeTenantId, u.rows[0].id]);
    const r = await db.query(`INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'BRANCH', $3 FROM roles WHERE tenant_id = $1 AND key = $4`, [owner.activeTenantId, m.rows[0].id, br.id, roleKey]);
    if (r.rowCount !== 1) throw new Error(`no role ${roleKey}`);
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
};
const assistantEmail = `${slug}-asst@example.ph`;
const pharmacistEmail = `${slug}-rph@example.ph`;
await member(assistantEmail, 'Ana Cruz', 'pharmacy_assistant');
await member(pharmacistEmail, 'Liza Ramos', 'pharmacist');

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9367 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const ok = (expr, ms = 10000) => waitFor(expr, ms).then(() => true, () => false);
const setEl = (selector, value, index = 0) => evaluate(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = all.filter((x) => x.getClientRects().length)[${index}] ?? all[${index}];
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const click = (selector) => evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = all.find((x) => x.getClientRects().length) ?? all[0]; if (!el) throw new Error('nothing at ${selector.replace(/'/g, '')}'); el.click(); })()`);
const clickIn = (scope, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.getClientRects().length && x.textContent.trim().includes(${JSON.stringify(text)})); if (!el) throw new Error('no button ${text.replace(/'/g, '')}'); el.click(); })()`);
const scan = async (code) => {
  await setEl('#scan', code);
  await evaluate(`document.getElementById('scan').form.requestSubmit()`);
  await sleep(700);
};
const cart = `(document.querySelector('[data-testid=cart]')?.innerText ?? '')`;
const notice = `([...document.querySelectorAll('.callout')].filter((x) => x.getClientRects().length).map((x) => x.innerText).join(' | '))`;
const payDisabled = () => evaluate(`document.getElementById('pay-submit').disabled`);
const pay = async (cash) => {
  await sleep(500);
  await setEl('#cash', cash);
  await sleep(200);
  await click('#pay-submit');
};
const receipt = `(document.querySelector('.printable')?.innerText ?? '')`;
const recorded = () => ok(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && /New sale/.test(x.textContent))`, 15000);
const newSale = async () => {
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.getClientRects().length && /New sale/.test(x.textContent))?.click()`);
  await waitFor(`document.getElementById('scan')`);
};
const signInAt = async (who, register) => {
  await go('/');
  await waitFor(`document.querySelector('[name=email]')`);
  await fill('email', who);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`[...document.querySelectorAll('section.note')].some((n) => n.querySelector('p')?.textContent.trim() === ${JSON.stringify(register)})`);
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === ${JSON.stringify(register)}).querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  await evaluate(`window.print = () => { window.__printed = (window.__printed ?? 0) + 1; }`);
};

try {
  await viewport(1440, 900);
  await signInAt(assistantEmail, 'Counter');
  const tabs = await evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].map((x) => x.textContent.trim())`);
  check('a pharmacy has no Tables tab', !tabs.includes('Tables'));

  // ---- search by generic name; an OTC sale with the generic and the lot on the receipt ----
  await scan('paracetamol');
  check('a generic name finds the brand: the hit shows the generic label and no badge (OTC)', await ok(`(() => { const h = document.querySelector('[data-testid=search-hit][data-sku="${biogesic.sku}"]'); return h && h.innerText.includes('Biogesic') && h.innerText.includes('Paracetamol 500 mg tablet') && !h.querySelector('[data-testid=drug-badge]'); })()`));
  await click(`[data-testid=search-hit][data-sku="${biogesic.sku}"]`);
  check('the line shows the generic under the brand', await ok(`${cart}.includes('Biogesic') && ${cart}.includes('Paracetamol 500 mg tablet')`));
  await shot('pharmacy-otc.png', false);
  await pay('20');
  check('the OTC sale is recorded', await recorded());
  check('the receipt prints the generic and the lot under the item', await ok(`document.querySelector('[data-testid=receipt-generic]')?.textContent === 'Paracetamol 500 mg tablet' && document.querySelector('[data-testid=receipt-lot]')?.textContent === 'Lot P-1 · Exp ${mmYyyy(day(300))}'`));
  await shot('pharmacy-receipt-lot.png', false);
  await newSale();
  await scan('diazepam');
  check('a dangerous drug shows the DD badge in the search', await ok(`document.querySelector('[data-testid=search-hit][data-sku="${valium.sku}"] [data-testid=drug-badge]')?.textContent === 'DD'`));
  await setEl('#scan', '');

  // ---- an antibiotic: no payment without its prescription; equivalents; the prescription at the till ----
  await scan(`7*${amoxil.sku}`);
  check('an antibiotic line shows its badge and asks for the prescription', await ok(`${cart}.includes('Amoxicillin 500 mg capsule') && document.querySelector('[data-testid=cart] [data-testid=drug-badge]')?.dataset.class === 'ANTIBIOTIC' && document.querySelector('[data-testid=rx-button]')`));
  await sleep(600);
  await setEl('#cash', '200');
  await sleep(300);
  check('… and it cannot be paid for without one', (await payDisabled()) && await ok(`document.querySelector('[data-testid=rx-missing]')?.innerText.includes('Record the prescription first for: Amoxil 500')`));
  await click('[data-testid=equiv-button]');
  check('“Equivalents” lists the cheaper brand of the same generic with its stock', await ok(`(() => { const e = document.querySelector('[data-testid=equivalents]'); return e && e.innerText.includes('Same medicine: Amoxicillin 500 mg capsule') && e.querySelector('[data-testid=equivalent][data-sku="${ritemed.sku}"]')?.innerText.includes('50 in stock') && e.innerText.includes('₱9.00'); })()`));
  await shot('pharmacy-equivalents.png', false);
  await clickIn(`[data-testid=equivalent][data-sku="${ritemed.sku}"]`, 'Swap');
  check('… and swaps the line for it', await ok(`${cart}.includes('RiteMed Amoxicillin') && !${cart}.includes('Amoxil 500')`));
  await click('[data-testid=rx-button]');
  await waitFor(`document.querySelector('[data-testid=rx-new]')`);
  check('the prescription panel offers a new prescription for the medicine (in generic names)', await ok(`document.querySelector('[data-testid=rx-item]')?.innerText.includes('Amoxicillin 500 mg capsule')`));
  await setEl('#rxPatient', 'Juan Dela Cruz');
  await setEl('#rxPrescriber', 'Dr. Ana Santos');
  await setEl('#rxQty-0', '21');
  await setEl('#rxDirections-0', '1 capsule 3 times a day for 7 days');
  await click('[data-testid=rx-save]');
  check('without the PRC licence no. it is not recorded', await ok(`document.querySelector('[data-testid=rx-panel]')`) && !(await evaluate(`Boolean(document.querySelector('[data-testid=line-rx]'))`)));
  await setEl('#rxLicence', 'PRC-0123456');
  await shot('pharmacy-prescription.png', false);
  await click('[data-testid=rx-save]');
  check('the line carries the new prescription', await ok(`document.querySelector('[data-testid=line-rx]')?.innerText.includes('Rx of Juan Dela Cruz · new')`));

  // ---- the pharmacy assistant needs the pharmacist's approval ----
  check('the assistant may not dispense: a pharmacist must approve first', (await payDisabled()) && await ok(`document.querySelector('[data-testid=rx-approval-needed]')?.innerText.includes('A pharmacist must approve')`));
  await clickIn('[data-testid=rx-approval-needed]', 'Pharmacist approval');
  await waitFor(`document.getElementById('pharmacistEmail')`);
  await setEl('#pharmacistEmail', pharmacistEmail);
  await setEl('#pharmacistPassword', 'not the password');
  await click('[data-testid=rx-approval] .btn-primary');
  check('a wrong password is refused', await ok(`document.querySelector('[data-testid=rx-approval] .callout')?.innerText.includes('do not match')`));
  await setEl('#pharmacistPassword', PASSWORD);
  await click('[data-testid=rx-approval] .btn-primary');
  check('the pharmacist approves: “Approved by Liza Ramos”', await ok(`document.querySelector('[data-testid=rx-approved]')?.innerText.includes('Approved by Liza Ramos')`));
  await shot('pharmacy-approved.png', false);
  await pay('100');
  check('the antibiotic sale is recorded', await recorded());
  check('… its receipt shows the generic and the batch', await ok(`${receipt}.includes('RiteMed Amoxicillin') && ${receipt}.includes('Amoxicillin 500 mg capsule') && ${receipt}.includes('Lot G-1')`));
  const rxList = (await call('GET', `/v1/prescriptions?branchId=${br.id}&q=Juan`, tk)).data;
  const counterRx = rxList[0] ? await call('GET', `/v1/prescriptions/${rxList[0].id}`, tk) : null;
  check('… the prescription is on record: 7 of 21 dispensed, approved by the pharmacist', counterRx?.source === 'COUNTER' && counterRx.items[0]?.dispensed === '7' && counterRx.items[0]?.left === '14' && counterRx.prescriberLicenseNo === 'PRC-0123456');
  await newSale();

  // ---- SC/PWD on a medicine: the purchase booklet ----
  await scan(`2*${biogesic.sku}`);
  await clickIn('[data-testid=cart]', 'SC/PWD');
  check('the SC/PWD form on a medicine offers “Purchase booklet presented”', await ok(`document.querySelector('[data-testid=booklet]')?.innerText.includes('Purchase booklet presented')`));
  await fill('name', 'Lola Basyang');
  await fill('idNumber', 'OSCA-7788');
  await evaluate(`[...document.querySelectorAll('[name=idNumber]')].find((x) => x.getClientRects().length).form.querySelector('.btn-primary').click()`);
  await pay('20');
  check('without the booklet the sale is refused in plain words', await ok(`${notice}.includes('needs the purchase booklet')`));
  await clickIn('[data-testid=cart]', 'Remove discount');
  await clickIn('[data-testid=cart]', 'SC/PWD');
  await waitFor(`document.querySelector('[data-testid=booklet]')`);
  await fill('name', 'Lola Basyang');
  await fill('idNumber', 'OSCA-7788');
  await click('[data-testid=booklet] input');
  await evaluate(`[...document.querySelectorAll('[name=idNumber]')].find((x) => x.getClientRects().length).form.querySelector('.btn-primary').click()`);
  check('ticked: the line shows the booklet', await ok(`document.querySelector('[data-testid=line-booklet]')`));
  await pay('20');
  check('the SC/PWD sale is recorded', await recorded());
  check('… the receipt says “Purchase booklet presented” under the SC/PWD details', await ok(`document.querySelector('[data-testid=receipt-booklet]')?.textContent === 'Purchase booklet presented' && ${receipt}.includes('OSCA-7788')`));
  await shot('pharmacy-sc-booklet.png', false);
  await newSale();

  // ---- expired stock ----
  await scan(neozep.sku);
  check('an item with only expired stock: “Expired stock” on the line and a warning', await ok(`document.querySelector('[data-testid=line-expired]')?.innerText.includes('Expired stock · 0 sellable') && ${notice}.includes('Only 0 of Neozep can be sold here')`));
  await pay('10');
  check('… the sale is refused: write it off in the back office', await ok(`${notice}.includes('Only expired or held stock is left for Neozep. Write it off in the back office.')`));
  await shot('pharmacy-expired.png', false);
  await click('[data-testid=cart] button[aria-label=Remove]');
  await sleep(300);

  // ---- the pharmacist refills the customer's prescription ----
  await clickText('Sign out');
  await sleep(500);
  await signInAt(pharmacistEmail, 'Window');
  await clickText('Customer');
  await waitFor(`document.getElementById('custSearch')`);
  await fill('custSearch', 'Maria');
  await evaluate(`void [...document.querySelectorAll('form')].find((f) => f.querySelector('[name=custSearch]')).requestSubmit()`);
  await waitFor(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && x.textContent.includes('Maria Clara'))`);
  await evaluate(`void [...document.querySelectorAll('button')].find((x) => x.getClientRects().length && x.textContent.includes('Maria Clara')).click()`);
  await waitFor(`document.querySelector('[data-testid=sale-customer]')`);
  await scan(`10*${losartan.sku}`);
  await click('[data-testid=rx-button]');
  check('the customer’s open prescription is offered', await ok(`document.querySelector('[data-testid=rx-list]')?.innerText.includes('Maria Clara') && document.querySelector('[data-testid=rx-list]').innerText.includes('Dr. Jose Rizal')`));
  await click('[data-testid=rx-open]');
  check('… with what is left of the item', await ok(`document.querySelector('[data-testid=rx-record]')?.innerText.includes('Losartan 50 mg tablet') && document.querySelector('[data-testid=rx-record]').innerText.includes('30 of 30 left')`));
  await shot('pharmacy-refill.png', false);
  await click('[data-testid=rx-use-item]');
  check('the line fills it; a pharmacist needs no approval', await ok(`document.querySelector('[data-testid=line-rx]')?.innerText.includes('Rx of Maria Clara · 30 left')`) && !(await evaluate(`Boolean(document.querySelector('[data-testid=rx-approval-needed]'))`)));
  await pay('300');
  check('the refill is recorded', await recorded());
  const refilled = await call('GET', `/v1/prescriptions/${onRecord.id}`, tk);
  check('… 10 of 30 dispensed, 20 left on the prescription', refilled.status === 'PARTLY_FILLED' && refilled.items[0].dispensed === '10' && refilled.items[0].left === '20');
  await newSale();

  // ---- the guide, Filipino, phone width ----
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }))`);
  check('the guide has the medicines part', await ok(`document.getElementById('guide-pharmacy')?.innerText.includes('Pharmacist approval') && document.getElementById('guide-pharmacy').innerText.includes('Equivalents') && document.getElementById('guide-pharmacy').innerText.includes('Purchase booklet presented')`));
  await evaluate(`document.getElementById('guide-pharmacy').scrollIntoView()`);
  await shot('pharmacy-guide.png', false);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await scan(amoxil.sku);
  await evaluate(`[...document.querySelectorAll('[data-testid=language] button')].find((x) => x.textContent.trim() === 'fil').click()`);
  check('Filipino: the prescription and equivalents buttons', await ok(`document.querySelector('[data-testid=rx-button]')?.innerText.includes('Reseta') && document.querySelector('[data-testid=equiv-button]')?.innerText.includes('Katumbas') && ${notice}.includes('Itala muna ang reseta')`));
  await click('[data-testid=rx-button]');
  await clickIn('[data-testid=rx-panel]', 'Bagong reseta');
  check('… and the prescription form', await ok(`document.querySelector('[data-testid=rx-new]')?.innerText.includes('Pangalan ng pasyente')`));
  await shot('pharmacy-fil.png', false);
  await evaluate(`[...document.querySelectorAll('[data-testid=language] button')].find((x) => x.textContent.trim() === 'en').click()`);
  await viewport(390, 844);
  await sleep(500);
  check('phone width: the prescription form fits', await noHorizontalScroll());
  await shot('pharmacy-390.png');
  await click('[data-testid=equiv-button]');
  await waitFor(`document.querySelector('[data-testid=equivalent]')`);
  check('phone width: equivalents fit', await noHorizontalScroll());
  await shot('pharmacy-equivalents-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
