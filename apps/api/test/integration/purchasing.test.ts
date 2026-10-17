import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Suppliers, purchase orders, goods receipts and supplier returns (Phase 3 slice 2). */
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

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const br2 = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price: '50.00' }] }).expect(201)).body.variants[0].id as string;
  const cola = await product('Cola');
  const rice = await product('Rice', { taxCategoryId: taxes.VAT_EXEMPT });
  const supplier = (await http().post('/v1/suppliers').set(auth).send({ code: 'COKE', name: 'Coca-Cola Beverages PH', tin: '000-111-222', paymentTermsDays: 30 }).expect(201)).body;
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const io = await addMember(owner, t.tenantId, 'inventory_officer', { type: 'BRANCH', id: br.body.id });
  return {
    tenantId: t.tenantId,
    auth,
    branchId: br.body.id as string,
    branch2Id: br2.body.id as string,
    cola,
    rice,
    product,
    supplierId: supplier.id as string,
    manager: bearer(await loginToken(app, m.email)),
    cashier: bearer(await loginToken(app, c.email)),
    officer: bearer(await loginToken(app, io.email)),
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const order = (s: Shop, lines: { variantId: string; quantity: string; unitCost: string }[], auth: Auth = s.auth) =>
  http().post('/v1/purchase-orders').set(auth).send({ branchId: s.branchId, supplierId: s.supplierId, lines });
const receive = (s: Shop, body: Record<string, unknown>, auth: Auth = s.auth, key = randomUUID()) =>
  http().post('/v1/goods-receipts').set(auth).set('Idempotency-Key', key).send({ branchId: s.branchId, supplierId: s.supplierId, ...body });
const balance = async (s: Shop, variantId: string) =>
  (await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.auth).expect(200)).body.data[0] as { quantity: string; avgCost: string; value: string } | undefined;
const count = (s: Shop, sql: string) => asOwnerInTenant(owner, s.tenantId, async (c) => Number((await c.query(sql)).rows[0].n));

describe('suppliers', () => {
  it('are maintained by purchasing, read by inventory roles, and codes are unique among active suppliers', async () => {
    const s = await shop('pur-sup');
    expect((await http().post('/v1/suppliers').set(s.auth).send({ code: 'coke', name: 'Dup' }).expect(409)).body.error.code).toBe('SUPPLIER_CODE_TAKEN');
    await http().patch(`/v1/suppliers/${s.supplierId}`).set(s.auth).send({ phone: '+63 2 8888 0000' }).expect(200);
    // Branch-scoped inventory officer: purchasing.manage only at a branch → may read, may not maintain tenant-wide suppliers.
    expect((await http().get('/v1/suppliers').set(s.officer).expect(200)).body.data).toHaveLength(1);
    await http().post('/v1/suppliers').set(s.officer).send({ code: 'X', name: 'X' }).expect(403);
    await http().get('/v1/suppliers').set(s.manager).expect(200);
    await http().get('/v1/suppliers').set(s.cashier).expect(403);
    await http().post('/v1/suppliers').set(s.auth).send({ code: 'BAD', name: 'x', email: 'not-an-email' }).expect(400);
  });

  it('cannot be archived with open orders; archived suppliers take no new orders and free their code', async () => {
    const s = await shop('pur-arch');
    const po = (await order(s, [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }]).expect(201)).body;
    expect((await http().post(`/v1/suppliers/${s.supplierId}/archive`).set(s.auth).expect(409)).body.error.code).toBe('SUPPLIER_HAS_OPEN_ORDERS');
    await http().post(`/v1/purchase-orders/${po.id}/cancel`).set(s.auth).send({ reason: 'Wrong supplier' }).expect(200);
    await http().post(`/v1/suppliers/${s.supplierId}/archive`).set(s.auth).expect(200);
    expect((await order(s, [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }]).expect(409)).body.error.code).toBe('ARCHIVED');
    await http().post('/v1/suppliers').set(s.auth).send({ code: 'COKE', name: 'New Coke account' }).expect(201);
  });
});

