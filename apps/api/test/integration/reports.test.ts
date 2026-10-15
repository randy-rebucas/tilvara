import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

/** Today in Manila — reports take local dates. */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() - 86_400_000));

interface Day {
  tenantId: string;
  owner: Auth;
  cashier: Auth;
  manager: Auth;
  cashierId: string;
  managerId: string;
  branchId: string;
  branch2Id: string;
  sessionId: string;
  cola: string;
  rice: string;
  wrap: string;
}

let d: Day;

/** A realistic day: cash, SC, card, a voided sale and a partial return. */
async function day(): Promise<Day> {
  const t = await signup(app, 'reports');
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Report Corp', vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const br2 = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cola = await product('Cola', '22.40');
  const rice = await product('Rice', '56.00', { taxCategoryId: taxes.VAT_EXEMPT });
  const wrap = await product('Gift wrap', '15.00', { productType: 'SERVICE', trackInventory: false });
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  const cashier = bearer(await loginToken(app, c.email));
  const manager = bearer(await loginToken(app, m.email));

  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: reg.body.id, openingFloat: '500.00' }).expect(201)).body;
  const sell = async (lines: unknown[], tenders: unknown[], extra: Record<string, unknown> = {}, clientTransactionId = randomUUID()) =>
    (await http().post('/v1/sales').set(cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: session.id, clientTransactionId, lines, tenders, ...extra }).expect(201)).body;

  const s1 = await sell([{ variantId: cola, quantity: '2' }, { variantId: rice, quantity: '1' }], [{ method: 'CASH', tendered: '200.00' }]);
  await sell([{ variantId: cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'b' } }], [{ method: 'CASH', tendered: '20.00' }], {
    beneficiaries: [{ ref: 'b', scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }],
  });
  const ctx = randomUUID();
  const card = (await http().post('/v1/payment-intents').set(cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: session.id, clientTransactionId: ctx, method: 'CARD', amount: '22.40' }).expect(201)).body;
  await sell([{ variantId: cola, quantity: '1' }], [{ method: 'INTENT', paymentIntentId: card.id }], {}, ctx);
  const s4 = await sell([{ variantId: wrap, quantity: '1' }], [{ method: 'CASH', tendered: '15.00' }]);
  const ret = (saleId: string, body: Record<string, unknown>) =>
    http().post(`/v1/sales/${saleId}/returns`).set(manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: session.id, ...body }).expect(201);
  await ret(s4.id, { kind: 'VOID', reason: 'Mistake' });
  await ret(s1.id, { kind: 'RETURN', reason: 'Dented', lines: [{ saleLineId: s1.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] });

  return { tenantId: t.tenantId, owner: auth, cashier, manager, cashierId: c.userId, managerId: m.userId, branchId: br.body.id, branch2Id: br2.body.id, sessionId: session.id, cola, rice, wrap };
}

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  d = await day();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const report = (name: string, auth: Auth = d.manager, q: Record<string, string> = {}) =>
  http().get(`/v1/reports/${name}`).query({ branchId: d.branchId, from: today, to: today, ...q }).set(auth);

