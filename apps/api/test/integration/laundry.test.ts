import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Laundromats and laundry shops (ADR-0024): the LAUNDRY type and its roles, job orders priced and frozen
 * at drop-off (minimum kilos, express, delivery fee), claim codes and the override, the status flow and
 * the ready notice, down payments (cash in the drawer, held on 2330, never above the total), the claim
 * as a sale with the down payment first and the rest given back, no void of a claim, storage fees,
 * unclaimed laundry disposed of with the down payment kept, cancel, machines (self-service cycles queued,
 * busy machines, the board), pickups and deliveries with the claim at the door, laundry packages
 * redeemed at claim, supplies used per load, and no down payment as a tender from a client or a till.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

type Auth = { Authorization: string };
const idem = (auth: Auth) => ({ ...auth, 'Idempotency-Key': randomUUID() });
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/**
 * A VAT laundry (type LAUNDRY), branch L1 with registers R1 (counter) and R2 (rider): wash-dry-fold ₱35/kg
 * (min 3 kg), wash ₱70/load (8 kg), ironing ₱20/piece, express ₱50 a job, delivery ₱60, storage ₱10/day after
 * 2 free days, a tracked detergent sachet ₱15, self-service wash (30 min) ₱60 and dry (10 min) ₱20, one
 * washer and one dryer; an attendant and a rider with drawers, a branch manager.
 */
async function laundry(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  await http().patch('/v1/business').set(auth).send({ businessType: 'LAUNDRY' }).expect(200);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Laundry Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const l1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'L1', name: 'Main', birBranchCode: '00001' }).expect(201)).body.id as string;
  const register = async (code: string) => (await http().post('/v1/registers').set(auth).send({ branchId: l1, code, name: code }).expect(201)).body.id as string;
  const [r1, r2] = [await register('R1'), await register('R2')];
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const uoms = (await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[];
  const pc = uoms.find((u) => u.code === 'PC')!.id;
  const kg = uoms.find((u) => u.code === 'KG')!.id;
  const product = async (body: object, variant: object) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: vat, productType: 'SERVICE', ...body, variants: [{ sku: uniq('LND'), ...variant }] }).expect(201)).body.variants[0].id as string;
  const wdf = await product({ name: 'Wash-dry-fold', uomId: kg, soldBy: 'WEIGHT' }, { price: '35.00', laundryUnit: 'KG', laundryMinQuantity: '3' });
  const wash = await product({ name: 'Wash per load' }, { price: '70.00', laundryUnit: 'LOAD', laundryKgPerLoad: '8' });
  const iron = await product({ name: 'Ironing' }, { price: '20.00', laundryUnit: 'PIECE' });
  const express = await product({ name: 'Express' }, { price: '50.00' });
  const delivery = await product({ name: 'Delivery' }, { price: '60.00' });
  const storage = await product({ name: 'Storage per day' }, { price: '10.00' });
  const detergent = await product({ name: 'Detergent sachet', productType: 'STANDARD', trackInventory: true }, { price: '15.00', laundryAddon: true });
  const washCycle = await product({ name: 'Self-service wash' }, { price: '60.00', machineKind: 'WASHER', machineMinutes: 30 });
  const dryCycle = await product({ name: 'Self-service dry' }, { price: '20.00', machineKind: 'DRYER', machineMinutes: 10 });
  await http().post('/v1/stock/adjustments').set(idem(auth)).send({ branchId: l1, reason: 'Opening', items: [{ variantId: detergent, quantity: '20', unitCost: '8.00' }] }).expect(201);
  const machine = async (kind: string, label: string, cycleMinutes: number) =>
    (await http().post('/v1/laundry/machines').set(idem(auth)).send({ branchId: l1, kind, label, cycleMinutes, capacityKg: '8' }).expect(201)).body.id as string;
  const washer = await machine('WASHER', 'Washer 1', 30);
  const dryer = await machine('DRYER', 'Dryer 1', 40);
  await http().patch(`/v1/branches/${l1}/laundry-settings`).set(auth)
    .send({ expressVariantId: express, deliveryVariantId: delivery, storageFeeVariantId: storage, storageFreeDays: 2, claimPolicyText: 'Items unclaimed after 30 days are donated.', smsEnabled: true })
    .expect(200);
  const at = await addMember(owner, t.tenantId, 'laundry_attendant', { type: 'BRANCH', id: l1 });
  const attendant = bearer(await loginToken(app, at.email));
  const rd = await addMember(owner, t.tenantId, 'rider', { type: 'BRANCH', id: l1 });
  const rider = bearer(await loginToken(app, rd.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: l1 });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(attendant).send({ registerId: r1, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const riderSession = (await http().post('/v1/cashier-sessions').set(rider).send({ registerId: r2, openingFloat: '500.00' }).expect(201)).body.id as string;
  const customer = (await http().post('/v1/customers').set(attendant).send({ displayName: 'Liza Reyes', email: `${uniq('liza')}@example.ph`, phone: '09171234567' }).expect(201)).body.id as string;
  return {
    t, tenantId: t.tenantId, auth, le, l1, r1, r2, vat, pc, wdf, wash, iron, express, delivery, storage, detergent, washCycle, dryCycle, washer, dryer,
    attendant, attendantId: at.userId, rider, riderId: rd.userId, manager, session, riderSession, customer,
  };
}
type L = Awaited<ReturnType<typeof laundry>>;

const sql = <T = Record<string, unknown>>(l: L, q: string, params: unknown[] = []) => asOwnerInTenant(owner, l.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const gl = (l: L, key: string) =>
  sql<{ v: string }>(l, `SELECT coalesce(sum(jl.debit - jl.credit), 0)::text AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.legal_entity_id = $1 AND a.system_key = $2`, [l.le, key]).then((r) => r[0]!.v);
const receive = (l: L, body: object, auth: Auth = l.attendant) => http().post('/v1/job-orders').set(idem(auth)).send({ branchId: l.l1, customerId: l.customer, ...body });
const claim = (l: L, id: string, body: object, auth: Auth = l.attendant) =>
  http().post(`/v1/job-orders/${id}/claim`).set(idem(auth)).send({ cashierSessionId: l.session, clientTransactionId: randomUUID(), ...body });
const status = (l: L, id: string, s: string, note?: string) => http().post(`/v1/job-orders/${id}/status`).set(l.attendant).send({ status: s, ...(note && { note }) });
const drawer = async (l: L, sessionId = l.session) => (await http().get(`/v1/reports/cashier-sessions/${sessionId}`).set(l.manager).expect(200)).body;

describe('a laundry business', () => {
  it('takes job orders with the laundry roles; other types are refused; open jobs keep the type', async () => {
    const l = await laundry('lnd-type');
    const roles = await sql<{ key: string }>(l, `SELECT key FROM roles WHERE is_system ORDER BY key`);
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['laundry_attendant', 'rider', 'cashier']));

    const shop = await signup(app, 'lnd-retail');
    const shopAuth = bearer(shop.access);
    await http().patch('/v1/business').set(shopAuth).send({ businessType: 'RETAIL' }).expect(200);
    const le = (await http().post('/v1/legal-entities').set(shopAuth).send({ registeredName: 'Shop Corp', vatStatus: 'VAT' }).expect(201)).body.id;
    const b = (await http().post('/v1/branches').set(shopAuth).send({ legalEntityId: le, code: 'B1', name: 'Main' }).expect(201)).body.id;
    const refused = await http().post('/v1/laundry/machines').set(idem(shopAuth)).send({ branchId: b, kind: 'WASHER', label: 'W1', cycleMinutes: 30 }).expect(403);
    expect(refused.body.error).toMatchObject({ code: 'BUSINESS_TYPE_EXCLUDES_FEATURE', details: { feature: 'laundry' } });
    await http().get('/v1/job-orders').set(shopAuth).expect(200);

    // A per-kilo service must be sold by weight; a cycle needs kind and minutes.
    await http().post('/v1/products').set(l.auth).send({ name: 'Bad', uomId: l.pc, taxCategoryId: l.vat, productType: 'SERVICE', variants: [{ sku: uniq('BAD'), laundryUnit: 'KG' }] }).expect(422);
    await http().post('/v1/products').set(l.auth).send({ name: 'Bad', uomId: l.pc, taxCategoryId: l.vat, productType: 'SERVICE', variants: [{ sku: uniq('BAD'), machineKind: 'DRYER' }] }).expect(422);
    // The rider cannot take in laundry; the attendant cannot set up machines.
    await receive(l, { lines: [{ variantId: l.wdf, quantity: '4' }] }, l.rider).expect(403);
    await http().post('/v1/laundry/machines').set(idem(l.attendant)).send({ branchId: l.l1, kind: 'WASHER', label: 'W9', cycleMinutes: 30 }).expect(403);

    await receive(l, { lines: [{ variantId: l.wdf, quantity: '4' }] }).expect(201);
    expect((await http().patch('/v1/business').set(l.auth).send({ businessType: 'RETAIL' }).expect(409)).body.error.code).toBe('OPEN_JOB_ORDERS');
  });
});

