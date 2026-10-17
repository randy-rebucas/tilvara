import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Phase 2 exit review: paths the slice tests did not cover — several sessions and registers on
 * one day, returns processed in a different drawer than the sale's, a card-paid sale refunded in
 * cash (ADR-0011: cash refunds only), and local dates in branches far from UTC. Every figure is
 * checked against the evidence tables, and the reports against each other.
 */
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

const localDate = (instant: string | Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(instant));
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const cents = (v: string | number | undefined) => Math.round(Number(v ?? Number.NaN) * 100);

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  return { t, auth, legalEntityId: le.body.id as string, product, rice: () => product('Rice 1kg', '56.00', { taxCategoryId: taxes.VAT_EXEMPT }) };
}

const sell = (auth: Auth, body: Record<string, unknown>) => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send(body).expect(201).then((r) => r.body);
const cashSale = (auth: Auth, sessionId: string, lines: unknown[], tendered: string, extra: Record<string, unknown> = {}) =>
  sell(auth, { cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered }], ...extra });
const ret = (auth: Auth, saleId: string, body: Record<string, unknown>) =>
  http().post(`/v1/sales/${saleId}/returns`).set(auth).set('Idempotency-Key', randomUUID()).send(body).expect(201).then((r) => r.body);
const open = async (auth: Auth, registerId: string, openingFloat: string) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat }).expect(201)).body.id as string;
const close = async (auth: Auth, id: string, countedCash: string) =>
  (await http().post(`/v1/cashier-sessions/${id}/close`).set(auth).send({ countedCash }).expect(200)).body;

