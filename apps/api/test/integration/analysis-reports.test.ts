import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/** Reports added in session 20 (SPEC §6.10): by category, by branch, discounts, purchases by supplier, payment exceptions. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
type Auth = { Authorization: string };

let t: SignedUp;
let auth: Auth;
let entity: string;
let b1: string;
let b2: string;
let manager: Auth;
let cashier: Auth;
let cola: string;
let rice: string;
let wrap: string;
let supplier: string;
let session1: string;

const idem = (path: string, body: object, as: Auth = auth) => http().post(path).set(as).set('Idempotency-Key', randomUUID()).send(body);
const sell = (sessionId: string, lines: object[], tendered: string, as: Auth = auth) =>
  idem('/v1/sales', { cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered }] }, as);
const report = (path: string, branchId: string, as: Auth = auth) => http().get(`/v1/reports/${path}`).query({ branchId, from: today(), to: today() }).set(as);
const cents = (v: string) => Math.round(Number(v) * 100);

beforeAll(async () => {
  app = await createApp({ PAYMENT_TIMEOUT_MS: 400 });
  owner = ownerPool();
  t = await signup(app, 'anl');
  auth = bearer(t.access);
  entity = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Analysis Corp', vatStatus: 'VAT' }).expect(201)).body.id;
  b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: entity, code: 'B1', name: 'One' }).expect(201)).body.id;
  b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: entity, code: 'B2', name: 'Two', birBranchCode: '00002' }).expect(201)).body.id;
  const r1 = (await http().post('/v1/registers').set(auth).send({ branchId: b1, code: 'R1', name: 'One' }).expect(201)).body.id;
  const r2 = (await http().post('/v1/registers').set(auth).send({ branchId: b2, code: 'R1', name: 'Two' }).expect(201)).body.id;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const drinks = (await http().post('/v1/categories').set(auth).send({ name: 'Drinks' }).expect(201)).body.id;
  const soda = (await http().post('/v1/categories').set(auth).send({ name: 'Soda', parentId: drinks }).expect(201)).body.id;
  const food = (await http().post('/v1/categories').set(auth).send({ name: 'Food' }).expect(201)).body.id;
  const product = async (body: Record<string, unknown>, price: string) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: taxes.VAT, ...body, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  cola = await product({ name: 'Cola', categoryId: soda }, '22.40');
  rice = await product({ name: 'Rice', categoryId: food, taxCategoryId: taxes.VAT_EXEMPT }, '56.00');
  wrap = await product({ name: 'Gift wrap', productType: 'SERVICE', trackInventory: false }, '15.00');
  // Stock comes from a supplier: 10 colas received at ₱12, one sent back; 10 rice at ₱40 at each branch.
  supplier = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP1', name: 'Soft Drinks Inc' }).expect(201)).body.id;
  const receipt = (await idem('/v1/goods-receipts', { branchId: b1, supplierId: supplier, lines: [{ variantId: cola, quantity: '10', unitCost: '12.00' }, { variantId: rice, quantity: '10', unitCost: '40.00' }] }).expect(201)).body;
  await idem('/v1/supplier-returns', { branchId: b1, supplierId: supplier, goodsReceiptId: receipt.id, reason: 'Dented', lines: [{ goodsReceiptLineId: receipt.lines.find((l: { variantId: string }) => l.variantId === cola).id, variantId: cola, quantity: '1' }] }).expect(201);
  await idem('/v1/stock/adjustments', { branchId: b2, reason: 'Opening', items: [{ variantId: rice, quantity: '10', unitCost: '40.00' }] }).expect(201);

  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: b1 });
  manager = bearer(await loginToken(app, m.email));
  cashier = bearer(await loginToken(app, (await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: b1 })).email));

  session1 = (await http().post('/v1/cashier-sessions').set(manager).send({ registerId: r1, openingFloat: '500.00' }).expect(201)).body.id;
  // B1: 2 colas at 10 % off + a rice; a cola at an approved ₱20.00; a gift wrap; one cola comes back.
  const first = (await sell(session1, [{ variantId: cola, quantity: '2', discountRate: '0.1' }, { variantId: rice, quantity: '1' }], '100.32', manager).expect(201)).body;
  const approval = (await http().post('/v1/price-overrides').set(manager).send({ branchId: b1, variantId: cola, unitPrice: '20.00', quantity: '1', reason: 'Dented can' }).expect(201)).body;
  await sell(session1, [{ variantId: cola, quantity: '1', priceOverrideId: approval.id }, { variantId: wrap, quantity: '1' }], '35.00', manager).expect(201);
  await idem(`/v1/sales/${first.id}/returns`, { cashierSessionId: session1, kind: 'RETURN', reason: 'Flat', lines: [{ saleLineId: first.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }, manager).expect(201);
  // B2: one rice.
  const session2 = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: r2, openingFloat: '0.00' }).expect(201)).body.id;
  await sell(session2, [{ variantId: rice, quantity: '1' }], '56.00').expect(201);
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('sales by category', () => {
  it('each category, and rolled up to its top level; both add up to the product report', async () => {
    const r = (await report('by-category', b1).expect(200)).body;
    const products = (await report('by-product', b1).expect(200)).body.data as { netSales: string; cogs: string; grossProfit: string }[];
    const own = Object.fromEntries(r.data.map((c: { path: string[]; netSales: string }) => [c.path.join(' › ') || '(none)', c.netSales]));
    // Colas: 2 × 22.40 − 4.48 discount = 40.32, less one back (20.16), + one at 20.00 → 40.16.
    expect(own).toEqual({ 'Drinks › Soda': '40.16', Food: '56.00', '(none)': '15.00' });
    expect(r.top.map((c: { name: string | null; netSales: string }) => [c.name, c.netSales])).toEqual([['Food', '56.00'], ['Drinks', '40.16'], [null, '15.00']]);
    for (const k of ['netSales', 'cogs', 'grossProfit'] as const) {
      expect([k, cents(r.totals[k])]).toEqual([k, products.reduce((a, p) => a + cents(p[k]), 0)]);
    }
  });
});

describe('sales by branch (consolidated)', () => {
  it('every branch the person may report on, each from its own days, and the total', async () => {
    const q = { from: today(), to: today() };
    const all = (await http().get('/v1/reports/by-branch').query(q).set(auth).expect(200)).body;
    expect(all.data.map((b: { code: string; netSales: string }) => [b.code, b.netSales])).toEqual([['B1', '111.16'], ['B2', '56.00']]);
    for (const b of all.data as { branchId: string; netSales: string; vatAmount: string; discount: string }[]) {
      const sum = (await http().get('/v1/reports/sales-summary').query({ ...q, branchId: b.branchId }).set(auth).expect(200)).body.totals;
      expect([b.netSales, b.vatAmount, b.discount]).toEqual([sum.net.amountDue, sum.net.vatAmount, sum.sales.discount]);
    }
    expect(all.totals).toMatchObject({ netSales: '167.16', salesCount: 3, returnsCount: 1 });
    // A branch manager sees their branch; a cashier no report at all; another company none.
    expect((await http().get('/v1/reports/by-branch').query(q).set(manager).expect(200)).body.data.map((b: { code: string }) => b.code)).toEqual(['B1']);
    await http().get('/v1/reports/by-branch').query(q).set(cashier).expect(403);
    await http().get('/v1/reports/by-branch').query({ ...q, legalEntityId: randomUUID() }).set(auth).expect(403);
    await http().get('/v1/reports/by-branch').query({ from: '2026-01-01', to: '2027-06-30' }).set(auth).expect(400);
  });
});

describe('discounts and price changes', () => {
  it('every line sold off its list price, with who sold it and who approved the price; ties to the sales summary', async () => {
    const r = (await report('discounts', b1).expect(200)).body;
    expect(r.data.map((l: { name: string; quantity: string; listUnitPrice: string; unitPrice: string; discount: string; priceChange: string; approvalMethod: string | null }) => [l.name, l.quantity, l.listUnitPrice, l.unitPrice, l.discount, l.priceChange, l.approvalMethod]))
      .toEqual([['Cola', '2', '22.4', '22.4', '4.48', '0.00', null], ['Cola', '1', '22.4', '20', '0.00', '2.40', 'SELF']]);
    expect(r.data[1]).toMatchObject({ priceReason: 'Dented can', approvedByName: 'branch_manager' });
    expect(r.totals).toEqual({ lines: 2, discount: '4.48', priceChange: '2.40' });
    const summary = (await report('sales-summary', b1).expect(200)).body.totals;
    expect(r.totals.discount).toBe(summary.sales.discount);
    await report('discounts', b1, cashier).expect(403);
  });
});

describe('purchases by supplier', () => {
  it('received at receipt cost, returned to the supplier, the net and the invoices of the period', async () => {
    const r = (await report('purchases-by-supplier', b1).expect(200)).body;
    expect(r.data).toEqual([expect.objectContaining({ code: 'SUP1', receipts: 1, received: '520.00', supplierReturns: 1, returned: '12.00', netReceived: '508.00', invoices: 0, invoiced: '0.00' })]);
    expect(r.totals.netReceived).toBe('508.00');
    expect((await report('purchases-by-supplier', b2).expect(200)).body.data).toEqual([]);
  });
});

describe('payment exceptions', () => {
  it('card/QR payments that still need someone, on any shift, oldest first', async () => {
    const intent = (await idem('/v1/payment-intents', { cashierSessionId: session1, clientTransactionId: randomUUID(), method: 'CARD', amount: '9.00' }, manager).expect(201)).body;
    const r = (await http().get('/v1/reports/payment-exceptions').query({ branchId: b1 }).set(manager).expect(200)).body;
    const mine = r.data.find((p: { id: string }) => p.id === intent.id);
    expect(mine).toMatchObject({ method: 'CARD', amount: '9.00', registerCode: 'R1', shiftStatus: 'OPEN' });
    expect(['NOT_IN_A_SALE', 'NO_ANSWER', 'WAITING']).toContain(mine.problem);
    expect((await http().get('/v1/reports/payment-exceptions').query({ branchId: b2 }).set(auth).expect(200)).body.data).toEqual([]);
    await http().get('/v1/reports/payment-exceptions').query({ branchId: b1 }).set(cashier).expect(403);
  });
});

describe('sales by branch: archived branches', () => {
  it('an archived branch that sold in the range stays in the total, marked; one with nothing in it is left out', async () => {
    const q = { from: today(), to: today() };
    const before = (await http().get('/v1/reports/by-branch').query(q).set(auth).expect(200)).body.totals.netSales as string;
    // B3 sells a rice today, then closes for good (shift counted, register and branch archived).
    const b3 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: entity, code: 'B3', name: 'Closed', birBranchCode: '00003' }).expect(201)).body.id;
    const r3 = (await http().post('/v1/registers').set(auth).send({ branchId: b3, code: 'R3', name: 'Three' }).expect(201)).body.id;
    await idem('/v1/stock/adjustments', { branchId: b3, reason: 'Opening', items: [{ variantId: rice, quantity: '1', unitCost: '40.00' }] }).expect(201);
    const s3 = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: r3, openingFloat: '0.00' }).expect(201)).body.id;
    const sold = (await sell(s3, [{ variantId: rice, quantity: '1' }], '56.00').expect(201)).body;
    // The sale and its returns carry the people's names (readers of a sale need not read the team).
    const nameOfOwner = (await http().get(`/v1/sales/${sold.id}`).set(auth).expect(200)).body.cashierName;
    expect(typeof nameOfOwner).toBe('string');
    await idem(`/v1/cashier-sessions/${s3}/close`, { countedCash: '56.00' }).expect(200);
    await idem(`/v1/registers/${r3}/archive`, {}).expect((r) => expect([200, 201]).toContain(r.status));
    await idem(`/v1/branches/${b3}/archive`, {}).expect((r) => expect([200, 201]).toContain(r.status));
    // B4 never sold anything and is archived too.
    const b4 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: entity, code: 'B4', name: 'Never opened', birBranchCode: '00004' }).expect(201)).body.id;
    await idem(`/v1/branches/${b4}/archive`, {}).expect((r) => expect([200, 201]).toContain(r.status));

    const all = (await http().get('/v1/reports/by-branch').query(q).set(auth).expect(200)).body;
    const closed = all.data.find((b: { code: string }) => b.code === 'B3');
    expect(closed).toMatchObject({ netSales: '56.00', salesCount: 1 });
    expect(closed.archivedAt).toBeTruthy();
    expect(all.data.map((b: { code: string }) => b.code)).not.toContain('B4');
    expect(all.data.find((b: { code: string }) => b.code === 'B1').archivedAt).toBeNull();
    expect(all.totals.netSales).toBe((Number(before) + 56).toFixed(2));
    // Its own reports still answer for it.
    expect((await report('sales-summary', b3).expect(200)).body.totals.net.amountDue).toBe('56.00');
  });
});