describe('trial samples', () => {
  it('a laundry on trial loads its services, add-ons and cycles with two washers and two dryers; removing them archives the machines', async () => {
    const t = await signup(app, 'lnd-sample');
    const auth = bearer(t.access);
    await http().patch('/v1/business').set(auth).send({ businessType: 'LAUNDRY' }).expect(200);
    const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Sample Laundry Corp', vatStatus: 'VAT' }).expect(201)).body.id;
    const b = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'L1', name: 'Main' }).expect(201)).body.id;
    expect((await http().get('/v1/sample-data').set(auth).expect(200)).body).toMatchObject({ canLoad: true, items: 10 });
    await http().post('/v1/sample-data').set(auth).expect(201);
    const machines = (await http().get('/v1/laundry/machines').query({ branchId: b }).set(auth).expect(200)).body.data;
    expect(machines.map((m: { label: string }) => m.label).sort()).toEqual(['Dryer 1', 'Dryer 2', 'Washer 1', 'Washer 2']);
    const settings = (await http().get(`/v1/branches/${b}/laundry-settings`).set(auth).expect(200)).body;
    expect(settings.expressVariantId).toEqual(expect.any(String));
    expect(settings.deliveryVariantId).toEqual(expect.any(String));
    const kilo = await asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query(`SELECT v.laundry_unit, v.laundry_min_quantity::text AS min, p.sold_by FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name LIKE 'Wash-dry-fold%'`)).rows[0]);
    expect(kilo).toEqual({ laundry_unit: 'KG', min: '3.000', sold_by: 'WEIGHT' });
    await http().post('/v1/sample-data/remove').set(auth).expect(200);
    expect((await http().get('/v1/laundry/machines').query({ branchId: b }).set(auth).expect(200)).body.data).toEqual([]);
  });

  it('garment types are business-wide: a branch laundry.setup grant reads them but cannot change them', async () => {
    const l = await laundry('lnd-garment-scope');
    const shirts = (await http().post('/v1/laundry/garment-types').set(idem(l.auth)).send({ name: 'Shirts' }).expect(201)).body;
    await http().post('/v1/roles').set(l.auth).send({ key: 'shop_setup', name: 'Shop set-up', permissions: ['laundry.setup', 'laundry.read'] }).expect(201);
    const local = bearer(await loginToken(app, (await addMember(owner, l.tenantId, 'shop_setup', { type: 'BRANCH', id: l.l1 })).email));
    await http().post('/v1/laundry/garment-types').set(idem(local)).send({ name: 'Gowns' }).expect(403);
    await http().patch(`/v1/laundry/garment-types/${shirts.id}`).set(local).send({ name: 'Pwned' }).expect(403);
    expect((await http().get('/v1/laundry/garment-types').set(local).expect(200)).body.data.map((g: { name: string }) => g.name)).toEqual(['Shirts']);
  });
});