describe('a multi-register, multi-session day', () => {
  it('reconciles sale → tenders → drawers → stock → reports, with returns in other drawers and a card sale refunded in cash', async () => {
    const s = await shop('recon-day');
    const br = await http().post('/v1/branches').set(s.auth).send({ legalEntityId: s.legalEntityId, code: 'B1', name: 'One' }).expect(201);
    const branchId = br.body.id as string;
    const r1 = (await http().post('/v1/registers').set(s.auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
    const r2 = (await http().post('/v1/registers').set(s.auth).send({ branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
    const cola = await s.product('Cola', '22.40');
    const rice = await s.rice();
    const a = await addMember(owner, s.t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
    const b = await addMember(owner, s.t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
    const m = await addMember(owner, s.t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
    const [ann, ben, mgr] = [bearer(await loginToken(app, a.email)), bearer(await loginToken(app, b.email)), bearer(await loginToken(app, m.email))];
    await http().post('/v1/stock/adjustments').set(mgr).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '50' }, { variantId: rice, quantity: '10' }] }).expect(201);

    // Morning shift on R1: cash, card-only, QR + cash split.
    const a1 = await open(ann, r1, '1000.00');
    const s1 = await cashSale(ann, a1, [{ variantId: cola, quantity: '2' }, { variantId: rice, quantity: '1' }], '200.00');
    const intent = async (sessionId: string, clientTransactionId: string, method: string, amount: string) =>
      (await http().post('/v1/payment-intents').set(ann).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: sessionId, clientTransactionId, method, amount }).expect(201)).body.id as string;
    const tx2 = randomUUID();
    const s2 = await sell(ann, { cashierSessionId: a1, clientTransactionId: tx2, lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: await intent(a1, tx2, 'CARD', '22.40') }] });
    const tx3 = randomUUID();
    const s3 = await sell(ann, {
      cashierSessionId: a1,
      clientTransactionId: tx3,
      lines: [{ variantId: cola, quantity: '3' }],
      tenders: [{ method: 'INTENT', paymentIntentId: await intent(a1, tx3, 'QR', '50.00') }, { method: 'CASH', tendered: '20.00' }],
    });
    expect([s1.amountDue, s2.amountDue, s3.amountDue, s3.changeDue]).toEqual(['100.80', '22.40', '67.20', '2.80']);
    expect((await close(ann, a1, '1118.00')).status).toBe('RECONCILED');

    // Afternoon: a second shift on R1 (same cashier) and one on R2.
    const a2 = await open(ann, r1, '500.00');
    const s4 = await cashSale(ann, a2, [{ variantId: rice, quantity: '2' }], '120.00');
    const b1 = await open(ben, r2, '300.00');
    const s5 = await cashSale(ben, b1, [{ variantId: cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'x' } }], '16.00', {
      beneficiaries: [{ ref: 'x', scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }],
    });
    expect(s5.amountDue).toBe('16.00');

    // The manager refunds the morning card sale in cash from Ben's drawer, a damaged rice from
    // Ann's afternoon drawer, and voids Ann's afternoon sale in its own session.
    await ret(mgr, s2.id, { cashierSessionId: b1, kind: 'RETURN', reason: 'Wrong item', lines: [{ saleLineId: s2.lines[0].id, quantity: '1', disposition: 'RESTOCK' }], expectedRefund: '22.40' });
    await ret(mgr, s1.id, { cashierSessionId: a2, kind: 'RETURN', reason: 'Torn bag', lines: [{ saleLineId: s1.lines[1].id, quantity: '1', disposition: 'DAMAGED' }] });
    await ret(mgr, s4.id, { cashierSessionId: a2, kind: 'VOID', reason: 'Rang twice' });
    // The morning sale cannot be voided from the afternoon session.
    await http().post(`/v1/sales/${s3.id}/returns`).set(mgr).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: a2, kind: 'VOID', reason: 'x' }).expect(422);

    expect((await close(ann, a2, '444.00')).status).toBe('RECONCILED');
    expect((await close(ben, b1, '293.60')).status).toBe('RECONCILED');

    // ---- reports
    const day = localDate(s1.completedAt, 'Asia/Manila');
    const report = async (name: string) => (await http().get(`/v1/reports/${name}`).query({ branchId, from: day, to: day }).set(mgr).expect(200)).body;
    const summary = await report('sales-summary');
    expect(summary.totals).toMatchObject({ salesCount: 5, returnsCount: 3, sales: { amountDue: '318.40' }, returns: { amountDue: '190.40' }, net: { amountDue: '128.00' } });
    const tenders = (await report('by-tender')).data as Record<string, string>[];
    expect(Object.fromEntries(tenders.map((x) => [x.method, [x.collected, x.refunded, x.net]]))).toEqual({
      CARD: ['22.40', '0.00', '22.40'], // refunded in cash: card refunds wait for the PayMongo adapter
      QR: ['50.00', '0.00', '50.00'],
      CASH: ['246.00', '190.40', '55.60'],
    });
    const products = (await report('by-product')).data as Record<string, string>[];
    const tax = (await report('tax-summary')).data as Record<string, string>[];
    const cashiers = (await report('by-cashier')).data as Record<string, unknown>[];
    const net = cents(summary.totals.net.amountDue);
    expect(tenders.reduce((acc, x) => acc + cents(x.net), 0)).toBe(net);
    expect(products.reduce((acc, x) => acc + cents(x.netSales), 0)).toBe(net);
    expect(tax.reduce((acc, x) => acc + cents(x.amountDue), 0)).toBe(net);
    expect(cashiers.find((x) => x.userId === a.userId)).toMatchObject({ salesCount: 4, sales: '302.40', returnsProcessed: 0 });
    expect(cashiers.find((x) => x.userId === b.userId)).toMatchObject({ salesCount: 1, sales: '16.00' });
    expect(cashiers.find((x) => x.userId === m.userId)).toMatchObject({ returnsProcessed: 3, returns: '190.40' });

    // ---- session reports: each drawer holds only its own movements
    const session = async (id: string) => (await http().get(`/v1/reports/cashier-sessions/${id}`).set(mgr).expect(200)).body;
    const [ra1, ra2, rb1] = [await session(a1), await session(a2), await session(b1)];
    expect(ra1).toMatchObject({ expectedCash: '1118.00', returns: [], count: { countedCash: '1118.00', variance: '0.00' } });
    expect(ra1.tenders).toEqual([
      { method: 'CARD', count: 1, amount: '22.40' },
      { method: 'CASH', count: 2, amount: '118.00' },
      { method: 'QR', count: 1, amount: '50.00' },
    ]);
    expect(ra2).toMatchObject({ expectedCash: '444.00', sales: { count: 1, firstNumber: 4, lastNumber: 4 } });
    expect(ra2.returns).toEqual([{ kind: 'RETURN', count: 1, amount: '56.00' }, { kind: 'VOID', count: 1, amount: '112.00' }]);
    expect(rb1).toMatchObject({ expectedCash: '293.60', sales: { count: 1, firstNumber: 1, lastNumber: 1 } });
    expect(rb1.drawer.find((x: { type: string }) => x.type === 'REFUND')).toMatchObject({ count: 1, amount: '-22.40' });
    // Σ drawers (minus floats) = cash collected − cash refunded for the branch-day.
    const floats = cents('1000.00') + cents('500.00') + cents('300.00');
    expect(cents(ra1.expectedCash) + cents(ra2.expectedCash) + cents(rb1.expectedCash) - floats).toBe(cents(tenders.find((x) => x.method === 'CASH')!.net));

    // ---- evidence tables, independently of the report SQL
    await asOwnerInTenant(owner, s.t.tenantId, async (c) => {
      const one = async (q: string, p: unknown[] = []) => (await c.query(q, p)).rows[0];
      expect(cents((await one(`SELECT sum(amount_due) AS v FROM sales WHERE branch_id = $1`, [branchId])).v) - cents((await one(`SELECT sum(amount_due) AS v FROM sale_returns WHERE branch_id = $1`, [branchId])).v)).toBe(net);
      // Each sale: lines = header, tenders applied = due, cash movement = cash applied.
      const { rows: bad } = await c.query(`
        SELECT s.id FROM sales s
         WHERE s.branch_id = $1 AND (
               s.amount_due <> (SELECT sum(amount_due) FROM sale_lines WHERE sale_id = s.id)
            OR s.amount_due <> (SELECT sum(amount) FROM sale_tenders WHERE sale_id = s.id)
            OR coalesce((SELECT sum(amount) FROM sale_tenders WHERE sale_id = s.id AND method = 'CASH'), 0)
               <> coalesce((SELECT sum(amount) FROM cash_movements WHERE sale_id = s.id AND type = 'SALE'), 0))`, [branchId]);
      expect(bad).toEqual([]);
      // Each return: lines = header, refund movement = −amount, in the drawer that processed it.
      const { rows: badReturns } = await c.query(`
        SELECT r.id FROM sale_returns r
         WHERE r.branch_id = $1 AND (
               r.amount_due <> (SELECT sum(amount_due) FROM sale_return_lines WHERE sale_return_id = r.id)
            OR -r.amount_due <> (SELECT sum(amount) FROM cash_movements WHERE sale_return_id = r.id AND cashier_session_id = r.cashier_session_id))`, [branchId]);
      expect(badReturns).toEqual([]);
      // Every electronic tender is a consumed, succeeded intent of the same amount; none left over.
      const { rows: intents } = await c.query(`SELECT p.status, p.sale_id IS NOT NULL AS consumed, p.amount = t.amount AS same FROM payment_intents p LEFT JOIN sale_tenders t ON t.payment_intent_id = p.id`);
      expect(intents).toEqual([{ status: 'SUCCEEDED', consumed: true, same: true }, { status: 'SUCCEEDED', consumed: true, same: true }]);
      // Closed drawers: the recorded expectation equals the ledger, and nothing was added after closing.
      const { rows: drawers } = await c.query(`
        SELECT r.expected_cash = (SELECT sum(amount) FROM cash_movements m WHERE m.cashier_session_id = r.cashier_session_id) AS ok,
               (SELECT count(*) FROM cash_movements m WHERE m.cashier_session_id = r.cashier_session_id AND m.created_at > s.closed_at)::int AS late
          FROM cash_reconciliations r JOIN cashier_sessions s ON s.id = r.cashier_session_id`);
      expect(drawers).toEqual(Array(3).fill({ ok: true, late: 0 }));
      // Stock: balance = Σ ledger = opening − sold + restocked (damaged rice stays out).
      const stock = async (v: string) => Number((await one(`SELECT quantity FROM stock_balances WHERE variant_id = $1`, [v])).quantity);
      const ledger = async (v: string) => Number((await one(`SELECT sum(quantity) AS q FROM stock_movements WHERE variant_id = $1`, [v])).q);
      expect([await stock(cola), await ledger(cola)]).toEqual([50 - 2 - 1 - 3 - 1 + 1, 44]);
      expect([await stock(rice), await ledger(rice)]).toEqual([10 - 1 - 2 + 2, 9]);
    });
  });
});

