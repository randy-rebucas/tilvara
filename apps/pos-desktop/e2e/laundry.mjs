// End-to-end test of a laundry shop at the counter (ADR-0024, session 29):
// - a LAUNDRY business has a Laundry tab (and no tables);
// - a drop-off: a walk-in with a mobile number, 2.4 kg on a 3 kg minimum (billed 3 kg), an add-on, express,
//   items and condition; the job is priced and frozen; a cash down payment; the stub (claim code, balance)
//   and the bag tag printed;
// - washing (the load put on a washer, shown on the machine board), drying, folding, ready; the
//   "ready for pickup" text to copy;
// - the claim: found by number, a wrong claim code refused, the right one releases it; the receipt shows
//   the down payment as a tender and the balance paid in cash;
// - self-service: a washer cycle sold at Sell on a chosen machine (its timer on the board); two dryer
//   cycles on one dryer, the second queued behind the first;
// - a delivery: the rider leaves, the claim is recorded at the door, the trip is done;
// - the guide's laundry part, Filipino, phone width.
// Usage: node apps/pos-desktop/e2e/laundry.mjs [posUrl] [screenshotDir] [apiUrl]
import { randomUUID } from 'node:crypto';
import { checklist, openBrowser, sleep } from '../../admin-web/e2e/cdp.mjs';
import { client, PASSWORD } from './restaurant.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3330';
const OUT = process.argv[3] ?? '.impeccable/review/pos';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });

// ---- arrangement (API) ----
const slug = `labada-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Nena Garcia', businessName: 'Labada Express', tenantSlug: slug, businessType: 'LAUNDRY' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Labada Express Inc', tradeName: 'Labada Express', tin: '345-678-912', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'CUB-01', name: 'Cubao' });
await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'C1', name: 'Counter' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const uoms = (await call('GET', '/v1/uoms', tk)).data;
const pc = uoms.find((u) => u.code === 'PC').id;
const kg = uoms.find((u) => u.code === 'KG').id;
const sku = (s) => `${s}-${slug}`.toUpperCase();
const product = async (name, price, variant, extra = {}) => {
  const p = await call('POST', '/v1/products', tk, { name, taxCategoryId: vat, uomId: pc, trackInventory: false, productType: 'SERVICE', ...extra, variants: [{ sku: sku(name.replace(/\W+/g, '').slice(0, 10)), price, ...variant }] }, idem());
  return { id: p.variants[0].id, sku: p.variants[0].sku };
};
const wdf = await product('Wash-dry-fold', '35.00', { laundryUnit: 'KG', laundryMinQuantity: '3' }, { uomId: kg, soldBy: 'WEIGHT' });
const washLoad = await product('Wash per load', '70.00', { laundryUnit: 'LOAD', laundryKgPerLoad: '8' });
await product('Detergent', '15.00', { laundryAddon: true }, { productType: 'STANDARD' });
const expressItem = await product('Express', '50.00', {});
const deliveryItem = await product('Delivery', '60.00', {});
const selfWash = await product('Self wash', '60.00', { machineKind: 'WASHER', machineMinutes: 30 });
const selfDry = await product('Self dry', '20.00', { machineKind: 'DRYER', machineMinutes: 10 });
await call('PATCH', `/v1/branches/${br.id}/laundry-settings`, tk, { expressVariantId: expressItem.id, deliveryVariantId: deliveryItem.id });
const machine = (kind, label, cycleMinutes) => call('POST', '/v1/laundry/machines', tk, { branchId: br.id, kind, label, cycleMinutes, capacityKg: '8' }, idem());
await machine('WASHER', 'Washer 1', 30);
const washer2 = await machine('WASHER', 'Washer 2', 30);
await machine('DRYER', 'Dryer 1', 10);

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9365 });
const { evaluate, viewport, waitFor, go, fill, shot, noHorizontalScroll } = b;
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const ok = (expr, ms = 10000) => waitFor(expr, ms).then(() => true, () => false);
const tab = (label) => evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)}).click()`);
const view = (v) => evaluate(`document.querySelector('[data-testid=laundry-views] button[data-view=${v}]').click()`);
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
const panel = `(document.querySelector('[data-testid=job-panel]')?.innerText ?? '')`;
const scan = async (code) => {
  await setEl('#scan', code);
  await evaluate(`document.getElementById('scan').form.requestSubmit()`);
  await sleep(600);
};
const jobs = async () => (await call('GET', `/v1/job-orders?branchId=${br.id}`, tk)).data;
const board = async () => (await call('GET', `/v1/laundry/machines/board?branchId=${br.id}`, tk)).data;
/** The sale is recorded when its receipt (and the New sale button) shows. */
const recorded = () => ok(`[...document.querySelectorAll('button')].some((x) => x.getClientRects().length && /New sale/.test(x.textContent))`, 15000);
const step = async (s) => {
  await click(`[data-testid=job-actions] button[data-step=${s}]`);
  await waitFor(`document.querySelector('[data-testid=job-panel] [data-testid=job-status]')?.dataset.status === '${s}'`);
};