describe('job orders', () => {
  it('are priced and frozen at drop-off: the minimum kilos, express and items; a claim code; status moves forward; READY queues the notice', async () => {
    const l = await laundry('lnd-dropoff');
    const job = (await receive(l, {
      serviceLevel: 'EXPRESS', weightKg: '2.500', bagCount: 2, lines: [{ variantId: l.wdf, quantity: '2.5' }],
      items: [{ label: 'Shirts', count: 12 }, { label: 'Pants', count: 4, note: 'Stain on one' }], conditionNotes: 'Torn pocket', specialInstructions: 'No fabric conditioner',
    }).expect(201)).body;
    expect(job).toMatchObject({ status: 'RECEIVED', reference: expect.stringMatching(/^J-0{5}1$/), claimCode: expect.stringMatching(/^[A-Z0-9]{6}$/), serviceLevel: 'EXPRESS' });
    // 2.5 kg billed at the 3 kg minimum (₱105.00) plus the express charge (₱50.00).
    expect(job.lines.map((x: { name: string; measuredQuantity: string; quantity: string; amountDue: string; auto: boolean }) => [x.name, x.measuredQuantity, x.quantity, x.amountDue, x.auto]))
      .toEqual([['Wash-dry-fold', '2.5', '3', '105.00', false], ['Express', '1', '1', '50.00', true]]);
    expect([job.amountDue, job.balance, job.depositHeld]).toEqual(['155.00', '155.00', '0.00']);
    expect(Date.parse(job.promisedAt) - Date.parse(job.createdAt)).toBeGreaterThan(5.9 * 3_600_000);
    expect(Date.parse(job.promisedAt) - Date.parse(job.createdAt)).toBeLessThan(6.1 * 3_600_000);
    const ticket = (await http().get(`/v1/job-orders/${job.id}/ticket`).set(l.attendant).expect(200)).body;
    expect(ticket.stub).toMatchObject({ claimCode: job.claimCode, pieces: 16, conditionNotes: 'Torn pocket', claimPolicy: 'Items unclaimed after 30 days are donated.', balance: '155.00' });
    expect(ticket.tag).not.toHaveProperty('claimCode');
    expect(ticket.tag).not.toHaveProperty('amountDue');

    // A re-weigh replaces the lines (the express charge stays the server's).
    const reweighed = (await http().put(`/v1/job-orders/${job.id}/lines`).set(l.attendant).send({ weightKg: '4.2', lines: [{ variantId: l.wdf, quantity: '4.2' }, { variantId: l.detergent, quantity: '1' }, { variantId: l.express, quantity: '9' }] }).expect(200)).body;
    expect(reweighed.lines.map((x: { name: string; quantity: string }) => [x.name, x.quantity])).toEqual([['Wash-dry-fold', '4.2'], ['Detergent sachet', '1'], ['Express', '1']]);
    expect(reweighed.amountDue).toBe('212.00'); // 147.00 + 15.00 + 50.00

    // Forward, skipping steps; never back except READY → FOLDING with a note.
    await status(l, job.id, 'DRYING').expect(200);
    expect((await status(l, job.id, 'WASHING').expect(409)).body.error.code).toBe('INVALID_STATUS_MOVE');
    const ready = (await status(l, job.id, 'READY').expect(200)).body;
    expect(ready).toMatchObject({ status: 'READY', readyAt: expect.any(String) });
    await status(l, job.id, 'FOLDING').expect(422);
    await status(l, job.id, 'FOLDING', 'Customer saw a stain').expect(200);
    await status(l, job.id, 'READY').expect(200);
    const notices = await sql<{ kind: string; status: string }>(l, `SELECT kind, status FROM job_order_notices WHERE job_order_id = $1`, [job.id]);
    expect(notices).toEqual([{ kind: 'READY', status: 'QUEUED' }]);
    const events = await sql<{ topic: string }>(l, `SELECT topic FROM outbox_events WHERE payload->>'jobOrderId' = $1 ORDER BY created_at`, [job.id]);
    expect(events.map((e) => e.topic)).toEqual(['job_order.notice', 'job_order.ready', 'job_order.ready']);
    const history = (await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body.history;
    expect(history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['RECEIVED', 'DRYING', 'READY', 'FOLDING', 'READY']);
    const msg = (await http().get(`/v1/job-orders/${job.id}/message`).set(l.attendant).expect(200)).body;
    expect(msg.text).toMatch(/your laundry J-000001 is ready for pickup at Main\. Balance ₱212\.00\./);
    expect(msg.text).not.toContain(job.claimCode);
    // Found by its stub's code; a walk-in needs a name.
    expect((await http().get('/v1/job-orders/lookup').query({ claimCode: job.claimCode }).set(l.attendant).expect(200)).body.id).toBe(job.id);
    await http().post('/v1/job-orders').set(idem(l.attendant)).send({ branchId: l.l1, lines: [{ variantId: l.wdf, quantity: '3' }] }).expect(400);
  });

  it('a down payment is held in the drawer and on 2330, never above the total; the claim applies it first; a claim is never voided', async () => {
    const l = await laundry('lnd-claim');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '6' }] }).expect(201)).body; // ₱210.00
    expect((await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '300.00' }).expect(409)).body.error.code).toBe('DEPOSIT_EXCEEDS_TOTAL');
    const dp = (await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '100.00' }).expect(201)).body;
    expect([dp.kind, dp.amount, dp.held]).toEqual(['RECEIVED', '100.00', '100.00']);
    expect(cents(await gl(l, 'CUSTOMER_DOWN_PAYMENTS'))).toBe(-10000);
    let report = await drawer(l);
    expect([report.expectedCash, report.jobOrderDownPayments.cash, report.sales.count]).toEqual(['1100.00', '100.00', 0]);

    await status(l, job.id, 'READY').expect(200);
    expect((await claim(l, job.id, { claimCode: 'ZZZZZZ', tenders: [{ method: 'CASH', tendered: '200.00' }] }).expect(422)).body.error.code).toBe('CLAIM_CODE_MISMATCH');
    // Without the stub, only someone with the override.
    await claim(l, job.id, { overrideReason: 'Lost stub, ID checked', tenders: [{ method: 'CASH', tendered: '200.00' }] }).expect(403);
    await claim(l, job.id, { claimCode: job.claimCode, tenders: [{ method: 'CASH', tendered: '50.00' }] }).expect(422); // short
    const sale = (await claim(l, job.id, { claimCode: job.claimCode, expectedAmountDue: '210.00', tenders: [{ method: 'CASH', tendered: '200.00' }] }).expect(201)).body;
    expect([sale.amountDue, sale.changeDue, sale.jobOrderId]).toEqual(['210.00', '90.00', job.id]);
    expect(sale.tenders.map((x: { method: string; amount: string }) => [x.method, x.amount])).toEqual([['JOB_DEPOSIT', '100.00'], ['CASH', '110.00']]);
    expect(sale.jobOrder).toMatchObject({ status: 'CLAIMED', downPaymentApplied: '100.00', downPaymentReturned: '0.00' });
    expect((await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body).toMatchObject({ status: 'CLAIMED', saleId: sale.id, depositHeld: '0.00' });
    expect(cents(await gl(l, 'CUSTOMER_DOWN_PAYMENTS'))).toBe(0);
    report = await drawer(l);
    expect([report.expectedCash, report.sales.count]).toEqual(['1210.00', 1]);
    // Claimed once; a void is refused (a return is the way back); the job does not change any more.
    expect((await claim(l, job.id, { claimCode: job.claimCode, tenders: [{ method: 'CASH', tendered: '210.00' }] }).expect(409)).body.error.code).toBe('JOB_ORDER_ENDED');
    expect((await http().post(`/v1/sales/${sale.id}/returns`).set(idem(l.manager)).send({ cashierSessionId: l.session, kind: 'VOID', reason: 'Oops' }).expect(409)).body.error.code)
      .toBe('CLAIM_SALE_NOT_VOIDABLE');
    await status(l, job.id, 'READY').expect(409);
    // A client never sends the down payment as a tender.
    await http().post('/v1/sales').set(idem(l.attendant)).send({ cashierSessionId: l.session, clientTransactionId: randomUUID(), lines: [{ variantId: l.iron, quantity: '1' }], tenders: [{ method: 'JOB_DEPOSIT', jobOrderId: job.id }] }).expect(400);
    expect(await asOwnerInTenant(owner, l.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('lines reduced below the down payment: the claim gives the rest back in cash; a manager releases without the stub', async () => {
    const l = await laundry('lnd-excess');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '3' }] }).expect(201)).body; // ₱105.00
    await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '105.00' }).expect(201);
    await http().put(`/v1/job-orders/${job.id}/lines`).set(l.attendant).send({ lines: [{ variantId: l.iron, quantity: '1' }] }).expect(200); // ₱20.00
    await status(l, job.id, 'READY').expect(200);
    const r3 = (await http().post('/v1/registers').set(l.auth).send({ branchId: l.l1, code: 'R3', name: 'R3' }).expect(201)).body.id;
    const msession = (await http().post('/v1/cashier-sessions').set(l.manager).send({ registerId: r3, openingFloat: '100.00' }).expect(201)).body.id;
    const sale = (await claim(l, job.id, { cashierSessionId: msession, overrideReason: 'Lost stub, ID checked', tenders: [] }, l.manager).expect(201)).body;
    expect([sale.amountDue, sale.jobOrder.downPaymentApplied, sale.jobOrder.downPaymentReturned]).toEqual(['20.00', '20.00', '85.00']);
    expect((await drawer(l, msession)).expectedCash).toBe('15.00');
    expect(cents(await gl(l, 'CUSTOMER_DOWN_PAYMENTS'))).toBe(0);
    const audit = await sql<{ metadata: Record<string, unknown> }>(l, `SELECT metadata FROM audit_logs WHERE action = 'job_order.claimed' AND resource_id = $1`, [job.id]);
    expect(audit[0]!.metadata).toMatchObject({ override: true, downPaymentReturned: '85.00' });
    expect(await asOwnerInTenant(owner, l.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('a job that waited beyond the free days pays a storage fee per day at claim', async () => {
    const l = await laundry('lnd-storage');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '3' }] }).expect(201)).body;
    await status(l, job.id, 'READY').expect(200);
    await sql(l, `UPDATE job_orders SET ready_at = now() - interval '5 days' WHERE id = $1`, [job.id]);
    expect((await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body.storageDays).toBe(3);
    const sale = (await claim(l, job.id, { claimCode: job.claimCode, tenders: [{ method: 'CASH', tendered: '200.00' }] }).expect(201)).body;
    expect(sale.lines.map((x: { name: string; quantity: string; amountDue: string }) => [x.name, x.quantity, x.amountDue])).toEqual([['Wash-dry-fold', '3', '105.00'], ['Storage per day', '3', '30.00']]);
    expect(sale.amountDue).toBe('135.00');
  });

  it('unclaimed laundry: reminders and the final notice, then a manager disposes of it and the down payment is kept with its VAT; cancel refunds', async () => {
    const l = await laundry('lnd-unclaimed');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '4' }] }).expect(201)).body; // ₱140.00
    await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'BANK_TRANSFER', amount: '112.00', reference: 'GCASH-77' }).expect(201);
    await status(l, job.id, 'READY').expect(200);
    expect((await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED' }).expect(409)).body.error.code).toBe('NOT_YET_UNCLAIMED');
    await sql(l, `UPDATE job_orders SET ready_at = now() - interval '31 days' WHERE id = $1`, [job.id]);
    expect((await http().get('/v1/job-orders').query({ branchId: l.l1, unclaimed: 'true' }).set(l.attendant).expect(200)).body.data.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED' }).expect(409)).body.error.code).toBe('FINAL_NOTICE_PENDING');
    // The worker's hourly pass: one reminder per branch day and the final notice, once each.
    const flagged = await sql<{ n: number }>(l, `SELECT platform_flag_laundry_notices() AS n`);
    expect(flagged[0]!.n).toBeGreaterThanOrEqual(3);
    await sql(l, `SELECT platform_flag_laundry_notices()`);
    const notices = await sql<{ kind: string; step: number }>(l, `SELECT kind, step FROM job_order_notices WHERE job_order_id = $1 ORDER BY kind, step`, [job.id]);
    expect(notices).toEqual([{ kind: 'FINAL', step: 0 }, { kind: 'READY', step: 0 }, { kind: 'REMINDER', step: 3 }, { kind: 'REMINDER', step: 7 }]);
    await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.attendant)).send({ reason: 'DONATED' }).expect(403);
    // Decision A4: a queued or failed final notice is not enough; "could not reach" needs a reason and is audited.
    expect((await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED' }).expect(409)).body.error.code).toBe('FINAL_NOTICE_PENDING');
    await sql(l, `UPDATE job_order_notices SET status = 'FAILED', sms_status = 'FAILED', settled_at = now() WHERE job_order_id = $1 AND kind = 'FINAL'`, [job.id]);
    expect((await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED' }).expect(409)).body.error).toMatchObject({ code: 'FINAL_NOTICE_NOT_SENT', details: { finalNotice: 'FAILED' } });
    await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED', customerUnreachable: true }).expect(400);
    const disposed = (await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DONATED', note: 'Parish drive', customerUnreachable: true, unreachableReason: 'Number out of service, no email' }).expect(200)).body;
    expect((await sql<{ metadata: Record<string, unknown> }>(l, `SELECT metadata FROM audit_logs WHERE action = 'job_order.disposed' AND resource_id = $1`, [job.id]))[0]!.metadata)
      .toMatchObject({ finalNotice: 'FAILED', customerUnreachable: true, unreachableReason: 'Number out of service, no email' });
    expect([disposed.status, disposed.depositHeld]).toEqual(['DISPOSED', '0.00']);
    // ₱112.00 kept: ₱100.00 income and ₱12.00 output VAT; nothing is owed on 2330.
    expect([cents(await gl(l, 'FORFEITED_DOWN_PAYMENTS')), cents(await gl(l, 'OUTPUT_VAT')), cents(await gl(l, 'CUSTOMER_DOWN_PAYMENTS'))]).toEqual([-10000, -1200, 0]);

    // Cancel: a down payment held must say how it goes back.
    const other = (await receive(l, { lines: [{ variantId: l.iron, quantity: '5' }] }).expect(201)).body;
    await http().post(`/v1/job-orders/${other.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '50.00' }).expect(201);
    expect((await http().post(`/v1/job-orders/${other.id}/cancel`).set(idem(l.attendant)).send({ reason: 'Customer changed mind' }).expect(422)).body.error.code).toBe('REFUND_METHOD_REQUIRED');
    await http().post(`/v1/job-orders/${other.id}/cancel`).set(idem(l.attendant)).send({ reason: 'Customer changed mind', deposit: 'forfeit' }).expect(403);
    const cancelled = (await http().post(`/v1/job-orders/${other.id}/cancel`).set(idem(l.attendant)).send({ reason: 'Customer changed mind', refund: { method: 'CASH', cashierSessionId: l.session } }).expect(200)).body;
    expect([cancelled.status, cancelled.depositHeld]).toEqual(['CANCELLED', '0.00']);
    expect((await drawer(l)).expectedCash).toBe('1000.00');
    expect(await asOwnerInTenant(owner, l.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('machines', () => {
  it('a self-service cycle runs on its machine and queues behind a running one; a drop-off load needs a free machine; the board shows them', async () => {
    const l = await laundry('lnd-machines');
    const sell = (lines: object[]) =>
      http().post('/v1/sales').set(idem(l.attendant)).send({ cashierSessionId: l.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '500.00' }] });
    const first = (await sell([{ variantId: l.washCycle, quantity: '1', machineId: l.washer }]).expect(201)).body;
    expect(first.lines[0].machineId).toBe(l.washer);
    const second = (await sell([{ variantId: l.washCycle, quantity: '1', machineId: l.washer }]).expect(201)).body;
    const runs = await sql<{ sale_id: string; started_at: Date; ends_at: Date; planned_minutes: number }>(l, `SELECT sale_id, started_at, ends_at, planned_minutes FROM machine_runs WHERE machine_id = $1 ORDER BY started_at`, [l.washer]);
    expect(runs.map((r) => r.sale_id)).toEqual([first.id, second.id]);
    expect(runs[1]!.started_at.getTime()).toBe(runs[0]!.ends_at.getTime());
    expect((await sell([{ variantId: l.dryCycle, quantity: '1', machineId: l.washer }]).expect(422)).body.error.code).toBe('MACHINE_KIND_MISMATCH');
    // Two dryer top-ups in one sale run back to back (20 minutes).
    await sell([{ variantId: l.dryCycle, quantity: '2', machineId: l.dryer }]).expect(201);
    expect((await sql<{ m: number }>(l, `SELECT planned_minutes AS m FROM machine_runs WHERE machine_id = $1`, [l.dryer]))[0]!.m).toBe(20);
    // A cycle sold without a machine is an ordinary item.
    await sell([{ variantId: l.washCycle, quantity: '1' }]).expect(201);

    const job = (await receive(l, { lines: [{ variantId: l.wash, quantity: '2' }] }).expect(201)).body;
    expect((await http().post(`/v1/job-orders/${job.id}/machine-runs`).set(l.attendant).send({ machineId: l.washer }).expect(409)).body.error.code).toBe('MACHINE_BUSY');
    await http().patch(`/v1/laundry/machines/${l.dryer}`).set(l.manager).send({ outOfOrderReason: 'Belt broke' }).expect(200);
    expect((await http().post(`/v1/job-orders/${job.id}/machine-runs`).set(l.attendant).send({ machineId: l.dryer }).expect(409)).body.error.code).toBe('MACHINE_OUT_OF_ORDER');
    await http().patch(`/v1/laundry/machines/${l.dryer}`).set(l.manager).send({ outOfOrderReason: null }).expect(200);
    const [dryRun] = await sql<{ id: string }>(l, `SELECT id FROM machine_runs WHERE machine_id = $1`, [l.dryer]);
    await http().post(`/v1/machine-runs/${dryRun!.id}/stop`).set(l.attendant).expect(200);
    const load = (await http().post(`/v1/job-orders/${job.id}/machine-runs`).set(l.attendant).send({ machineId: l.dryer }).expect(201)).body;
    expect(load).toMatchObject({ source: 'JOB', plannedMinutes: 40, machineLabel: 'Dryer 1' });
    expect((await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body.status).toBe('DRYING');
    const board = (await http().get('/v1/laundry/machines/board').query({ branchId: l.l1 }).set(l.attendant).expect(200)).body.data;
    expect(board.map((m: { label: string; status: string; current: { source: string } | null }) => [m.label, m.status, m.current?.source ?? null])).toEqual([
      ['Washer 1', 'RUNNING', 'SELF_SERVICE'], ['Dryer 1', 'RUNNING', 'JOB'],
    ]);
    const usage = (await http().get('/v1/reports/machine-usage').query({ branchId: l.l1, from: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10), to: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10) }).set(l.manager).expect(200)).body;
    expect(usage.machines.find((m: { label: string }) => m.label === 'Washer 1')).toMatchObject({ selfServiceCycles: 2, dropOffCycles: 0, selfServiceSales: '120.00' });
  });
});

describe('pickup and delivery', () => {
  it('a delivery adds its fee, goes out, can fail back to READY, and is completed by the rider\'s claim at the door', async () => {
    const l = await laundry('lnd-delivery');
    const job = (await receive(l, {
      lines: [{ variantId: l.wdf, quantity: '5' }], delivery: { address: '12 Mabini St, Quezon City', contactPhone: '0917 555 0101', riderName: 'Jun' },
    }).expect(201)).body;
    expect(job.lines.map((x: { name: string; amountDue: string }) => [x.name, x.amountDue])).toEqual([['Wash-dry-fold', '175.00'], ['Delivery', '60.00']]);
    const trip = job.trips[0];
    expect(trip).toMatchObject({ kind: 'DELIVERY', status: 'SCHEDULED' });
    expect((await http().post(`/v1/laundry/trips/${trip.id}/start`).set(l.rider).expect(409)).body.error.code).toBe('JOB_NOT_READY');
    await status(l, job.id, 'READY').expect(200);
    await http().post(`/v1/laundry/trips/${trip.id}/start`).set(l.rider).expect(200);
    expect((await http().get(`/v1/job-orders/${job.id}`).set(l.rider).expect(200)).body.status).toBe('OUT_FOR_DELIVERY');
    expect((await http().post(`/v1/laundry/trips/${trip.id}/done`).set(l.rider).expect(409)).body.error.code).toBe('CLAIM_AT_THE_DOOR');
    await http().post(`/v1/laundry/trips/${trip.id}/failed`).set(l.rider).send({ reason: 'Nobody home' }).expect(200);
    expect((await http().get(`/v1/job-orders/${job.id}`).set(l.rider).expect(200)).body.status).toBe('READY');
    const again = (await http().post(`/v1/job-orders/${job.id}/trips`).set(idem(l.attendant)).send({ kind: 'DELIVERY', address: '12 Mabini St, Quezon City', contactPhone: '0917 555 0101' }).expect(201)).body;
    await http().post(`/v1/laundry/trips/${again.id}/start`).set(l.rider).expect(200);
    const list = (await http().get('/v1/laundry/trips').query({ branchId: l.l1 }).set(l.rider).expect(200)).body.data;
    expect(list.map((x: { status: string }) => x.status)).toEqual(['FAILED', 'SCHEDULED']);
    // The rider takes the money at the door on their own drawer.
    const sale = (await claim(l, job.id, { cashierSessionId: l.riderSession, releasedVia: 'DELIVERY', tenders: [{ method: 'CASH', tendered: '235.00' }] }, l.rider).expect(201)).body;
    expect(sale.amountDue).toBe('235.00');
    const after = (await http().get(`/v1/job-orders/${job.id}`).set(l.rider).expect(200)).body;
    expect([after.status, after.trips.map((x: { status: string }) => x.status)]).toEqual(['CLAIMED', ['FAILED', 'DONE']]);
    expect((await drawer(l, l.riderSession)).expectedCash).toBe('735.00');

    // A pickup: scheduled before the laundry is weighed, then done.
    const pickup = (await receive(l, { pickup: { address: 'Unit 5, Kamuning', contactPhone: '09181112222', windowStart: new Date(Date.now() + 3_600_000).toISOString() } }).expect(201)).body;
    expect([pickup.amountDue, pickup.lines.length, pickup.pickupRequested]).toEqual(['0.00', 0, true]);
    await status(l, pickup.id, 'READY').expect(422); // not priced yet
    await http().post(`/v1/laundry/trips/${pickup.trips[0].id}/done`).set(l.rider).expect(200);
    const deliveries = (await http().get('/v1/reports/deliveries').query({ branchId: l.l1, from: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10), to: new Date(Date.now() + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10) }).set(l.manager).expect(200)).body;
    expect(deliveries.totals).toMatchObject({ trips: 3, done: 2, failed: 1, deliveryFees: '60.00' });
  });

  it("a customer's data export lists their jobs and trips; anonymising blanks the job's and the trip's free text, an ended job included", async () => {
    const l = await laundry('lnd-privacy');
    const job = (await receive(l, {
      lines: [{ variantId: l.wdf, quantity: '4' }], specialInstructions: 'Liza wants it folded', conditionNotes: 'Liza: torn sleeve',
      delivery: { address: '12 Mabini St, Quezon City', contactPhone: '0917 555 0101', riderName: 'Jun', notes: 'Ask for Liza at the gate' },
    }).expect(201)).body;
    await http().post(`/v1/job-orders/${job.id}/cancel`).set(idem(l.attendant)).send({ reason: 'Customer changed mind' }).expect(200);
    const dump = (await http().post(`/v1/customers/${l.customer}/export`).set(l.auth).expect(200)).body;
    expect(dump.laundryJobs).toEqual([expect.objectContaining({
      status: 'CANCELLED', specialInstructions: 'Liza wants it folded', conditionNotes: 'Liza: torn sleeve',
      trips: [expect.objectContaining({ kind: 'DELIVERY', address: '12 Mabini St, Quezon City', notes: 'Ask for Liza at the gate' })],
    })]);

    await http().post(`/v1/customers/${l.customer}/anonymise`).set(l.auth).send({ reason: 'Asked to be forgotten' }).expect(200);
    expect(await sql(l, `SELECT special_instructions, condition_notes FROM job_orders WHERE id = $1`, [job.id])).toEqual([{ special_instructions: null, condition_notes: null }]);
    expect(await sql(l, `SELECT address, contact_phone, notes, rider_name FROM job_order_trips WHERE job_order_id = $1`, [job.id])).toEqual([{ address: null, contact_phone: null, notes: null, rider_name: 'Jun' }]);
    // An ended job may only have them blanked, never rewritten (0107).
    await expect(sql(l, `UPDATE job_orders SET condition_notes = 'Someone else' WHERE id = $1`, [job.id])).rejects.toThrow(/has ended/);
  });
});

describe('packages and supplies', () => {
  it('a laundry package pays loads on a job, redeemed at claim; a per-kilo line cannot use it; supplies are used per load', async () => {
    const l = await laundry('lnd-packages');
    await http().post(`/v1/variants/${l.wash}/recipe`).set(l.auth).send({ ingredients: [{ variantId: l.detergent, quantity: '1' }] }).expect(201);
    const pkg = (await http().post('/v1/products').set(l.auth).send({ name: '10 loads', uomId: l.pc, taxCategoryId: l.vat, productType: 'PACKAGE', variants: [{ sku: uniq('PKG'), price: '600.00', packageValidDays: 90 }] }).expect(201)).body.variants[0].id as string;
    await http().put(`/v1/variants/${pkg}/package-items`).set(l.auth).send({ items: [{ serviceVariantId: l.wash, sessions: 10 }] }).expect(200);
    await http().post('/v1/sales').set(idem(l.attendant)).send({ cashierSessionId: l.session, clientTransactionId: randomUUID(), customerId: l.customer, lines: [{ variantId: pkg, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '600.00' }] }).expect(201);
    const [p] = (await http().get(`/v1/customers/${l.customer}/packages`).query({ open: 'true' }).set(l.attendant).expect(200)).body.data;
    expect((await receive(l, { lines: [{ variantId: l.wdf, quantity: '3', packageId: p.id }] }).expect(409)).body.error.code).toBe('PACKAGE_NEEDS_WHOLE_UNITS');
    const job = (await receive(l, { lines: [{ variantId: l.wash, quantity: '2', packageId: p.id }] }).expect(201)).body;
    expect([job.amountDue, job.lines[0].customerPackageId]).toEqual(['0.00', p.id]);
    const second = (await receive(l, { lines: [{ variantId: l.wash, quantity: '9', packageId: p.id }] }).expect(201)).body;
    await status(l, job.id, 'READY').expect(200);
    await status(l, second.id, 'READY').expect(200);
    const sale = (await claim(l, job.id, { claimCode: job.claimCode }).expect(201)).body;
    expect([sale.amountDue, sale.lines[0].customerPackageId, Number(sale.lines[0].packageValue)]).toEqual(['0.00', p.id, 107.14]);
    // Two loads of detergent used with the claim.
    const used = await sql<{ quantity: string }>(l, `SELECT quantity::text FROM stock_movements WHERE sale_id = $1 AND type = 'CONSUMPTION'`, [sale.id]);
    expect(used.map((u) => Number(u.quantity))).toEqual([-2]);
    // Only 8 sessions left for a job that wants 9: the claim is refused, nothing recorded.
    expect((await claim(l, second.id, { claimCode: second.claimCode }).expect(409)).body.error.code).toBe('PACKAGE_EXHAUSTED');
    expect((await http().get(`/v1/job-orders/${second.id}`).set(l.attendant).expect(200)).body.status).toBe('READY');
  });
});

describe('the till offline', () => {
  it('never sends a down payment as a tender, nor starts a machine', async () => {
    const l = await laundry('lnd-offline');
    const reg = (await http().post('/v1/terminals').set(l.auth).send({ registerId: l.r1, name: 'Counter till' }).expect(201)).body;
    const headers = { 'x-terminal-id': reg.terminal.id, Authorization: `Terminal ${reg.credential}` };
    const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    // The snapshot tells the till how laundry items count.
    expect(snap.items.find((i) => i.variantId === l.wdf)?.laundry).toEqual({ unit: 'KG', minQuantity: '3', kgPerLoad: null, addon: false, machineKind: null, machineMinutes: null });
    expect(snap.items.find((i) => i.variantId === l.dryCycle)?.laundry).toMatchObject({ machineKind: 'DRYER', machineMinutes: 10 });
    expect(snap.items.find((i) => i.variantId === l.storage)).not.toHaveProperty('laundry');
    const job = (await receive(l, { lines: [{ variantId: l.iron, quantity: '1' }] }).expect(201)).body;
    const env = {
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: l.session, cashierUserId: l.attendantId,
      occurredAt: new Date().toISOString(), localReference: `R1-T${snap.terminal.credentialHint}-000001`,
      lines: [{ variantId: l.iron, quantity: '1' }], tenders: [{ method: 'JOB_DEPOSIT', jobOrderId: job.id }], amountDue: '20.00',
    } as unknown as OfflineSale;
    // Not a tender a till may send: quarantined alone (audit 2026-10-21), never recorded.
    const refused = (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body.results;
    expect([refused[0].status, refused[0].code]).toEqual(['QUARANTINED', 'VALIDATION_FAILED']);
    const withMachine = { ...env, terminalTxnId: randomUUID(), lines: [{ variantId: l.washCycle, quantity: '1', machineId: l.washer }], tenders: [{ method: 'CASH', tendered: '60.00' }], amountDue: '60.00' } as unknown as OfflineSale;
    const synced = (await http().post('/v1/sync/sales').set(headers).send({ sales: [withMachine] }).expect(200)).body.results;
    expect(synced[0].status).toBe('RECORDED');
    expect(await sql(l, `SELECT 1 FROM machine_runs`)).toEqual([]);
  });
});

describe('audit 2026-10-21', () => {
  it('a delivery asked for after drop-off adds its fee to the frozen lines; calling it off takes the fee away', async () => {
    const l = await laundry('lnd-a-fee');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '5' }] }).expect(201)).body;
    expect(job.amountDue).toBe('175.00');
    const trip = (await http().post(`/v1/job-orders/${job.id}/trips`).set(idem(l.attendant)).send({ kind: 'DELIVERY', address: '12 Mabini St, Quezon City', contactPhone: '0917 555 0101' }).expect(201)).body;
    const withFee = (await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body;
    expect([withFee.deliveryRequested, withFee.amountDue, withFee.lines.map((x: { name: string; amountDue: string }) => [x.name, x.amountDue])])
      .toEqual([true, '235.00', [['Wash-dry-fold', '175.00'], ['Delivery', '60.00']]]);
    await http().post(`/v1/laundry/trips/${trip.id}/cancel`).set(l.attendant).send({ reason: 'Customer will pick up' }).expect(200);
    const without = (await http().get(`/v1/job-orders/${job.id}`).set(l.attendant).expect(200)).body;
    expect([without.deliveryRequested, without.amountDue, without.lines.length]).toEqual([false, '175.00', 1]);
  });

  it('lines that leave nothing to charge cannot trap a down payment; the board never shows a negative balance', async () => {
    const l = await laundry('lnd-a-lines');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '3' }] }).expect(201)).body; // ₱105.00
    await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '105.00' }).expect(201);
    // Only the server's automatic lines named: nothing left to charge.
    expect((await http().put(`/v1/job-orders/${job.id}/lines`).set(l.attendant).send({ lines: [{ variantId: l.delivery, quantity: '1' }] }).expect(409)).body.error)
      .toMatchObject({ code: 'DEPOSIT_HELD', details: { held: '105.00' } });
    await http().put(`/v1/job-orders/${job.id}/lines`).set(l.attendant).send({ lines: [{ variantId: l.iron, quantity: '1' }] }).expect(200); // ₱20.00
    const row = (await http().get('/v1/job-orders').query({ branchId: l.l1 }).set(l.attendant).expect(200)).body.data.find((j: { id: string }) => j.id === job.id);
    expect([row.amountDue, row.depositHeld, row.balance]).toEqual(['20.00', '105.00', '0.00']);
  });

  it("a down payment is taken at a drawer of the job's branch", async () => {
    const l = await laundry('lnd-a-branch');
    const l2 = (await http().post('/v1/branches').set(l.auth).send({ legalEntityId: l.le, code: 'L2', name: 'Annex' }).expect(201)).body.id as string;
    const r = (await http().post('/v1/registers').set(l.auth).send({ branchId: l2, code: 'A1', name: 'A1' }).expect(201)).body.id as string;
    const annex = (await http().post('/v1/cashier-sessions').set(l.auth).send({ registerId: r, openingFloat: '500.00' }).expect(201)).body.id as string;
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '4' }] }).expect(201)).body;
    expect((await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.auth)).send({ method: 'CASH', cashierSessionId: annex, amount: '50.00' }).expect(422)).body.error.code).toBe('WRONG_BRANCH');
    await http().post(`/v1/job-orders/${job.id}/deposits`).set(idem(l.attendant)).send({ method: 'CASH', cashierSessionId: l.session, amount: '50.00' }).expect(201);
  });
});

describe('fixes 2026-10-21 (machine runs, disposal)', () => {
  it('a queued self-service cycle can be called off; voiding or returning a cycle sale ends its machine run', async () => {
    const l = await laundry('lnd-f-runs');
    const sell = (lines: object[]) =>
      http().post('/v1/sales').set(idem(l.attendant)).send({ cashierSessionId: l.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '500.00' }] });
    const runOf = async (saleId: string) =>
      (await sql<{ id: string; started_at: Date; ends_at: Date; stopped_at: Date | null }>(l, `SELECT id, started_at, ends_at, stopped_at FROM machine_runs WHERE sale_id = $1`, [saleId]))[0]!;
    const first = (await sell([{ variantId: l.washCycle, quantity: '1', machineId: l.washer }]).expect(201)).body;
    const second = (await sell([{ variantId: l.washCycle, quantity: '1', machineId: l.washer }]).expect(201)).body;
    const [r1, r2] = [await runOf(first.id), await runOf(second.id)];
    const washer = async () => (await http().get('/v1/laundry/machines/board').query({ branchId: l.l1 }).set(l.attendant).expect(200)).body.data.find((m: { id: string }) => m.id === l.washer);
    expect((await washer()).queued.map((q: { runId: string }) => q.runId)).toEqual([r2.id]);
    // The queued one is called off: stopped at its own start, so it never runs.
    const cancelled = (await http().post(`/v1/machine-runs/${r2.id}/stop`).set(l.attendant).expect(200)).body;
    expect(new Date(cancelled.stoppedAt).getTime()).toBe(r2.started_at.getTime());
    expect((await http().post(`/v1/machine-runs/${r2.id}/stop`).set(l.attendant).expect(409)).body.error.code).toBe('RUN_NOT_RUNNING');
    const board = await washer();
    expect([board.current.runId, board.queued]).toEqual([r1.id, []]);
    expect(await sql(l, `SELECT action FROM audit_logs WHERE action LIKE 'machine_run.%' ORDER BY occurred_at`)).toEqual([{ action: 'machine_run.cancelled' }]);

    // Another cycle queues behind the running one; voiding the running sale stops its run now.
    const third = (await sell([{ variantId: l.washCycle, quantity: '1', machineId: l.washer }]).expect(201)).body;
    expect((await runOf(third.id)).started_at.getTime()).toBe(r1.ends_at.getTime());
    await http().post(`/v1/sales/${first.id}/returns`).set(idem(l.manager)).send({ cashierSessionId: l.session, kind: 'VOID', reason: 'Wrong machine' }).expect(201);
    const stopped = await runOf(first.id);
    expect(stopped.stopped_at).not.toBeNull();
    expect(stopped.stopped_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await sql<{ metadata: { machineRunsEnded: string[] } }>(l, `SELECT metadata FROM audit_logs WHERE action = 'sale.voided' AND resource_id = $1`, [first.id]))[0]!.metadata.machineRunsEnded).toEqual([r1.id]);
    // Returning the still-queued sale in full calls its run off.
    await http().post(`/v1/sales/${third.id}/returns`).set(idem(l.manager))
      .send({ cashierSessionId: l.session, kind: 'RETURN', reason: 'Changed mind', lines: [{ saleLineId: third.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    const r3 = await runOf(third.id);
    expect(r3.stopped_at!.getTime()).toBe(r3.started_at.getTime());
    // Two dryer cycles (20 minutes), one returned: the run is cut to the 10 minutes kept.
    const dry = (await sell([{ variantId: l.dryCycle, quantity: '2', machineId: l.dryer }]).expect(201)).body;
    await http().post(`/v1/sales/${dry.id}/returns`).set(idem(l.manager))
      .send({ cashierSessionId: l.session, kind: 'RETURN', reason: 'One was enough', lines: [{ saleLineId: dry.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    const rd = await runOf(dry.id);
    expect(rd.stopped_at!.getTime() - rd.started_at.getTime()).toBe(10 * 60_000);
    expect(await asOwnerInTenant(owner, l.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('disposal goes ahead once the final notice was SENT', async () => {
    const l = await laundry('lnd-f-sent');
    const job = (await receive(l, { lines: [{ variantId: l.wdf, quantity: '3' }] }).expect(201)).body;
    await status(l, job.id, 'READY').expect(200);
    await sql(l, `UPDATE job_orders SET ready_at = now() - interval '31 days' WHERE id = $1`, [job.id]);
    await sql(l, `SELECT platform_flag_laundry_notices()`);
    await sql(l, `UPDATE job_order_notices SET status = 'SENT', sms_status = 'SENT', settled_at = now() WHERE job_order_id = $1 AND kind = 'FINAL'`, [job.id]);
    expect((await http().post(`/v1/job-orders/${job.id}/dispose`).set(idem(l.manager)).send({ reason: 'DISCARDED' }).expect(200)).body.status).toBe('DISPOSED');
    expect((await sql<{ metadata: Record<string, unknown> }>(l, `SELECT metadata FROM audit_logs WHERE action = 'job_order.disposed' AND resource_id = $1`, [job.id]))[0]!.metadata)
      .toMatchObject({ finalNotice: 'SENT' });
  });
});