describe('reports reconcile to source rows', () => {
  it('sales summary: 4 sales, 1 void + 1 return, net of returns', async () => {
    const r = (await report('sales-summary').expect(200)).body;
    expect(r.totals).toMatchObject({
      salesCount: 4,
      returnsCount: 2,
      sales: { amountDue: '154.20', statutoryDiscount: '4.00', vatExemptSales: '76.00' },
      returns: { amountDue: '37.40' },
      net: { amountDue: '116.80' },
    });
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({ day: today, voidsCount: 1 });
    // Independently from the evidence tables:
    const db = await asOwnerInTenant(owner, d.tenantId, async (c) => {
      const s = await c.query(`SELECT sum(amount_due) AS v FROM sales WHERE branch_id = $1`, [d.branchId]);
      const x = await c.query(`SELECT sum(amount_due) AS v FROM sale_returns WHERE branch_id = $1`, [d.branchId]);
      return (Number(s.rows[0].v) - Number(x.rows[0].v)).toFixed(2);
    });
    expect(r.totals.net.amountDue).toBe(db);
  });

  it('by product: quantities and net sales, summing to the summary', async () => {
    const r = (await report('by-product').expect(200)).body.data as Record<string, string>[];
    const by = Object.fromEntries(r.map((x) => [x.variantId, x]));
    expect(by[d.cola]).toMatchObject({ quantitySold: '4', quantityReturned: '1', netQuantity: '3', netSales: '60.80' });
    expect(by[d.rice]).toMatchObject({ netQuantity: '1', netSales: '56.00' });
    expect(by[d.wrap]).toMatchObject({ quantitySold: '1', quantityReturned: '1', netQuantity: '0', netSales: '0.00' });
    expect(r.reduce((a, x) => a + Math.round(Number(x.netSales) * 100), 0) / 100).toBe(116.8);
  });

  it('by cashier: who sold and who refunded', async () => {
    const r = (await report('by-cashier').expect(200)).body.data as Record<string, unknown>[];
    expect(r.find((x) => x.userId === d.cashierId)).toMatchObject({ salesCount: 4, sales: '154.20', returnsProcessed: 0 });
    expect(r.find((x) => x.userId === d.managerId)).toMatchObject({ salesCount: 0, returnsProcessed: 2, returns: '37.40' });
  });

  it('by tender: cash collected minus cash refunds, card separately; nets to the summary', async () => {
    const r = (await report('by-tender').expect(200)).body.data as Record<string, string>[];
    expect(r.find((x) => x.method === 'CASH')).toMatchObject({ collected: '131.80', refunded: '37.40', net: '94.40' });
    expect(r.find((x) => x.method === 'CARD')).toMatchObject({ collected: '22.40', refunded: '0.00', net: '22.40' });
    expect(r.reduce((a, x) => a + Math.round(Number(x.net) * 100), 0) / 100).toBe(116.8);
  });

  it('tax summary: buckets by VAT rate equal the summary net buckets', async () => {
    const summary = (await report('sales-summary').expect(200)).body.totals.net;
    const r = (await report('tax-summary').expect(200)).body.data;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ vatStatus: 'VAT', vatRate: '0.12' });
    for (const k of ['vatableSales', 'vatAmount', 'vatExemptSales', 'zeroRatedSales', 'statutoryDiscount', 'amountDue']) expect([k, r[0][k]]).toEqual([k, summary[k]]);
  });

  it('SC/PWD book lists the beneficiary sale with ID, exempt sales and discount', async () => {
    const r = (await report('statutory-book', d.manager, { scheme: 'SC' }).expect(200)).body.data;
    expect(r).toEqual([
      expect.objectContaining({ document: 'SALE', day: today, number: 2, register: 'R1', schemeCode: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001', sales: '20.00', discount: '4.00', net: '16.00' }),
    ]);
    expect((await report('statutory-book', d.manager, { scheme: 'PWD' }).expect(200)).body.data).toEqual([]);
  });

  it('cashier session report: drawer = float + cash sales − refunds', async () => {
    const r = (await http().get(`/v1/reports/cashier-sessions/${d.sessionId}`).set(d.cashier).expect(200)).body;
    expect(r).toMatchObject({ expectedCash: '594.40', sales: { count: 4, amountDue: '154.20', firstNumber: 1, lastNumber: 4 } });
    expect(r.tenders).toEqual([
      { method: 'CARD', count: 1, amount: '22.40' },
      { method: 'CASH', count: 3, amount: '131.80' },
    ]);
    expect(r.returns).toEqual([
      { kind: 'RETURN', count: 1, amount: '22.40' },
      { kind: 'VOID', count: 1, amount: '15.00' },
    ]);
    expect(r.drawer.find((m: { type: string }) => m.type === 'REFUND')).toMatchObject({ count: 2, amount: '-37.40' });
  });

  it('dates are local and inclusive: yesterday has nothing', async () => {
    const r = (await report('sales-summary', d.manager, { from: yesterday, to: yesterday }).expect(200)).body;
    expect(r.totals).toMatchObject({ salesCount: 0, net: { amountDue: '0.00' } });
  });
});

describe('report access', () => {
  it('needs reports.read at the branch; cashiers see only their own session report', async () => {
    await report('sales-summary', d.cashier).expect(403);
    await report('sales-summary', d.manager, { branchId: d.branch2Id }).expect(403);
    await report('sales-summary', d.owner, { branchId: d.branch2Id }).expect(200);
    const other = await addMember(owner, d.tenantId, 'cashier', { type: 'BRANCH', id: d.branchId });
    const otherAuth = bearer(await loginToken(app, other.email));
    await http().get(`/v1/reports/cashier-sessions/${d.sessionId}`).set(otherAuth).expect(403);
  });

  it('validates ranges', async () => {
    await report('sales-summary', d.manager, { from: today, to: yesterday }).expect(400);
    await report('sales-summary', d.manager, { from: '2020-01-01', to: today }).expect(400);
    await report('sales-summary', d.manager, { from: 'yesterday' }).expect(400);
  });
});
