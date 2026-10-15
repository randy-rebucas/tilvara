import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

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

interface Store {
  t: SignedUp;
  auth: Auth;
  branchId: string;
  registerId: string;
  cola: string;
  wrap: string;
  rice: string;
  cashier: Auth;
  cashierId: string;
  manager: Auth;
}

async function store(prefix: string): Promise<Store> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (body: Record<string, unknown>, price: string) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: taxes.VAT, ...body, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cola = await product({ name: 'Cola 290ml' }, '22.40');
  const wrap = await product({ name: 'Gift wrap', productType: 'SERVICE', trackInventory: false }, '15.00');
  const rice = await product({ name: 'Rice 1kg', taxCategoryId: taxes.VAT_EXEMPT }, '56.00');
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  return {
    t,
    auth,
    branchId: br.body.id,
    registerId: reg.body.id,
    cola,
    wrap,
    rice,
    cashier: bearer(await loginToken(app, c.email)),
    cashierId: c.userId,
    manager: bearer(await loginToken(app, m.email)),
  };
}

const openSession = async (s: Store, auth: Auth = s.cashier, openingFloat = '1000.00', registerId = s.registerId) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat }).expect(201)).body as { id: string };

function sale(sessionId: string, lines: unknown[], tendered: string, extra: Record<string, unknown> = {}) {
  return { cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered }], ...extra };
}

const post = (auth: Auth, body: object, key = randomUUID()) => http().post('/v1/sales').set(auth).set('Idempotency-Key', key).send(body);

async function count(s: Store, sql: string, params: unknown[] = []): Promise<number> {
  return asOwnerInTenant(owner, s.t.tenantId, async (c) => Number((await c.query(sql, params)).rows[0].n));
}

/** Every sale reconciles: lines → totals, tenders → due + change, drawer → due, stock → −qty. */
async function assertReconciles(s: Store, saleId: string) {
  await asOwnerInTenant(owner, s.t.tenantId, async (c) => {
    const { rows: [sl] } = await c.query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
    for (const col of ['gross', 'discount', 'statutory_discount', 'vat_exemption_amount', 'vatable_sales', 'vat_amount', 'vat_exempt_sales', 'zero_rated_sales', 'percentage_tax_sales', 'amount_due']) {
      const { rows: [sum] } = await c.query(`SELECT coalesce(sum(${col}), 0) AS v FROM sale_lines WHERE sale_id = $1`, [saleId]);
      expect([col, Number(sum.v)]).toEqual([col, Number(sl[col])]);
    }
    const { rows: [t] } = await c.query(`SELECT sum(amount) AS applied, sum(tendered) AS tendered, sum(change) AS change FROM sale_tenders WHERE sale_id = $1`, [saleId]);
    expect(Number(t.applied)).toBe(Number(sl.amount_due));
    expect(Number(t.tendered) - Number(t.change)).toBe(Number(sl.amount_due));
    const { rows: cash } = await c.query(`SELECT amount FROM cash_movements WHERE sale_id = $1`, [saleId]);
    expect(cash.map((r) => Number(r.amount))).toEqual([Number(sl.amount_due)]);
    const { rows: stock } = await c.query(
      `SELECT l.quantity AS sold, m.quantity AS moved, p.track_inventory
         FROM sale_lines l JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
         LEFT JOIN stock_movements m ON m.sale_line_id = l.id WHERE l.sale_id = $1`,
      [saleId],
    );
    for (const r of stock) expect(r.track_inventory ? Number(r.moved) : r.moved).toBe(r.track_inventory ? -Number(r.sold) : null);
  });
}

