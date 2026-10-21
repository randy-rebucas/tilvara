// End-to-end test of a laundry shop or laundromat (ADR-0024) in the back office: the sign-up offers
// "Laundry shop or laundromat"; the band has Laundry (and no Restaurant, Lodging or Appointments);
// a per-kilo service with a 3 kg minimum is made on the product form; set-up adds a washer and a
// dryer, a garment type and the branch's settings (express charge, delivery fee); a job order is taken
// in for a walk-in (2.4 kg billed as 3 kg, express, an add-on, items and condition, a delivery, a
// bank-transfer down payment); the claim stub carries the claim code and the bag tag no prices; the
// job moves to washing with a load on the washer (the machine board shows it), then to ready (a notice
// is queued, "Copy message" gives the text); the delivery goes out with the rider and the rider claims
// it at the door through the API (as the till does), which records the sale; a cash down payment at
// a drawer shows on the shift; a walk-in job back-dated past the unclaimed days (in the dev database,
// as the migrator) is disposed of and its down payment kept; the four laundry reports and their CSV;
// the customer's job orders; the guide's part; Filipino; phone width.
// Usage: node apps/admin-web/e2e/laundry.mjs [baseUrl] [screenshotDir] [apiUrl]
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { client, PASSWORD } from '../../pos-desktop/e2e/restaurant.mjs';
import { checklist, openBrowser } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3320';
const OUT = process.argv[3] ?? '.impeccable/review';
const API = process.argv[4] ?? 'http://127.0.0.1:4320';
process.loadEnvFile(new URL('../../../.env', import.meta.url));
const pg = createRequire(new URL('../../../packages/database/package.json', import.meta.url))('pg');
const call = client(API);
const idem = () => ({ 'idempotency-key': randomUUID() });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

const slug = `lab-${Date.now().toString(36)}`;
const email = `${slug}@example.ph`;
const owner = await call('POST', '/v1/auth/signup', null, { email, password: PASSWORD, displayName: 'Liza Bautista', businessName: 'Linis Labahan', tenantSlug: slug, businessType: 'LAUNDRY' });
const tk = owner.tokens.accessToken;
const le = await call('POST', '/v1/legal-entities', tk, { registeredName: 'Liza Bautista Laundry Services', tradeName: 'Linis Labahan', tin: '456-789-012', vatStatus: 'VAT' });
const br = await call('POST', '/v1/branches', tk, { legalEntityId: le.id, code: 'MKT-01', name: 'Marikina' });
const reg = await call('POST', '/v1/registers', tk, { branchId: br.id, code: 'C1', name: 'Counter' });
const vat = (await call('GET', '/v1/tax-categories', tk)).data.find((x) => x.code === 'VAT').id;
const uoms = (await call('GET', '/v1/uoms', tk)).data;
const pc = uoms.find((u) => u.code === 'PC').id;
const kg = (uoms.find((u) => u.code === 'KG') ?? uoms.find((u) => u.code === 'PC')).id;
const tag = slug.slice(-5).toUpperCase();
const product = (body) => call('POST', '/v1/products', tk, { taxCategoryId: vat, uomId: pc, productType: 'SERVICE', ...body }, idem()).then((p) => p.variants[0].id);
const fabcon = await product({ name: 'Fabric conditioner', productType: 'STANDARD', trackInventory: false, variants: [{ sku: `FC-${tag}`, price: '15.00', laundryAddon: true }] });
const express = await product({ name: 'Express charge', soldBy: 'WEIGHT', uomId: kg, variants: [{ sku: `EX-${tag}`, price: '10.00', laundryUnit: 'KG' }] });
const deliveryFee = await product({ name: 'Delivery fee', variants: [{ sku: `DL-${tag}`, price: '50.00' }] });
const perLoad = await product({ name: 'Wash per load', variants: [{ sku: `WL-${tag}`, price: '150.00', laundryUnit: 'LOAD', laundryKgPerLoad: '8' }] });
const customer = await call('POST', '/v1/customers', tk, { displayName: 'Carmen Dizon', email: `carmen-${tag.toLowerCase()}@example.ph`, phone: '0917 555 0303' }, idem());