try {
  await viewport(1440, 900);
  await go('/');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.body.innerText.includes('Counter')`);
  await evaluate(`[...document.querySelectorAll('section.note')].find((n) => n.querySelector('p')?.textContent.trim() === 'Counter').querySelector('button').click()`);
  await waitFor(`document.getElementById('float')`);
  await fill('float', '1000');
  await evaluate(`document.querySelector('form button.btn-primary').click()`);
  await waitFor(`document.getElementById('scan')`);
  await evaluate(`window.print = () => { window.__printed = (window.__printed ?? 0) + 1; }`);

  const tabs = await evaluate(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].map((x) => x.textContent.trim())`);
  check('a laundry business has a Laundry tab and no Tables', tabs.includes('Laundry') && !tabs.includes('Tables'));
  await tab('Laundry');
  check('the board opens, empty', await shown('No job orders here'));

  // ---- drop-off ----
  await view('new');
  await waitFor(`document.querySelector('[data-testid=service-buttons] button[data-variant="${wdf.id}"]')`);
  await setEl('#walkInName', 'Maria Santos');
  await setEl('#walkInPhone', '0917 123 4567');
  await setEl('#weightKg', '2.4');
  await click(`[data-testid=service-buttons] button[data-variant="${wdf.id}"]`);
  check('a per-kilo service takes the weight, with its minimum shown', await ok(`[...document.querySelectorAll('[data-testid=drop-off-lines] input')].some((x) => x.value === '2.4') && document.querySelector('[data-testid=drop-off-lines]').innerText.includes('Minimum 3 kg') && document.querySelector('[data-testid=drop-off-lines]').innerText.includes('the minimum is charged')`));
  await clickIn('[data-testid=addon-buttons]', 'Detergent');
  await click('#express');
  await click('[data-testid=add-item]');
  await setEl('#itemLabel-0', 'Shirts');
  await setEl('#itemCount-0', '6');
  await setEl('#conditionNotes', 'Stain on one shirt');
  await setEl('#specialInstructions', 'Separate whites');
  await shot('laundry-drop-off.png', false);
  await click('[data-testid=drop-off-submit]');
  // 3 kg × 35.00 (the minimum) + detergent 15.00 + express 50.00 = 170.00.
  check('taken in as J-000001: the minimum billed, express added, ₱170.00', await ok(`${panel}.includes('J-000001') && ${panel}.includes('2.4 kg (min 3)') && ${panel}.includes('Express') && document.querySelector('[data-testid=job-money]')?.innerText.includes('₱170.00')`));
  const job1 = await call('GET', `/v1/job-orders/${(await jobs())[0].id}`, tk);
  check('… with the items, condition and a claim code', job1.items[0]?.count === 6 && job1.conditionNotes === 'Stain on one shirt' && /^[A-Z2-9]{6}$/.test(job1.claimCode) && job1.serviceLevel === 'EXPRESS');

  // ---- down payment and the stub ----
  await click('[data-testid=take-deposit]');
  await setEl('#jobDeposit', '100');
  await click('[data-testid=deposit-cash]');
  check('a cash down payment of ₱100.00 is taken', await shown('Down payment of ₱100.00 taken for J-000001'));
  check('… the stub shows the claim code and ₱70.00 to pay at pickup', await ok(`document.querySelector('[data-testid=claim-code]')?.textContent === '${job1.claimCode}' && document.querySelector('[data-testid=stub-balance]')?.innerText.includes('₱70.00')`));
  check('… the bag tag has no prices', await ok(`document.querySelector('[data-testid=bag-tag]')?.innerText.includes('J-000001') && !document.querySelector('[data-testid=bag-tag]').innerText.includes('₱')`));
  await click('[data-testid=print-stub]');
  check('… and prints', await ok(`window.__printed === 1`));
  await shot('laundry-stub.png', false);

  // ---- through the shop ----
  await step('WASHING');
  await click('[data-testid=put-on-machine]');
  await waitFor(`document.getElementById('jobMachine')?.options.length > 0`);
  await setEl('#jobMachine', washer2.id);
  await click('[data-testid=machine-form] button.btn-primary');
  check('the load goes on Washer 2', await shown('J-000001 is on Washer 2'));
  await step('DRYING');
  await step('FOLDING');
  await step('READY');
  check('ready for pickup', (await call('GET', `/v1/job-orders/${job1.id}`, tk)).status === 'READY');
  await click('[data-testid=copy-message]');
  check('“Copy message” gives the ready-for-pickup text with the balance', await ok(`document.querySelector('[data-testid=ready-message]')?.innerText.includes('J-000001 is ready for pickup at Cubao') && document.querySelector('[data-testid=ready-message]').innerText.includes('₱70.00')`));
  await view('machines');
  check('the machine board shows Washer 2 running the job with its time left', await ok(`document.querySelector('[data-testid=machine-card][data-label="Washer 2"]')?.dataset.state === 'RUNNING' && document.querySelector('[data-testid=machine-card][data-label="Washer 2"]').innerText.includes('J-000001')`));

  // ---- the claim ----
  await view('claim');
  await setEl('#claimLookup', 'J-000001');
  await evaluate(`document.getElementById('claimLookup').form.requestSubmit()`);
  await waitFor(`document.querySelector('[data-testid=claim-form]')`);
  check('found by number: ₱170.00 less the ₱100.00 down payment, ₱70.00 to pay', await ok(`document.querySelector('[data-testid=claim-money]')?.innerText.includes('₱70.00') && document.querySelector('[data-testid=claim-money]').innerText.includes('Down payment applied')`));
  await setEl('#claimCode', job1.claimCode === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ');
  await setEl('#cash', '100');
  await click('#pay-submit');
  check('a wrong claim code is refused', await shown('That claim code is not this job order’s'));
  await setEl('#claimCode', job1.claimCode.toLowerCase());
  await click('#pay-submit');
  check('the right code releases it: the receipt shows the down payment and the change', await ok(`document.querySelector('[data-testid=claimed]')?.innerText.includes('DOWN PAYMENT') && document.querySelector('[data-testid=claimed]').innerText.includes('₱30.00')`, 15000));
  await shot('laundry-claimed.png', false);
  const claimed = await call('GET', `/v1/job-orders/${job1.id}`, tk);
  check('… the job is claimed with its sale', claimed.status === 'CLAIMED' && Boolean(claimed.saleId) && claimed.depositHeld === '0.00');

  // ---- self-service cycles at Sell ----
  await tab('Sell');
  await scan(selfWash.sku);
  check('a washer cycle asks for the machine', await ok(`document.querySelector('[data-testid=machine-picker] button[data-machine="Washer 1"]')`));
  await click('[data-testid=machine-picker] button[data-machine="Washer 1"]');
  check('… the line shows its washer', await ok(`document.querySelector('[data-testid=line-machine]')?.innerText.includes('Washer 1')`));
  await sleep(500);
  await setEl('#cash', '60');
  await click('#pay-submit');
  check('the cycle sale is recorded', await recorded());
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.getClientRects().length && /New sale/.test(x.textContent))?.click()`);
  await waitFor(`document.getElementById('scan')`);
  await scan(selfDry.sku);
  await click('[data-testid=machine-picker] button[data-machine="Dryer 1"]');
  await scan(selfDry.sku);
  await click('[data-testid=machine-picker] button[data-machine="Dryer 1"]');
  check('two dryer cycles, each its own line on Dryer 1', await ok(`document.querySelectorAll('[data-testid=line-machine]').length === 2`));
  await sleep(500);
  await setEl('#cash', '40');
  await click('#pay-submit');
  check('… and the dryer sale', await recorded());
  const machines = await board();
  const w1 = machines.find((m) => m.label === 'Washer 1');
  const d1 = machines.find((m) => m.label === 'Dryer 1');
  check('the washer cycle runs on Washer 1 (self-service)', w1.status === 'RUNNING' && w1.current?.source === 'SELF_SERVICE');
  check('the second dryer cycle queues behind the first (+10 min)', d1.status === 'RUNNING' && Math.round((Date.parse(d1.nextFreeAt) - Date.parse(d1.current.endsAt)) / 60000) === 10);
  await evaluate(`[...document.querySelectorAll('button')].find((x) => x.getClientRects().length && /New sale/.test(x.textContent))?.click()`);
  await tab('Laundry');
  await view('machines');
  check('the board ticks the time left and shows the queue', await ok(`/\\d+:\\d\\d/.test(document.querySelector('[data-testid=machine-card][data-label="Washer 1"] [data-testid=time-left]')?.textContent ?? '') && document.querySelector('[data-testid=machine-card][data-label="Dryer 1"] [data-testid=queued]')`));
  await shot('laundry-machines.png', false);

  // ---- a delivery claimed at the door ----
  const job2 = await call('POST', '/v1/job-orders', tk, {
    branchId: br.id, customerName: 'Jose Reyes', customerPhone: '0918 765 4321', lines: [{ variantId: washLoad.id, quantity: '1' }],
    delivery: { address: '12 Aurora Blvd, Cubao', contactPhone: '0918 765 4321', riderName: 'Ben' },
  }, idem());
  check('a delivery job adds the delivery fee: ₱130.00', job2.amountDue === '130.00');
  for (const s of ['WASHING', 'READY']) await call('POST', `/v1/job-orders/${job2.id}/status`, tk, { status: s });
  await view('trips');
  const trip = `document.querySelector('[data-testid=trip][data-ref="${job2.reference}"]')`;
  check('the delivery is on the trips list with what to collect', await ok(`${trip}?.dataset.kind === 'DELIVERY' && ${trip}.innerText.includes('12 Aurora Blvd') && ${trip}.innerText.includes('₱130.00')`));
  await click(`[data-testid=trip][data-ref="${job2.reference}"] [data-testid=trip-start]`);
  check('the rider leaves: out for delivery', await ok(`${trip}?.querySelector('[data-testid=trip-claim]')`) && (await call('GET', `/v1/job-orders/${job2.id}`, tk)).status === 'OUT_FOR_DELIVERY');
  await click(`[data-testid=trip][data-ref="${job2.reference}"] [data-testid=trip-claim]`);
  check('the claim at the door asks no claim code', await ok(`document.querySelector('[data-testid=claim-form]')?.innerText.toLowerCase().includes('claim at the door') && !document.getElementById('claimCode')`));
  await setEl('#cash', '130');
  await click('#pay-submit');
  check('claimed at the door', await ok(`document.querySelector('[data-testid=claimed]')`, 15000));
  const done2 = await call('GET', `/v1/job-orders/${job2.id}`, tk);
  check('… the job is claimed and the trip done', done2.status === 'CLAIMED' && done2.trips.find((x) => x.kind === 'DELIVERY')?.status === 'DONE');

  // ---- the guide, Filipino, phone width ----
  await view('jobs');
  check('a claimed job reopened shows no claim form and no balance', await ok(`document.querySelector('[data-testid=job-panel] [data-testid=job-status]')?.dataset.status === 'CLAIMED' && !document.querySelector('[data-testid=claim-form]') && !document.querySelector('[data-testid=job-money]').innerText.includes('Balance')`));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }))`);
  check('F1 on Laundry opens the guide at its part', await ok(`document.getElementById('guide-laundry')?.innerText.includes('New drop-off') && document.getElementById('guide-laundry').innerText.includes('Release laundry')`));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('[data-testid=language] button')].find((x) => x.textContent.trim() === 'fil').click()`);
  check('Filipino: the tab and the views', await ok(`[...document.querySelectorAll('nav[data-testid=counter-nav] button')].some((x) => x.textContent.trim() === 'Labahan')`) && await shown('Bagong padala'));
  await shot('laundry-fil.png', false);
  await evaluate(`[...document.querySelectorAll('[data-testid=language] button')].find((x) => x.textContent.trim() === 'en').click()`);
  await viewport(390, 844);
  await sleep(400);
  await view('new');
  await waitFor(`document.querySelector('[data-testid=drop-off]')`);
  await click('#deliveryOn');
  check('phone width: the drop-off form fits', await noHorizontalScroll());
  await shot('laundry-drop-off-390.png');
  await view('machines');
  await sleep(500);
  check('phone width: the machine board fits', await noHorizontalScroll());
  await view('jobs');
  await sleep(500);
  await evaluate(`document.querySelector('[data-testid=job-board] [data-testid=job-card]')?.click()`);
  await sleep(500);
  check('phone width: the job board and a job fit', await noHorizontalScroll());
  await shot('laundry-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