describe('a full cashier shift', () => {
  it('opens, sells (incl. SC), pays out, closes with zero variance and everything reconciles', async () => {
    const s = await store('shift');
    await http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason: 'Opening stock', items: [{ variantId: s.cola, quantity: '24' }] }).expect(201);
    const session = await openSession(s);

    const first = await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }, { variantId: s.wrap, quantity: '1' }, { variantId: s.rice, quantity: '1' }], '200.00')).expect(201);
    expect(first.body).toMatchObject({ saleNumber: 1, amountDue: '115.80', amountTendered: '200.00', changeDue: '84.20', vatableSales: '53.39', vatAmount: '6.41', vatExemptSales: '56.00' });
    expect(first.body.lines).toHaveLength(3);
    await assertReconciles(s, first.body.id);

    const sc = await post(
      s.cashier,
      sale(session.id, [{ variantId: s.cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'lola' } }], '20.00', {
        beneficiaries: [{ ref: 'lola', scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }],
      }),
    ).expect(201);
    expect(sc.body).toMatchObject({ saleNumber: 2, amountDue: '16.00', statutoryDiscount: '4.00', vatExemptSales: '20.00', requiresProfessionalReview: true });
    expect(sc.body.beneficiaries).toMatchObject([{ schemeCode: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }]);
    expect(sc.body.lines[0].beneficiaryId).toBe(sc.body.beneficiaries[0].id);
    await assertReconciles(s, sc.body.id);

    await http().post(`/v1/cashier-sessions/${session.id}/movements`).set(s.cashier).send({ type: 'PAY_OUT', amount: '50.00', reason: 'Ice delivery' }).expect(201);
    const detail = (await http().get(`/v1/cashier-sessions/${session.id}`).set(s.cashier).expect(200)).body;
    expect(detail).toMatchObject({ expectedCash: '1081.80', sales: { count: 2, total: '131.80' } });

    const closed = (await http().post(`/v1/cashier-sessions/${session.id}/close`).set(s.cashier).send({ countedCash: '1081.80' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'RECONCILED', reconciliation: { expectedCash: '1081.80', countedCash: '1081.80', variance: '0.00' } });

    const bal = (await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId: s.cola }).set(s.manager).expect(200)).body.data;
    expect(bal).toMatchObject([{ quantity: '21' }]);
    expect(await count(s, `SELECT sum(quantity) AS n FROM stock_movements WHERE variant_id = $1`, [s.cola])).toBe(21);
    expect(await count(s, `SELECT count(*) AS n FROM outbox_events WHERE topic = 'sale.completed'`)).toBe(2);
  });
});

