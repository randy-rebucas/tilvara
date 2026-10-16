import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Transfers, counts, waste, reorder points and inventory reports (Phase 3 slice 3). */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, extra: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price: '22.40', ...variant }] }).expect(201)).body.variants[0].id as string;
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: b1 });
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: b1 });
  return { tenantId: t.tenantId, auth, b1, b2, product, manager: bearer(await loginToken(app, m.email)), cashier: bearer(await loginToken(app, c.email)) };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const adjust = (s: Shop, branchId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  http().post('/v1/stock/adjustments').set(s.auth).send({ branchId, reason: 'Opening', items, ...extra });
const balance = async (s: Shop, branchId: string, variantId: string) =>
  (await http().get('/v1/stock/balances').query({ branchId, variantId }).set(s.auth).expect(200)).body.data[0] as { quantity: string; avgCost: string; value: string } | undefined;
const post = (s: Shop, path: string, body: unknown, auth: Auth = s.auth) => http().post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body as object);
async function assertLedger(s: Shop) {
  const drift = await asOwnerInTenant(owner, s.tenantId, async (c) =>
    (await c.query(`SELECT b.branch_id, b.variant_id FROM stock_balances b
       LEFT JOIN stock_movements m ON m.branch_id = b.branch_id AND m.variant_id = b.variant_id
      GROUP BY b.branch_id, b.variant_id, b.quantity, b.value
     HAVING b.quantity <> coalesce(sum(m.quantity), 0) OR b.value <> coalesce(sum(m.value), 0)`)).rows,
  );
  expect(drift).toEqual([]);
}