describe('purchase orders', () => {
  it('a draft is editable, an approved order is not, and ordering never moves stock', async () => {
    const s = await shop('pur-po');
    const po = (await order(s, [{ variantId: s.cola, quantity: '10', unitCost: '12.00' }]).expect(201)).body;
    expect(po).toMatchObject({ poNumber: 1, status: 'DRAFT', orderedValue: '120.00', supplier: { code: 'COKE' } });
    const edited = (await http().patch(`/v1/purchase-orders/${po.id}`).set(s.auth).send({ lines: [{ variantId: s.cola, quantity: '24', unitCost: '12.50' }, { variantId: s.rice, quantity: '5', unitCost: '40.00' }], supplierRef: 'Q-77' }).expect(200)).body;
    expect(edited).toMatchObject({ orderedValue: '500.00', supplierRef: 'Q-77' });
    expect(edited.lines.map((l: { lineNo: number; quantity: string }) => [l.lineNo, l.quantity])).toEqual([[1, '24'], [2, '5']]);
    const approved = (await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200)).body;
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: expect.any(String) });
    expect((await http().patch(`/v1/purchase-orders/${po.id}`).set(s.auth).send({ notes: 'late edit' }).expect(409)).body.error.code).toBe('INVALID_STATE');
    expect(await balance(s, s.cola)).toBeUndefined();
    // The database refuses line edits on a non-draft order, whoever asks.
    const err = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE purchase_order_lines SET quantity = 1`)).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/only a draft purchase order/);
    await order(s, [{ variantId: s.cola, quantity: '1', unitCost: '1' }], s.manager).expect(403);
    await order(s, [{ variantId: s.cola, quantity: '1', unitCost: '1' }, { variantId: s.cola, quantity: '2', unitCost: '1' }]).expect(400);
  });
});

describe('receiving', () => {
  it('partial receipts with a rejection, then the rest: stock at order cost, order RECEIVED, over-receipt refused', async () => {
    const s = await shop('pur-recv');
    const po = (await order(s, [{ variantId: s.cola, quantity: '10', unitCost: '12.00' }, { variantId: s.rice, quantity: '5', unitCost: '40.00' }]).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    const [colaLine, riceLine] = po.lines;
    const r1 = (await receive(s, {
      purchaseOrderId: po.id,
      supplierInvoiceRef: 'SI-1001',
      lines: [{ purchaseOrderLineId: colaLine.id, variantId: s.cola, quantity: '6', rejectedQuantity: '1', rejectionReason: 'Dented cans' }],
    }, s.manager).expect(201)).body;
    expect(r1).toMatchObject({ receiptNumber: 1, receivedValue: '72.00', lines: [{ quantity: '6', rejectedQuantity: '1', unitCost: '12.0000' }] });
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '6', avgCost: '12.0000', value: '72.00' });
    let view = (await http().get(`/v1/purchase-orders/${po.id}`).set(s.auth).expect(200)).body;
    expect(view).toMatchObject({ status: 'PARTIALLY_RECEIVED', receivedValue: '72.00' });
    expect(view.lines[0]).toMatchObject({ receivedQuantity: '6', rejectedQuantity: '1', remainingQuantity: '4' });

    const over = await receive(s, { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: colaLine.id, variantId: s.cola, quantity: '5' }] }).expect(422);
    expect(over.body.error).toMatchObject({ code: 'OVER_RECEIPT', details: { remaining: '4' } });
    expect(await count(s, `SELECT count(*) AS n FROM goods_receipts`)).toBe(1);

    await receive(s, { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: colaLine.id, variantId: s.cola, quantity: '4' }, { purchaseOrderLineId: riceLine.id, variantId: s.rice, quantity: '5', unitCost: '41.00' }] }).expect(201);
    view = (await http().get(`/v1/purchase-orders/${po.id}`).set(s.auth).expect(200)).body;
    expect(view).toMatchObject({ status: 'RECEIVED', receipts: [{ receiptNumber: 1 }, { receiptNumber: 2 }] });
    expect(await balance(s, s.rice)).toMatchObject({ quantity: '5', avgCost: '41.0000' });
    expect((await receive(s, { purchaseOrderId: po.id, lines: [{ variantId: s.cola, quantity: '1', unitCost: '1' }] }).expect(409)).body.error.code).toBe('ORDER_NOT_OPEN');
    await http().post(`/v1/purchase-orders/${po.id}/close`).set(s.auth).send({ reason: 'Complete' }).expect(200);
    // Ledger: every RECEIPT movement points at its receipt line and carries its cost.
    expect(await count(s, `SELECT count(*) AS n FROM stock_movements m JOIN goods_receipt_lines l ON l.id = m.goods_receipt_line_id WHERE m.type = 'RECEIPT' AND m.unit_cost = l.unit_cost AND m.quantity = l.quantity`)).toBe(3);
  });

  it('closing short, cancelling, and the rules for each', async () => {
    const s = await shop('pur-end');
    const po = (await order(s, [{ variantId: s.cola, quantity: '10', unitCost: '12.00' }]).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/close`).set(s.auth).send({ reason: 'x' }).expect(409);
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    await receive(s, { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0].id, variantId: s.cola, quantity: '3' }] }).expect(201);
    expect((await http().post(`/v1/purchase-orders/${po.id}/cancel`).set(s.auth).send({ reason: 'x' }).expect(409)).body.error.code).toBe('INVALID_STATE');
    const closed = (await http().post(`/v1/purchase-orders/${po.id}/close`).set(s.auth).send({ reason: 'Supplier out of stock' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'CLOSED', endReason: 'Supplier out of stock', lines: [{ remainingQuantity: '7' }] });
    expect((await receive(s, { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0].id, variantId: s.cola, quantity: '1' }] }).expect(409)).body.error.code).toBe('ORDER_NOT_OPEN');
    // DB backstop: an order with receipts can never be cancelled.
    const err = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = $1`, [po.id])).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/invalid purchase order transition|cannot be cancelled/);
  });

  it('receiving without an order, unordered extras, and validation', async () => {
    const s = await shop('pur-direct');
    await receive(s, { supplierDeliveryRef: 'DR-9', lines: [{ variantId: s.cola, quantity: '12', unitCost: '11.00' }] }).expect(201);
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '12', value: '132.00' });
    await receive(s, { lines: [{ variantId: s.cola, quantity: '1' }] }).expect(400); // no order line → cost required
    await receive(s, { lines: [{ variantId: s.cola, quantity: '0', rejectedQuantity: '2' }] }).expect(400); // rejection needs a reason
    await receive(s, { lines: [{ variantId: s.cola, quantity: '0', rejectedQuantity: '2', rejectionReason: 'Expired', unitCost: '11.00' }] }).expect(201);
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '12' });
    // A non-stock item is received (for the record and the payable) without a stock movement.
    const service = await s.product('Delivery fee', { productType: 'SERVICE', trackInventory: false });
    await receive(s, { lines: [{ variantId: service, quantity: '1', unitCost: '150.00' }] }).expect(201);
    expect(await count(s, `SELECT count(*) AS n FROM stock_movements WHERE variant_id = '${service}'`)).toBe(0);
  });

  it('who may receive: purchasing or inventory.adjust at that branch; the Idempotency-Key is required and replays', async () => {
    const s = await shop('pur-perm');
    await receive(s, { lines: [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }] }, s.cashier).expect(403);
    await http().post('/v1/goods-receipts').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branch2Id, supplierId: s.supplierId, lines: [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }] }).expect(403);
    await http().post('/v1/goods-receipts').set(s.auth).send({ branchId: s.branchId, supplierId: s.supplierId, lines: [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }] }).expect(400);
    const key = randomUUID();
    const body = { lines: [{ variantId: s.cola, quantity: '2', unitCost: '10.00' }] };
    const a = await receive(s, body, s.officer, key).expect(201);
    const b = await receive(s, body, s.officer, key).expect(201);
    expect([b.body.id, b.headers['idempotent-replayed']]).toEqual([a.body.id, 'true']);
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '2' });
  });

  it('concurrent receipts of the last outstanding units: exactly one succeeds', async () => {
    const s = await shop('pur-race');
    const po = (await order(s, [{ variantId: s.cola, quantity: '5', unitCost: '12.00' }]).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    const res = await Promise.all(
      Array.from({ length: 4 }, () => receive(s, { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0].id, variantId: s.cola, quantity: '5' }] })),
    );
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]); // the losers find the order RECEIVED
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '5' });
  });
});

describe('supplier returns', () => {
  it('leave at the average cost, credit the receipt cost, never exceed what was received', async () => {
    const s = await shop('pur-ret');
    await receive(s, { lines: [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }] }).expect(201);
    const r2 = (await receive(s, { supplierInvoiceRef: 'SI-2', lines: [{ variantId: s.cola, quantity: '10', unitCost: '14.00' }] }).expect(201)).body;
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '20', avgCost: '12.0000', value: '240.00' });
    const ret = (body: Record<string, unknown>) => http().post('/v1/supplier-returns').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, supplierId: s.supplierId, ...body });

    const doc = (await ret({ goodsReceiptId: r2.id, reason: 'Leaking', lines: [{ goodsReceiptLineId: r2.lines[0].id, variantId: s.cola, quantity: '3' }] }).expect(201)).body;
    expect(doc).toMatchObject({ returnNumber: 1, creditValue: '42.00', lines: [{ creditUnitCost: '14.0000' }] });
    const move = (await http().get('/v1/stock/movements').query({ branchId: s.branchId, variantId: s.cola }).set(s.auth)).body.data[0];
    expect(move).toMatchObject({ type: 'SUPPLIER_RETURN', quantity: '-3', unitCost: '12.0000', value: '-36.00' });
    expect(await balance(s, s.cola)).toMatchObject({ quantity: '17', value: '204.00' });

    const over = await ret({ goodsReceiptId: r2.id, reason: 'x', lines: [{ goodsReceiptLineId: r2.lines[0].id, variantId: s.cola, quantity: '8' }] }).expect(422);
    expect(over.body.error).toMatchObject({ code: 'RETURN_EXCEEDS_RECEIVED', details: { remaining: '7' } });
    // The receipt shows what already went back, and its returns (the admin offers only the rest).
    const shown = (await http().get(`/v1/goods-receipts/${r2.id}`).set(s.auth).expect(200)).body;
    expect(shown.lines[0]).toMatchObject({ quantity: '10', returnedQuantity: '3' });
    expect(shown.returns).toMatchObject([{ id: doc.id, returnNumber: 1, reason: 'Leaking' }]);
    const loose = (await ret({ reason: 'Short-dated', lines: [{ variantId: s.cola, quantity: '1' }] }).expect(201)).body;
    expect(loose.lines[0]).toMatchObject({ creditUnitCost: '12.0000' });
    await ret({ reason: 'x', lines: [{ variantId: s.cola, quantity: '1' }] }).set(s.manager).expect(403);
    expect((await http().get('/v1/supplier-returns').query({ branchId: s.branchId }).set(s.auth).expect(200)).body.data).toHaveLength(2);
    await http().get(`/v1/supplier-returns/${doc.id}`).set(s.manager).expect(200);
    await http().get(`/v1/supplier-returns/${doc.id}`).set(s.cashier).expect(403);

    // Evidence: append-only, and Σ ledger = balance.
    for (const q of [`UPDATE goods_receipt_lines SET unit_cost = 0`, `DELETE FROM supplier_return_lines`]) {
      const e = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(q)).then(() => null, (x: Error) => x.message);
      expect(e).toMatch(/append-only|not allowed|forbidden/i);
    }
    expect(await count(s, `SELECT count(*) AS n FROM stock_balances b WHERE b.value <> (SELECT sum(value) FROM stock_movements m WHERE m.branch_id = b.branch_id AND m.variant_id = b.variant_id)`)).toBe(0);
  });
});