describe('retries and duplicates', () => {
  it('a retried checkout returns the original sale and records nothing twice', async () => {
    const s = await store('retry');
    const session = await openSession(s);
    const body = sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00');
    const key = randomUUID();
    const a = await post(s.cashier, body, key).expect(201);
    const b = await post(s.cashier, body, key).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(await count(s, `SELECT count(*) AS n FROM sales`)).toBe(1);
    expect(await count(s, `SELECT count(*) AS n FROM cash_movements WHERE type = 'SALE'`)).toBe(1);
    expect(await count(s, `SELECT count(*) AS n FROM stock_movements`)).toBe(1);
  });

  it('five concurrent submissions with one key create exactly one sale', async () => {
    const s = await store('race');
    const session = await openSession(s);
    const body = sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00');
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 5 }, () => post(s.cashier, body, key)));
    const ids = new Set(res.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    for (const r of res) expect([201, 409]).toContain(r.status);
    expect(await count(s, `SELECT count(*) AS n FROM sales`)).toBe(1);
  });

  it('the same terminal transaction under a new key is refused, not sold twice', async () => {
    const s = await store('dup');
    const session = await openSession(s);
    const body = sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00');
    await post(s.cashier, body).expect(201);
    const again = await post(s.cashier, body).expect(409);
    expect(again.body.error.code).toBe('DUPLICATE_TRANSACTION');
  });

  it('requires an Idempotency-Key', async () => {
    const s = await store('nokey');
    const session = await openSession(s);
    const res = await http().post('/v1/sales').set(s.cashier).send(sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00'));
    expect(res.status).toBe(400);
  });

  it('sale numbers are gapless per register under concurrency, and failures consume no number', async () => {
    const s = await store('seq');
    const session = await openSession(s);
    await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '1.00')).expect(422);
    const res = await Promise.all(Array.from({ length: 10 }, () => post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '22.40'))));
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(res.map((r) => r.body.saleNumber).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('failure leaves no trace', () => {
  it.each([
    ['insufficient tender', (s: Store, id: string) => sale(id, [{ variantId: s.cola, quantity: '1' }], '20.00'), 422, 'INSUFFICIENT_TENDER'],
    ['tender after the sale is paid', (s: Store, id: string) => ({ ...sale(id, [{ variantId: s.cola, quantity: '1' }], '30.00'), tenders: [{ method: 'CASH', tendered: '30.00' }, { method: 'CASH', tendered: '5.00' }] }), 422, 'UNNECESSARY_TENDER'],
    ['unknown item', (_s: Store, id: string) => sale(id, [{ variantId: randomUUID(), quantity: '1' }], '50.00'), 404, 'NOT_FOUND'],
    ['ordinary discount by a cashier', (s: Store, id: string) => sale(id, [{ variantId: s.cola, quantity: '1', discount: '2.00' }], '50.00'), 403, 'FORBIDDEN'],
    ['stale total', (s: Store, id: string) => sale(id, [{ variantId: s.cola, quantity: '1' }], '50.00', { expectedAmountDue: '20.00' }), 409, 'TOTAL_CHANGED'],
  ])('%s', async (_name, build, status, code) => {
    const s = await store('atomic');
    await http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: s.cola, quantity: '5' }] }).expect(201);
    const session = await openSession(s);
    const res = await post(s.cashier, build(s, session.id));
    expect([res.status, res.body.error?.code]).toEqual([status, code]);
    expect(await count(s, `SELECT count(*) AS n FROM sales`)).toBe(0);
    expect(await count(s, `SELECT count(*) AS n FROM sale_lines`)).toBe(0);
    expect(await count(s, `SELECT count(*) AS n FROM cash_movements WHERE type = 'SALE'`)).toBe(0);
    expect(await count(s, `SELECT sum(quantity) AS n FROM stock_balances`)).toBe(5);
    expect(await count(s, `SELECT count(*) AS n FROM sequence_counters`)).toBe(0);
  });

  it('a stale total reports the new amount so the cashier can re-confirm', async () => {
    const s = await store('stale');
    const session = await openSession(s);
    const res = await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }], '50.00', { expectedAmountDue: '40.00' })).expect(409);
    expect(res.body.error.details).toEqual({ amountDue: '44.80' });
  });

  it('statutory lines need a matching beneficiary with name and ID number', async () => {
    const s = await store('benef');
    const session = await openSession(s);
    const noRef = await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'x' } }], '50.00')).expect(400);
    expect(noRef.body.error.details.issues[0].path).toBe('lines.0.statutory.beneficiary');
    await post(
      s.cashier,
      sale(session.id, [{ variantId: s.cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'x' } }], '50.00', { beneficiaries: [{ ref: 'x', scheme: 'PWD', name: 'A', idNumber: '1' }] }),
    ).expect(400);
    await post(
      s.cashier,
      sale(session.id, [{ variantId: s.cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'x' } }], '50.00', { beneficiaries: [{ ref: 'x', scheme: 'SC', name: ' ', idNumber: '1' }] }),
    ).expect(400);
  });
});