describe('local business dates', () => {
  it('buckets by each branch’s own calendar day, far east and far west of UTC', async () => {
    const s = await shop('recon-tz');
    const cola = await s.product('Cola', '22.40');
    const zones = [
      { tz: 'Pacific/Kiritimati', code: 'KI', bir: '00001' }, // UTC+14
      { tz: 'Pacific/Pago_Pago', code: 'PP', bir: '00002' }, // UTC−11
    ];
    const days: string[] = [];
    for (const z of zones) {
      const br = (await http().post('/v1/branches').set(s.auth).send({ legalEntityId: s.legalEntityId, code: z.code, name: z.tz, birBranchCode: z.bir, timezone: z.tz }).expect(201)).body;
      const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: br.id, code: 'R1', name: 'Counter' }).expect(201)).body.id;
      const session = await open(s.auth, reg, '0');
      const sold = await cashSale(s.auth, session, [{ variantId: cola, quantity: '1' }], '22.40');
      const day = localDate(sold.completedAt, z.tz);
      days.push(day);
      const summary = async (from: string, to = from) => (await http().get('/v1/reports/sales-summary').query({ branchId: br.id, from, to }).set(s.auth).expect(200)).body;
      const hit = await summary(day);
      expect(hit.days).toEqual([expect.objectContaining({ day, salesCount: 1 })]);
      expect(hit.totals.net.amountDue).toBe('22.40');
      expect((await summary(shiftDay(day, -1))).totals.salesCount).toBe(0);
      expect((await summary(shiftDay(day, 1))).totals.salesCount).toBe(0);
      const book = await http().get('/v1/reports/by-tender').query({ branchId: br.id, from: shiftDay(day, -1), to: shiftDay(day, 1) }).set(s.auth).expect(200);
      expect(book.body.data).toEqual([expect.objectContaining({ method: 'CASH', net: '22.40' })]);
    }
    // 25 hours apart: the same moment is always a different business day (one or two days later).
    expect([1, 2]).toContain((Date.parse(days[0]!) - Date.parse(days[1]!)) / 86_400_000);
  });
});