const { check, finish } = checklist();
const b = await openBrowser({ base: BASE, out: OUT, port: 9381 });
const { evaluate, viewport, waitFor, go, fill, clickText, shot, noHorizontalScroll } = b;
const text = () => evaluate('document.body.innerText');
const shown = (s, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, ms).then(() => true, () => false);
const shownAnyCase = (s, ms) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(s.toLowerCase())})`, ms).then(() => true, () => false);
const present = (sel, ms = 8000) => waitFor(`Boolean(document.querySelector(${JSON.stringify(sel)}))`, ms).then(() => true, () => false);
const clickButton = (label) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!el) throw new Error('no button ${label}');
  el.click();
})()`);
const clickSel = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const tickLabel = (label) => evaluate(`(() => {
  const l = [...document.querySelectorAll('label')].filter((x) => x.getClientRects().length).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!l) throw new Error('no label ${label}');
  l.querySelector('input').click();
})()`);
const submitFormOf = (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('[name="${name}"]')].find((x) => x.getClientRects().length);
  el.form.requestSubmit(el.form.querySelector('button.btn-primary') ?? undefined);
})()`);
const pesos = (v) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

try {
  await viewport(1440, 900);
  // ---- sign-up offers the laundry type ----
  await go('/sign-up');
  check('sign-up offers “Laundry shop or laundromat”', await evaluate(`Boolean(document.querySelector('input[name=businessType][value=LAUNDRY]')) && document.body.textContent.includes('Laundry shop or laundromat')`));

  await go('/sign-in');
  await fill('email', email);
  await fill('password', PASSWORD);
  await evaluate(`[...document.querySelectorAll('form button.btn-primary')].filter((x) => x.getClientRects().length).at(-1).click()`);
  await waitFor(`location.pathname === '/'`);
  const tabs = await evaluate(`[...document.querySelectorAll('header nav a')].map((a) => a.textContent.trim())`);
  check('a laundry has the Laundry tab and no Restaurant, Lodging or Appointments', tabs.includes('Laundry') && !tabs.includes('Restaurant') && !tabs.includes('Lodging') && !tabs.includes('Appointments'));
  check('the band fits at 1440px', await noHorizontalScroll());

  // ---- a per-kilo service with a minimum, on the product form ----
  await go('/products');
  await clickButton('Add product');
  await waitFor(`document.querySelector('[name="productType"]')`);
  await fill('productType', 'SERVICE');
  await present('[data-testid=laundry-fields]');
  check('the service form offers laundry fields and no duration', !(await evaluate(`Boolean(document.querySelector('[name="serviceMinutes"]'))`)));
  await fill('name', 'Wash-dry-fold');
  await fill('sku', `WDF-${tag}`);
  await fill('price', '35.00');
  await fill('uomId', kg);
  await fill('laundryUnit', 'KG');
  await waitFor(`document.querySelector('[name="laundryMinQuantity"]')`);
  await fill('laundryMinQuantity', '3');
  await submitFormOf('laundryMinQuantity');
  await shown('Wash-dry-fold', 10000);
  const prods = (await call('GET', '/v1/products?limit=200', tk)).data;
  const wdfProduct = prods.find((p) => p.name === 'Wash-dry-fold');
  const wdf = wdfProduct?.variants[0];
  check('the API has the per-kilo service, sold by weight, minimum 3 kg', wdfProduct?.soldBy === 'WEIGHT' && wdf?.laundryUnit === 'KG' && Number(wdf?.laundryMinQuantity) === 3);
  await go(`/products/${wdfProduct.id}`);
  check('the product page tags it per kilo with its minimum', await present('[data-testid=laundry-unit]') && (await text()).includes('Per kilo'));

  // ---- set-up: machines, a garment type, settings ----
  await go(`/laundry/setup?branch=${br.id}`);
  check('Set-up warns the claim policy is not verified', await shownAnyCase('has not verified', 8000));
  await clickButton('Add a machine');
  await waitFor(`document.querySelector('[name="machineLabel"]')`);
  for (const [kind, label, minutes] of [['WASHER', 'W1', '35'], ['DRYER', 'D1', '40']]) {
    await fill('kind', kind);
    await fill('machineLabel', label);
    await fill('capacityKg', '8');
    await fill('cycleMinutes', minutes);
    await submitFormOf('machineLabel');
    await present(`[data-machine-row="${label}"]`, 10000);
  }
  const machines = (await call('GET', `/v1/laundry/machines?branchId=${br.id}`, tk)).data;
  const w1 = machines.find((m) => m.label === 'W1');
  check('a washer and a dryer are listed and in the API', machines.length === 2 && w1?.kind === 'WASHER' && machines.some((m) => m.label === 'D1' && m.kind === 'DRYER'));
  await fill('garmentName', 'Shirts');
  await submitFormOf('garmentName');
  check('the garment type is listed', await present('[data-garment-type="Shirts"]'));
  await fill('expressVariantId', express);
  await fill('deliveryVariantId', deliveryFee);
  await fill('expressHours', '6');
  await clickButton('Use a suggested text');
  await submitFormOf('regularHours');
  await shown('Saved.', 8000);
  const settings = await call('GET', `/v1/branches/${br.id}/laundry-settings`, tk);
  check('the branch settings are saved (express and delivery items, a claim policy)', settings.expressVariantId === express && settings.deliveryVariantId === deliveryFee && settings.expressHours === 6 && (settings.claimPolicyText ?? '').includes('30 days'));
  await shot('laundry-setup.png');

  // ---- take in laundry: a walk-in, 2.4 kg express, an add-on, items, a delivery, a down payment ----
  await go(`/laundry?branch=${br.id}`);
  await clickText('Take in laundry');
  await waitFor(`location.pathname === '/laundry/new'`, 10000);
  await waitFor(`document.querySelector('[data-testid=job-form]')`);
  await fill('customerName', 'Ana Reyes');
  await fill('customerPhone', '0918 222 3344');
  await tickLabel('Express');
  await fill('weightKg', '2.4');
  await fill('line-0', wdf.id);
  check('the per-kilo line takes the weight and says the minimum applies', await present('[data-testid=minimum-applies]') && (await text()).includes('3 kg is charged'));
  await clickSel('[data-addon="Fabric conditioner"]');
  await clickSel('[data-garment="Shirts"]');
  await fill('count-0', '5');
  await fill('conditionNotes', 'Stain on a white shirt');
  await fill('specialInstructions', 'Separate whites');
  await tickLabel('We deliver it back');
  await waitFor(`document.querySelector('[name="deliveryAddress"]')`);
  await fill('deliveryAddress', '12 Sampaguita St, Marikina');
  await fill('deliveryPhone', '0918 222 3344');
  await fill('deliveryRider', 'Jun');
  await fill('depositAmount', '50.00');
  await fill('depositReference', 'GCASH-5521');
  await shot('laundry-new-job.png');
  await clickButton('Take in');
  await waitFor(`/^\\/laundry\\/jobs\\/[0-9a-f-]{36}$/.test(location.pathname)`, 15000);
  const jobId = await evaluate(`location.pathname.split('/').pop()`);
  let job = await call('GET', `/v1/job-orders/${jobId}`, tk);
  const wdfLine = job.lines.find((l) => l.variantId === wdf.id);
  check('the job bills 3 kg for 2.4 kg measured', Number(wdfLine?.measuredQuantity) === 2.4 && Number(wdfLine?.quantity) === 3);
  check('express and delivery lines were added and the add-on is on it', job.serviceLevel === 'EXPRESS' && job.lines.some((l) => l.variantId === express && l.auto) && job.lines.some((l) => l.variantId === deliveryFee && l.auto) && job.lines.some((l) => l.variantId === fabcon));
  check('items, condition, a scheduled delivery and the 50.00 down payment are recorded', job.items[0]?.count === 5 && job.conditionNotes === 'Stain on a white shirt' && job.trips.some((x) => x.kind === 'DELIVERY' && x.status === 'SCHEDULED') && job.depositHeld === '50.00');
  check('the job page shows the frozen total and the balance', await shown(pesos(job.amountDue), 8000) && (await evaluate(`document.querySelector('[data-testid=job-balance]').textContent`)) === pesos(job.balance));
  await shot('laundry-job.png');

  // ---- the claim stub and bag tag ----
  await go(`/laundry/jobs/${jobId}/ticket`);
  check('the stub has the number and the claim code', (await evaluate(`document.querySelector('[data-testid=stub-reference]').textContent`)) === job.reference && (await evaluate(`document.querySelector('[data-testid=stub-code]').textContent`)) === job.claimCode);
  check('the stub prints the claim policy; the bag tag has the instructions and no prices', await present('[data-testid=claim-policy]') && (await evaluate(`(() => { const t = document.querySelector('#bag-tag').innerText; return t.includes('Separate whites') && !t.includes('₱'); })()`)));
  await shot('laundry-ticket.png');

  // ---- washing, a load on the washer, the machine board ----
  await go(`/laundry/jobs/${jobId}`);
  await clickSel('[data-step="WASHING"]');
  await present('h1 [data-job-status="WASHING"]', 10000);
  await clickButton('Put on a machine');
  await waitFor(`document.querySelector('[name="machineId"]')`);
  await fill('machineId', w1.id);
  await submitFormOf('machineId');
  await waitFor(`!document.querySelector('[name="machineId"]')`, 10000);
  await go(`/laundry/machines?branch=${br.id}`);
  check('the machine board shows W1 running the job, D1 free', await present('[data-machine="W1"] [data-machine-status="RUNNING"]') && (await text()).includes(job.reference) && (await present('[data-machine="D1"] [data-machine-status="FREE"]')));
  await shot('laundry-machines.png');

  // ---- ready: the notice and the message ----
  await go(`/laundry/jobs/${jobId}`);
  await clickSel('[data-step="READY"]');
  await present('h1 [data-job-status="READY"]', 10000);
  const notices = (await call('GET', `/v1/job-orders/${jobId}/notices`, tk)).data;
  check('ready queues a “ready for pickup” notice', notices.some((n) => n.kind === 'READY'));
  await clickButton('Copy message');
  check('“Copy message” shows the ready text with the job number', await present('[data-testid=ready-message]') && (await evaluate(`document.querySelector('[data-testid=ready-message]').textContent`)).includes(job.reference));
  await go(`/laundry?branch=${br.id}&filter=READY`);
  check('the board lists the job under Ready', await present(`[data-job="${job.reference}"]`));

  // ---- the delivery goes out; the rider claims at the door (the till's claim, through the API) ----
  await go(`/laundry/trips?branch=${br.id}&date=${today}`);
  check('the route lists the delivery with the balance to collect', await shown('12 Sampaguita St, Marikina', 8000) && (await text()).includes(pesos(job.balance)));
  await clickSel('[data-start-trip]');
  await waitFor(`!document.querySelector('[data-start-trip]')`, 10000);
  job = await call('GET', `/v1/job-orders/${jobId}`, tk);
  check('the job is out for delivery', job.status === 'OUT_FOR_DELIVERY');
  await shot('laundry-trips.png');
  const shift = await call('POST', '/v1/cashier-sessions', tk, { registerId: reg.id, openingFloat: '500.00' });
  const claim = await call('POST', `/v1/job-orders/${jobId}/claim`, tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: job.balance }], releasedVia: 'DELIVERY' }, idem());
  check('the claim is a sale with the down payment applied first', claim.jobOrder?.status === 'CLAIMED' && claim.tenders.some((x) => x.method === 'JOB_DEPOSIT' && x.amount === '50.00'));
  await go(`/laundry/jobs/${jobId}`);
  check('the job page says claimed and links the sale', await shown('Claimed', 8000) && (await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/sales/${claim.id}')`)));
  check('the trip is done', await present('[data-trip-status="DONE"]'));

  // ---- a cash down payment at the drawer shows on the shift; a customer's job ----
  const job2 = await call('POST', '/v1/job-orders', tk, { branchId: br.id, customerId: customer.id, lines: [{ variantId: perLoad, quantity: '2' }] }, idem());
  await call('POST', `/v1/job-orders/${job2.id}/deposits`, tk, { method: 'CASH', cashierSessionId: shift.id, amount: '100.00' }, idem());
  await go(`/shifts/${shift.id}`);
  check('the shift lists the job order down payment apart from sales', await present('[data-testid=job-down-payments]') && (await text()).includes(pesos('100')));
  await go(`/customers/${customer.id}`);
  check('the customer page lists their job order', await evaluate(`[...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/laundry/jobs/${job2.id}')`));

  // ---- unclaimed: a walk-in job without contact, ready 40 days ago, is disposed of ----
  const job3 = await call('POST', '/v1/job-orders', tk, { branchId: br.id, customerName: 'Walk-in Ben', lines: [{ variantId: perLoad, quantity: '1' }] }, idem());
  await call('POST', `/v1/job-orders/${job3.id}/deposits`, tk, { method: 'BANK_TRANSFER', amount: '60.00', reference: 'BPI-1200' }, idem());
  await call('POST', `/v1/job-orders/${job3.id}/status`, tk, { status: 'READY' });
  {
    const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [owner.activeTenantId]);
      await db.query(`UPDATE job_orders SET ready_at = now() - interval '40 days' WHERE id = $1`, [job3.id]);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }
  await go(`/laundry?branch=${br.id}&filter=unclaimed`);
  check('the board lists the job under Unclaimed', await present(`[data-job="${job3.reference}"]`));
  await go(`/laundry/jobs/${job3.id}`);
  await clickButton('Dispose of unclaimed laundry');
  await waitFor(`document.querySelector('[name="disposeReason"]')`);
  await fill('disposeReason', 'DONATED');
  await fill('disposeNote', 'Given to the parish');
  // No final notice was sent to this job's customer (audit 2026-10-21, A4): disposing needs the override.
  await evaluate(`document.querySelector('[name="customerUnreachable"]').click()`);
  await waitFor(`document.querySelector('[name="unreachableReason"]')`);
  await fill('unreachableReason', 'No phone or email on the job');
  await submitFormOf('disposeReason');
  await present('h1 [data-job-status="DISPOSED"]', 10000);
  const disposed = await call('GET', `/v1/job-orders/${job3.id}/deposits`, tk);
  check('disposed: the 60.00 down payment is kept, nothing held', disposed.held === '0.00' && disposed.data.some((d) => d.kind === 'FORFEITED' && d.amount === '-60.00'));

  // ---- reports and their CSV ----
  await go(`/reports/job-orders?branch=${br.id}&from=${today}&to=${today}`);
  const rj = await call('GET', `/v1/reports/job-orders?branchId=${br.id}&from=${today}&to=${today}`, tk);
  check('Reports → Laundry → Job orders shows the API’s figures', await shownAnyCase('Turnaround', 8000) && rj.totals.received === 3 && (await text()).includes('Wash-dry-fold'));
  const jcsv = await evaluate(`fetch('/reports/export?report=jobOrders&branch=${br.id}&from=${today}&to=${today}').then((r) => r.text())`);
  check('the job orders CSV has the day and the kilos as weighed', jcsv.includes(today) && jcsv.includes('2.4'));
  await go(`/reports/machine-usage?branch=${br.id}&from=${today}&to=${today}`);
  check('machine usage lists W1 with a drop-off load', await shownAnyCase('Drop-off loads', 8000) && (await call('GET', `/v1/reports/machine-usage?branchId=${br.id}&from=${today}&to=${today}`, tk)).machines.some((m) => m.label === 'W1' && m.dropOffCycles === 1));
  await go(`/reports/job-order-deposits?branch=${br.id}`);
  check('down payments held match the books; the kept 60.00 is shown', await shown('match the books', 8000) && (await text()).includes(pesos('60')));
  const dcsv = await evaluate(`fetch('/reports/export?report=jobDeposits&branch=${br.id}&entity=${le.id}').then((r) => r.status + ' ' + r.headers.get('content-type'))`);
  check('the down payments CSV downloads', dcsv.startsWith('200 text/csv'));
  await go(`/reports/deliveries?branch=${br.id}&from=${today}&to=${today}`);
  check('the deliveries report counts the delivery done', await shownAnyCase('Delivery fees', 8000) && (await call('GET', `/v1/reports/deliveries?branchId=${br.id}&from=${today}&to=${today}`, tk)).totals.done === 1);
  await shot('laundry-reports.png');

  // ---- a queued self-service cycle called off (audit 2026-10-21) ----
  const dryCycle = await product({ name: 'Self-service dry', variants: [{ sku: `DRY-${tag}`, price: '20.00', machineKind: 'DRYER', machineMinutes: 10 }] });
  const d1 = machines.find((m) => m.label === 'D1');
  const cycle = () => call('POST', '/v1/sales', tk, { cashierSessionId: shift.id, clientTransactionId: randomUUID(), lines: [{ variantId: dryCycle, quantity: '1', machineId: d1.id }], tenders: [{ method: 'CASH', tendered: '20.00' }] }, idem());
  await cycle();
  const queuedSale = await cycle();
  await go(`/laundry/machines?branch=${br.id}`);
  const d1Card = `document.querySelector('[data-machine="D1"]').closest('li')`;
  check('D1 runs one self-service cycle with the next one queued', await present('[data-machine="D1"] [data-machine-status="RUNNING"]') && await waitFor(`${d1Card}.querySelector('[data-testid=machine-queued]')?.innerText.includes('#${queuedSale.saleNumber}')`, 8000).then(() => true, () => false));
  await shot('laundry-machine-queued.png', false);
  await evaluate('window.confirm = () => true');
  await evaluate(`[...${d1Card}.querySelectorAll('[data-testid=machine-queued] button')].find((x) => x.textContent.trim() === 'Call off').click()`);
  check('“Call off” takes the queued cycle off D1', await waitFor(`!${d1Card}.querySelector('[data-testid=machine-queued]')`, 8000).then(() => true, () => false));
  const board = await call('GET', `/v1/laundry/machines/board?branchId=${br.id}`, tk);
  const d1Now = board.data.find((m) => m.label === 'D1');
  check('the API: D1 still runs the first cycle, nothing queued', d1Now.status === 'RUNNING' && d1Now.queued.length === 0);
  // Stop the running cycle too, so D1 is free again for the rest of the script.
  await call('POST', `/v1/machine-runs/${d1Now.current.runId}/stop`, tk);

  // ---- the guide ----
  await go('/help');
  check('the guide has the “Job orders, machines and deliveries” part', await shown('Job orders, machines and deliveries'));
  await go(`/laundry?branch=${br.id}`);
  check('the help button on Laundry opens that part', await evaluate(`[...document.querySelectorAll('a[href^="/help"]')].some((a) => a.getAttribute('href') === '/help#laundry')`));

  // ---- Filipino ----
  await clickText('FIL');
  check('Filipino: the board is translated', await shown('Tumanggap ng labada', 8000) && (await text()).includes('Handa nang kunin'));
  await go(`/laundry/machines?branch=${br.id}`);
  check('Filipino: the machine board is translated', await shown('Bakante', 8000));
  await clickText('EN');
  await shown('Free', 8000);

  // ---- phone width ----
  await viewport(390, 844, true);
  for (const path of [`/laundry?branch=${br.id}`, `/laundry/new?branch=${br.id}`, `/laundry/jobs/${jobId}`, `/laundry/jobs/${jobId}/ticket`, `/laundry/machines?branch=${br.id}`, `/laundry/trips?branch=${br.id}&date=${today}`, `/laundry/setup?branch=${br.id}`, `/reports/job-orders?branch=${br.id}&from=${today}&to=${today}`, `/reports/job-order-deposits?branch=${br.id}`]) {
    await go(path);
    check(`390px: no sideways scroll on ${path.split('?')[0]}`, await noHorizontalScroll());
  }
  await go(`/laundry/jobs/${jobId}`);
  await shot('laundry-job-390.png');
  await go(`/laundry/new?branch=${br.id}`);
  await shot('laundry-new-390.png');
  b.close();
} catch (e) {
  console.error(e);
  check('script ran to the end', false);
  b.close();
}
finish();