describe('cashier session rules', () => {
  it('one open session per register; sales only on your own open session', async () => {
    const s = await store('rules');
    const session = await openSession(s);
    const second = await http().post('/v1/cashier-sessions').set(s.manager).send({ registerId: s.registerId, openingFloat: '0' }).expect(409);
    expect(second.body.error.code).toBe('SESSION_ALREADY_OPEN');
    const notMine = await post(s.manager, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(403);
    expect(notMine.body.error.code).toBe('NOT_SESSION_OWNER');
    await http().post(`/v1/cashier-sessions/${session.id}/close`).set(s.cashier).send({ countedCash: '1000.00' }).expect(200);
    const closed = await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(409);
    expect(closed.body.error.code).toBe('SESSION_NOT_OPEN');
    await http().post(`/v1/cashier-sessions/${session.id}/movements`).set(s.cashier).send({ type: 'PAY_IN', amount: '1.00', reason: 'x' }).expect(409);
    await openSession(s);
  });

  it('a variance must be approved by someone else with cash.reconcile', async () => {
    const s = await store('variance');
    const session = await openSession(s, s.cashier, '500.00');
    await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '100.00')).expect(201);
    const closed = (await http().post(`/v1/cashier-sessions/${session.id}/close`).set(s.cashier).send({ countedCash: '520.00', note: 'Short' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'CLOSED', reconciliation: { expectedCash: '522.40', countedCash: '520.00', variance: '-2.40', approvedBy: null } });
    await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.cashier).send({ note: 'ok' }).expect(403);
    const approved = (await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.manager).send({ note: 'Coins miscounted' }).expect(200)).body;
    expect(approved).toMatchObject({ status: 'RECONCILED', reconciliation: { approvalNote: 'Coins miscounted' } });
    expect((await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.manager).send({ note: 'again' }).expect(409)).body.error.code).toBe('INVALID_STATE');
  });

  it('the manager who counted a drawer cannot approve their own variance', async () => {
    const s = await store('selfapprove');
    const session = await openSession(s, s.manager, '100.00');
    await http().post(`/v1/cashier-sessions/${session.id}/close`).set(s.manager).send({ countedCash: '90.00' }).expect(200);
    const res = await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.manager).send({ note: 'mine' }).expect(403);
    expect(res.body.error.code).toBe('SELF_APPROVAL');
  });

  it('a cashier scoped to another branch cannot open a session here', async () => {
    const s = await store('scope');
    const le = (await http().get('/v1/legal-entities').set(s.auth)).body.data[0].id;
    const b2 = await http().post('/v1/branches').set(s.auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
    const r2 = await http().post('/v1/registers').set(s.auth).send({ branchId: b2.body.id, code: 'R1', name: 'Other' }).expect(201);
    await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: r2.body.id, openingFloat: '0' }).expect(403);
  });
});

describe('stock ledger', () => {
  it('adjustments need inventory.adjust and a reason; selling past zero goes negative and stays visible', async () => {
    const s = await store('stock');
    await http().post('/v1/stock/adjustments').set(s.cashier).send({ branchId: s.branchId, reason: 'x', items: [{ variantId: s.cola, quantity: '1' }] }).expect(403);
    await http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason: ' ', items: [{ variantId: s.cola, quantity: '1' }] }).expect(400);
    await http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason: 'Count', items: [{ variantId: s.cola, quantity: '1' }] }).expect(201);
    const session = await openSession(s);
    await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '3' }], '100.00')).expect(201);
    const bal = (await http().get('/v1/stock/balances').query({ branchId: s.branchId }).set(s.manager).expect(200)).body.data;
    expect(bal).toMatchObject([{ variantId: s.cola, quantity: '-2' }]);
    const moves = (await http().get('/v1/stock/movements').query({ branchId: s.branchId, variantId: s.cola }).set(s.manager).expect(200)).body.data;
    expect(moves.map((m: { type: string; quantity: string }) => [m.type, m.quantity])).toEqual([['SALE', '-3'], ['ADJUSTMENT', '1']]);
  });

  it('balances and ledgers are evidence: the app cannot write balances, nobody can edit history', async () => {
    const s = await store('immutable');
    const session = await openSession(s);
    await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(201);
    for (const sql of ['UPDATE sales SET amount_due = 0', 'DELETE FROM sale_lines', 'UPDATE stock_movements SET quantity = 5', 'DELETE FROM cash_movements', 'UPDATE sale_tenders SET change = 0']) {
      const err = await asOwnerInTenant(owner, s.t.tenantId, (c) => c.query(sql)).then(() => null, (e: Error) => e.message);
      expect([sql, err]).toEqual([sql, expect.stringMatching(/append-only|not allowed|forbidden/i)]);
    }
    const app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      const c = await app.connect();
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.t.tenantId]);
      const err = await c.query('UPDATE stock_balances SET quantity = 999').then(() => null, (e: { code?: string }) => e.code);
      expect(err).toBe('42501');
      await c.query('ROLLBACK');
      c.release();
    } finally {
      await app.end();
    }
  });
});