describe('transfers between branches', () => {
  it('leave at the source average, arrive at that cost, and a shortfall is a visible transit loss', async () => {
    const s = await shop('inv-xfer');
    const cola = await s.product('Cola');
    await adjust(s, s.b1, [{ variantId: cola, quantity: '10', unitCost: '12.00' }]).expect(201);
    await adjust(s, s.b2, [{ variantId: cola, quantity: '2', unitCost: '15.00' }]).expect(201);
    const t = (await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: cola, quantity: '4' }] }).expect(201)).body;
    expect(t).toMatchObject({ transferNumber: 1, status: 'DISPATCHED', sentValue: '48.00', inTransitValue: '48.00', lines: [{ quantity: '4', unitCost: '12.0000', receivedQuantity: null }] });
    expect(await balance(s, s.b1, cola)).toMatchObject({ quantity: '6', value: '72.00' });
    expect(await balance(s, s.b2, cola)).toMatchObject({ quantity: '2' });

    const line = t.lines[0].id;
    expect((await post(s, `/v1/stock/transfers/${t.id}/receive`, { lines: [{ transferLineId: line, receivedQuantity: '3' }] }).expect(422)).body.error.code).toBe('DISCREPANCY_REASON_REQUIRED');
    expect((await post(s, `/v1/stock/transfers/${t.id}/receive`, { lines: [{ transferLineId: line, receivedQuantity: '5' }] }).expect(422)).body.error.code).toBe('OVER_RECEIPT');
    const got = (await post(s, `/v1/stock/transfers/${t.id}/receive`, { lines: [{ transferLineId: line, receivedQuantity: '3', discrepancyReason: 'One bottle broke' }] }).expect(200)).body;
    expect(got).toMatchObject({ status: 'RECEIVED', receivedValue: '36.00', transitLossValue: '12.00', lines: [{ receivedQuantity: '3', shortQuantity: '1', discrepancyReason: 'One bottle broke' }] });
    expect(await balance(s, s.b2, cola)).toMatchObject({ quantity: '5', value: '66.00', avgCost: '13.2000' });
    expect((await post(s, `/v1/stock/transfers/${t.id}/receive`, {}).expect(409)).body.error.code).toBe('ALREADY_RECEIVED');
    expect((await http().get('/v1/stock/transfers').query({ branchId: s.b2, direction: 'IN' }).set(s.auth).expect(200)).body.data).toHaveLength(1);
    // DB backstop: what was received is final.
    const err = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE stock_transfer_lines SET received_quantity = 4`)).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/received once/);
    await assertLedger(s);
  });

  it('rules: another branch, stocked items, permissions at each end, key required', async () => {
    const s = await shop('inv-xrule');
    const cola = await s.product('Cola');
    const fee = await s.product('Fee', { productType: 'SERVICE', trackInventory: false });
    await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b1, lines: [{ variantId: cola, quantity: '1' }] }).expect(400);
    expect((await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: fee, quantity: '1' }] }).expect(422)).body.error.code).toBe('NOT_STOCKED');
    await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: cola, quantity: '1' }] }, s.cashier).expect(403);
    const t = (await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: cola, quantity: '1' }] }, s.manager).expect(201)).body;
    // The B1 manager sent it; only someone with inventory.transfer at B2 may receive it.
    await post(s, `/v1/stock/transfers/${t.id}/receive`, {}, s.manager).expect(403);
    await http().get(`/v1/stock/transfers/${t.id}`).set(s.manager).expect(200);
    await http().post(`/v1/stock/transfers/${t.id}/receive`).set(s.auth).send({}).expect(400);
  });
});

describe('stock counts and waste', () => {
  it('a count posts counted − on hand at posting time; equal lines move nothing; surpluses come in at the last average or reference cost', async () => {
    const s = await shop('inv-count');
    const cola = await s.product('Cola');
    const rice = await s.product('Rice');
    const soap = await s.product('Soap', {}, { referenceCost: '9.00' });
    await adjust(s, s.b1, [{ variantId: cola, quantity: '6', unitCost: '12.00' }, { variantId: rice, quantity: '4', unitCost: '40.00' }]).expect(201);
    const doc = (await post(s, '/v1/stock/counts', { branchId: s.b1, notes: 'Month-end', lines: [{ variantId: cola, countedQuantity: '5' }, { variantId: rice, countedQuantity: '4' }, { variantId: soap, countedQuantity: '3' }] }, s.manager).expect(201)).body;
    const by = Object.fromEntries(doc.lines.map((l: { variantId: string }) => [l.variantId, l]));
    expect(by[cola]).toMatchObject({ systemQuantity: '6', countedQuantity: '5', varianceQuantity: '-1', varianceValue: '-12.00' });
    expect(by[rice]).toMatchObject({ systemQuantity: '4', varianceQuantity: '0', varianceValue: '0.00' });
    expect(by[soap]).toMatchObject({ systemQuantity: '0', varianceQuantity: '3', varianceValue: '27.00' });
    expect(doc.varianceValue).toBe('15.00');
    expect(await asOwnerInTenant(owner, s.tenantId, async (c) => Number((await c.query(`SELECT count(*) AS n FROM stock_movements WHERE type = 'COUNT'`)).rows[0].n))).toBe(2);
    expect(await balance(s, s.b1, cola)).toMatchObject({ quantity: '5' });
    await post(s, '/v1/stock/counts', { branchId: s.b1, lines: [{ variantId: cola, countedQuantity: '1' }] }, s.cashier).expect(403);
    await assertLedger(s);
  });

  it('waste removes stock at the average with a reason; it can never add stock', async () => {
    const s = await shop('inv-waste');
    const bread = await s.product('Pandesal');
    await adjust(s, s.b1, [{ variantId: bread, quantity: '20', unitCost: '2.50' }]).expect(201);
    await adjust(s, s.b1, [{ variantId: bread, quantity: '3' }], { kind: 'WASTE', reason: 'Stale' }).expect(400);
    await adjust(s, s.b1, [{ variantId: bread, quantity: '-3' }], { kind: 'WASTE', reason: 'Stale' }).expect(201);
    const move = (await http().get('/v1/stock/movements').query({ branchId: s.b1, variantId: bread }).set(s.auth)).body.data[0];
    expect(move).toMatchObject({ type: 'WASTE', quantity: '-3', unitCost: '2.5000', value: '-7.50', reason: 'Stale' });
  });
});

describe('reorder points and low stock', () => {
  it('lists items at or below their point, nets what is on order, and suggests an order', async () => {
    const s = await shop('inv-low');
    const cola = await s.product('Cola');
    const rice = await s.product('Rice');
    await adjust(s, s.b1, [{ variantId: cola, quantity: '6', unitCost: '12.00' }, { variantId: rice, quantity: '9', unitCost: '40.00' }]).expect(201);
    await http().put('/v1/stock/reorder-points').set(s.manager).send({ branchId: s.b1, items: [{ variantId: cola, reorderPoint: '10', reorderQuantity: '24' }, { variantId: rice, reorderPoint: '5' }] }).expect(200);
    let low = (await http().get('/v1/stock/low').query({ branchId: s.b1 }).set(s.manager).expect(200)).body.data;
    expect(low).toEqual([expect.objectContaining({ variantId: cola, quantity: '6', reorderPoint: '10', onOrder: '0', suggestedOrder: '24', lastCost: '12.0000' })]);

    const supplier = (await http().post('/v1/suppliers').set(s.auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body;
    const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.b1, supplierId: supplier.id, lines: [{ variantId: cola, quantity: '24', unitCost: '12.00' }] }).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    low = (await http().get('/v1/stock/low').query({ branchId: s.b1 }).set(s.manager).expect(200)).body.data;
    expect(low[0]).toMatchObject({ low: true, onOrder: '24', suggestedOrder: '0' });

    const removed = (await http().put('/v1/stock/reorder-points').set(s.manager).send({ branchId: s.b1, items: [{ variantId: cola, reorderPoint: null }] }).expect(200)).body.data;
    expect(removed.map((r: { variantId: string }) => r.variantId)).toEqual([rice]);
    await http().put('/v1/stock/reorder-points').set(s.cashier).send({ branchId: s.b1, items: [{ variantId: rice, reorderPoint: '1' }] }).expect(403);
  });
});

describe('inventory reports', () => {
  it('valuation equals the ledger; movements roll opening → closing; gross profit = revenue ex VAT − COGS', async () => {
    const s = await shop('inv-rep');
    const cola = await s.product('Cola');
    await adjust(s, s.b1, [{ variantId: cola, quantity: '10', unitCost: '12.00' }]).expect(201);
    const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'R1', name: 'Counter' }).expect(201)).body.id;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: reg, openingFloat: '100.00' }).expect(201)).body.id;
    await post(s, '/v1/sales', { cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '50.00' }] }).expect(201);
    await adjust(s, s.b1, [{ variantId: cola, quantity: '-1' }], { kind: 'WASTE', reason: 'Dented' }).expect(201);

    const val = (await http().get('/v1/reports/inventory-valuation').query({ branchId: s.b1 }).set(s.manager).expect(200)).body;
    expect(val).toMatchObject({ totalValue: '84.00', ledgerValue: '84.00', data: [{ variantId: cola, quantity: '7', avgCost: '12.0000', value: '84.00' }] });

    const mv = (await http().get('/v1/reports/stock-movements').query({ branchId: s.b1, from: today, to: today }).set(s.manager).expect(200)).body.data;
    expect(mv).toEqual([
      expect.objectContaining({
        variantId: cola,
        opening: { quantity: '0', value: '0.00' },
        movements: { ADJUSTMENT: { quantity: '10', value: '120.00' }, SALE: { quantity: '-2', value: '-24.00' }, WASTE: { quantity: '-1', value: '-12.00' } },
        closing: { quantity: '7', value: '84.00' },
      }),
    ]);

    const gp = (await http().get('/v1/reports/by-product').query({ branchId: s.b1, from: today, to: today }).set(s.manager).expect(200)).body.data;
    // 2 × ₱22.40 VAT-inclusive = ₱44.80 → ₱40.00 ex VAT; COGS 2 × ₱12.00.
    expect(gp).toEqual([expect.objectContaining({ variantId: cola, netSales: '44.80', revenueExVat: '40.00', cogs: '24.00', grossProfit: '16.00' })]);
    await http().get('/v1/reports/inventory-valuation').query({ branchId: s.b1 }).set(s.cashier).expect(403);
  });
});
