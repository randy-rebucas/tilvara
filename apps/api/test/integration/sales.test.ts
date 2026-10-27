import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevPaymentProvider } from '../../src/payments/provider.js';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  // Short provider timeout so the dev simulator lost-response cases resolve quickly.
  app = await createApp({ PAYMENT_TIMEOUT_MS: 400 });
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
    const { rows: [ct] } = await c.query(`SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS applied FROM sale_tenders WHERE sale_id = $1 AND method = 'CASH'`, [saleId]);
    const { rows: cash } = await c.query(`SELECT amount FROM cash_movements WHERE sale_id = $1`, [saleId]);
    expect(cash.map((r) => Number(r.amount))).toEqual(ct.n ? [Number(ct.applied)] : []);
    const { rows: [el] } = await c.query(
      `SELECT coalesce(sum(t.amount), 0) AS tendered, coalesce(sum(p.amount), 0) AS intents, count(*) FILTER (WHERE p.sale_id = t.sale_id)::int AS stamped, count(t.id)::int AS n
         FROM sale_tenders t LEFT JOIN payment_intents p ON p.id = t.payment_intent_id WHERE t.sale_id = $1 AND t.method IN ('CARD', 'QR', 'EWALLET')`,
      [saleId],
    );
    expect([Number(el.tendered), el.stamped]).toEqual([Number(el.intents), el.n]);
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
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening stock', items: [{ variantId: s.cola, quantity: '24' }] }).expect(201);
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
    const receipt = (await http().get(`/v1/sales/${sc.body.id}/receipt`).set(s.cashier).expect(200)).body;
    expect(receipt).toMatchObject({
      documentType: 'SALES_RECEIPT',
      notice: 'THIS IS NOT AN OFFICIAL INVOICE',
      seller: { tinLabel: 'VAT REG TIN' },
      transaction: { reference: 'R1-000002', register: 'Counter 1' },
      totals: { vatExemptSales: '20.00', vatExemption: '2.40', statutoryDiscount: '4.00', amountDue: '16.00', change: '4.00' },
      statutory: [{ scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001', discount: '4.00', signatureLine: true }],
    });

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
    // The till finds an earlier sale by the number on its receipt (a return after the shift).
    const seventh = res.find((r) => r.body.saleNumber === 7)!.body;
    const found = await http().get('/v1/sales').query({ registerId: s.registerId, saleNumber: 7, limit: 1 }).set(s.cashier).expect(200);
    expect(found.body.data.map((x: { id: string }) => x.id)).toEqual([seventh.id]);
    expect((await http().get('/v1/sales').query({ registerId: s.registerId, saleNumber: 99 }).set(s.cashier).expect(200)).body.data).toEqual([]);
    await http().get('/v1/sales').query({ registerId: s.registerId, saleNumber: 0 }).set(s.cashier).expect(400);
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
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: s.cola, quantity: '5' }] }).expect(201);
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

describe('POS workstations', () => {
  it('lists registers the user may run, with branch and their own open shift; scope limits the list', async () => {
    const s = await store('ws');
    const le = (await http().get('/v1/legal-entities').set(s.auth)).body.data[0].id;
    const b2 = await http().post('/v1/branches').set(s.auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
    await http().post('/v1/registers').set(s.auth).send({ branchId: b2.body.id, code: 'R9', name: 'Other branch' }).expect(201);
    const before = (await http().get('/v1/pos/workstations').set(s.cashier).expect(200)).body.data;
    // Cashier is scoped to branch One: sees only its register, even without org.read.
    expect(before).toMatchObject([{ register: { id: s.registerId, code: 'R1' }, branch: { id: s.branchId }, openSession: null }]);
    const session = await openSession(s);
    const mine = (await http().get('/v1/pos/workstations').set(s.cashier).expect(200)).body.data;
    expect(mine[0].openSession).toMatchObject({ id: session.id, mine: true });
    const managerView = (await http().get('/v1/pos/workstations').set(s.manager).expect(200)).body.data;
    expect(managerView.find((w: { register: { id: string } }) => w.register.id === s.registerId).openSession).toMatchObject({ mine: false });
    const ownerView = (await http().get('/v1/pos/workstations').set(s.auth).expect(200)).body.data;
    expect(ownerView.map((w: { register: { code: string } }) => w.register.code).sort()).toEqual(['R1', 'R9']);
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
    // The manager's list of drawers waiting for approval carries the count (the admin's Drawer counts page).
    const waiting = (await http().get('/v1/cashier-sessions?status=CLOSED').set(s.manager).expect(200)).body.data;
    expect(waiting).toEqual([expect.objectContaining({ id: session.id, reconciliation: expect.objectContaining({ variance: '-2.40', countedCash: '520.00', countedBy: closed.reconciliation.countedBy, approvedBy: null }) })]);
    // Names travel with the shift: an approver with cash.reconcile at one branch may not read /members.
    expect(waiting[0].openedByName).toEqual(expect.any(String));
    expect(waiting[0].reconciliation).toMatchObject({ countedByName: waiting[0].openedByName, approvedByName: null });
    expect(closed.openedByName).toBe(waiting[0].openedByName);
    await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.cashier).send({ note: 'ok' }).expect(403);
    const approved = (await http().post(`/v1/cashier-sessions/${session.id}/approve-variance`).set(s.manager).send({ note: 'Coins miscounted' }).expect(200)).body;
    expect(approved).toMatchObject({ status: 'RECONCILED', reconciliation: { approvalNote: 'Coins miscounted', approvedByName: expect.any(String) } });
    expect(approved.reconciliation.approvedByName).not.toBe(approved.reconciliation.countedByName);
    expect((await http().get('/v1/cashier-sessions?status=CLOSED').set(s.manager).expect(200)).body.data).toEqual([]);
    const done = (await http().get('/v1/cashier-sessions?status=RECONCILED').set(s.manager).expect(200)).body.data;
    expect(done.find((x: { id: string }) => x.id === session.id).reconciliation).toMatchObject({ approvalNote: 'Coins miscounted', variance: '-2.40' });
    // An open shift has no count yet.
    expect((await http().get('/v1/cashier-sessions?status=OPEN').set(s.manager).expect(200)).body.data.every((x: { reconciliation: unknown }) => x.reconciliation === null)).toBe(true);
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
  it('adjustments need inventory.adjust, a reason and an Idempotency-Key; selling past zero goes negative and stays visible', async () => {
    const s = await store('stock');
    const keyless = await http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason: 'Count', items: [{ variantId: s.cola, quantity: '1' }] }).expect(400);
    expect(keyless.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await http().post('/v1/stock/adjustments').set(s.cashier).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'x', items: [{ variantId: s.cola, quantity: '1' }] }).expect(403);
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: ' ', items: [{ variantId: s.cola, quantity: '1' }] }).expect(400);
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Count', items: [{ variantId: s.cola, quantity: '1' }] }).expect(201);
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

describe('non-cash payments (ADR-0010)', () => {
  const intent = (auth: Auth, body: Record<string, unknown>, key = randomUUID()) =>
    http().post('/v1/payment-intents').set(auth).set('Idempotency-Key', key).send(body);

  it('card + cash split: the intent is applied first, cash covers the rest with change, and the intent is consumed once', async () => {
    const s = await store('pay-split');
    const session = await openSession(s);
    const clientTransactionId = randomUUID();
    const card = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId, method: 'CARD', amount: '30.00' }).expect(201);
    expect(card.body).toMatchObject({ status: 'SUCCEEDED', amount: '30.00', saleId: null, providerReference: expect.stringMatching(/^dev_/) });
    const body = {
      cashierSessionId: session.id,
      clientTransactionId,
      lines: [{ variantId: s.cola, quantity: '2' }],
      tenders: [{ method: 'INTENT', paymentIntentId: card.body.id }, { method: 'CASH', tendered: '20.00' }],
    };
    const res = await post(s.cashier, body).expect(201);
    expect(res.body).toMatchObject({ amountDue: '44.80', amountTendered: '50.00', changeDue: '5.20' });
    expect(res.body.tenders.map((t: { method: string; amount: string; change: string }) => [t.method, t.amount, t.change])).toEqual([
      ['CARD', '30.00', '0.00'],
      ['CASH', '14.80', '5.20'],
    ]);
    await assertReconciles(s, res.body.id);
    const after = (await http().get(`/v1/payment-intents/${card.body.id}`).set(s.cashier).expect(200)).body;
    expect(after.saleId).toBe(res.body.id);
    expect(after.events.map((e: { type: string }) => e.type)).toEqual(['AUTHORIZE_REQUESTED', 'AUTHORIZED', 'CONSUMED']);
    const reuse = await post(s.cashier, { ...body, clientTransactionId: randomUUID() }).expect(409);
    expect(reuse.body.error.code).toBe('PAYMENT_CONSUMED');
    await http().post(`/v1/payment-intents/${card.body.id}/cancel`).set(s.cashier).expect(409);
  });

  it('a fully card-paid sale moves no cash', async () => {
    const s = await store('pay-card');
    const session = await openSession(s);
    const clientTransactionId = randomUUID();
    const qr = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId, method: 'QR', amount: '22.40' }).expect(201);
    const res = await post(s.cashier, {
      cashierSessionId: session.id,
      clientTransactionId,
      lines: [{ variantId: s.cola, quantity: '1' }],
      tenders: [{ method: 'INTENT', paymentIntentId: qr.body.id }],
    }).expect(201);
    await assertReconciles(s, res.body.id);
    expect(await count(s, `SELECT count(*) AS n FROM cash_movements WHERE sale_id = $1`, [res.body.id])).toBe(0);
    expect((await http().get(`/v1/cashier-sessions/${session.id}`).set(s.cashier).expect(200)).body.expectedCash).toBe('1000.00');
  });

  it('a retried intent request returns the same intent and never charges twice', async () => {
    const s = await store('pay-retry');
    const session = await openSession(s);
    const body = { cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '10.00' };
    const key = randomUUID();
    const a = await intent(s.cashier, body, key).expect(201);
    const b = await intent(s.cashier, body, key).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(app.get(DevPaymentProvider).chargeCount(a.body.id)).toBe(1);
    const other = await intent(s.cashier, { ...body, amount: '11.00' }, key).expect(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('declines are recorded and cannot pay for a sale', async () => {
    const s = await store('pay-decline');
    const session = await openSession(s);
    const clientTransactionId = randomUUID();
    const d = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId, method: 'CARD', amount: '22.51' }).expect(201);
    expect(d.body).toMatchObject({ status: 'FAILED', failureCode: 'card_declined' });
    const res = await post(s.cashier, {
      cashierSessionId: session.id,
      clientTransactionId,
      lines: [{ variantId: s.cola, quantity: '1' }],
      tenders: [{ method: 'INTENT', paymentIntentId: d.body.id }],
    }).expect(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
  });

  it('a lost provider response becomes UNKNOWN; reconcile finds the charge instead of charging again', async () => {
    const s = await store('pay-lost');
    const session = await openSession(s);
    const p = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '22.52' }).expect(201);
    expect(p.body.status).toBe('UNKNOWN');
    const r = await http().post(`/v1/payment-intents/${p.body.id}/reconcile`).set(s.cashier).expect(200);
    expect(r.body.status).toBe('SUCCEEDED');
    expect(app.get(DevPaymentProvider).chargeCount(p.body.id)).toBe(1);
    const events = (await http().get(`/v1/payment-intents/${p.body.id}`).set(s.cashier)).body.events.map((e: { type: string }) => e.type);
    expect(events).toEqual(['AUTHORIZE_REQUESTED', 'TIMEOUT', 'RECONCILED']);
  });

  it('a request the provider never received reconciles to FAILED', async () => {
    const s = await store('pay-never');
    const session = await openSession(s);
    const p = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'EWALLET', amount: '22.53' }).expect(201);
    expect(p.body.status).toBe('UNKNOWN');
    const r = await http().post(`/v1/payment-intents/${p.body.id}/reconcile`).set(s.cashier).expect(200);
    expect(r.body).toMatchObject({ status: 'FAILED', failureCode: 'not_received_by_provider' });
  });

  it('an unused authorized payment can be cancelled (voided at the provider), then cannot be used', async () => {
    const s = await store('pay-cancel');
    const session = await openSession(s);
    const clientTransactionId = randomUUID();
    const p = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId, method: 'CARD', amount: '22.40' }).expect(201);
    expect((await http().post(`/v1/payment-intents/${p.body.id}/cancel`).set(s.cashier).expect(200)).body.status).toBe('CANCELED');
    await post(s.cashier, {
      cashierSessionId: session.id,
      clientTransactionId,
      lines: [{ variantId: s.cola, quantity: '1' }],
      tenders: [{ method: 'INTENT', paymentIntentId: p.body.id }],
    }).expect(409);
  });

  it('refuses intents from another checkout, overpayment and double tendering — and records nothing', async () => {
    const s = await store('pay-guard');
    const session = await openSession(s);
    const ctx = randomUUID();
    const big = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId: ctx, method: 'CARD', amount: '100.00' }).expect(201);
    const other = await intent(s.cashier, { cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '5.00' }).expect(201);
    const sell = (tenders: unknown[]) =>
      post(s.cashier, { cashierSessionId: session.id, clientTransactionId: ctx, lines: [{ variantId: s.cola, quantity: '1' }], tenders });
    expect((await sell([{ method: 'INTENT', paymentIntentId: big.body.id }])).body.error.code).toBe('OVERPAYMENT');
    expect((await sell([{ method: 'INTENT', paymentIntentId: other.body.id }, { method: 'CASH', tendered: '50.00' }])).body.error.code).toBe('PAYMENT_MISMATCH');
    expect((await sell([{ method: 'INTENT', paymentIntentId: big.body.id }, { method: 'INTENT', paymentIntentId: big.body.id }])).body.error.code).toBe('DUPLICATE_TENDER');
    expect(await count(s, `SELECT count(*) AS n FROM sales`)).toBe(0);
  });

  it('only the session owner takes payments on it, and the Idempotency-Key is required', async () => {
    const s = await store('pay-owner');
    const session = await openSession(s);
    const res = await intent(s.manager, { cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '1.00' }).expect(403);
    expect(res.body.error.code).toBe('NOT_SESSION_OWNER');
    await http()
      .post('/v1/payment-intents')
      .set(s.cashier)
      .send({ cashierSessionId: session.id, clientTransactionId: randomUUID(), method: 'CARD', amount: '1.00' })
      .expect(400);
  });
});

describe('voids and returns (ADR-0011)', () => {
  const ret = (auth: Auth, saleId: string, body: Record<string, unknown>, key = randomUUID()) =>
    http().post(`/v1/sales/${saleId}/returns`).set(auth).set('Idempotency-Key', key).send(body);
  const balance = async (s: Store, variantId: string) =>
    (await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.manager).expect(200)).body.data[0]?.quantity;

  it('three partial returns of an uneven line add up exactly to the sale, restock and refund from the drawer', async () => {
    const s = await store('ret-exact');
    const vat = ((await http().get('/v1/tax-categories').set(s.auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const pc = ((await http().get('/v1/uoms').set(s.auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const created = await http()
      .post('/v1/products')
      .set(s.auth)
      .send({ name: 'Pancit Canton', taxCategoryId: vat, uomId: pc, variants: [{ sku: uniq('PC'), price: '16.50' }] })
      .expect(201);
    const noodles = created.body.variants[0].id as string;
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: noodles, quantity: '10' }] }).expect(201);
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: noodles, quantity: '3' }], '50.00')).expect(201)).body;
    expect(sold).toMatchObject({ amountDue: '49.50', vatableSales: '44.20', vatAmount: '5.30' });
    const lineId = sold.lines[0].id;
    const returns = [];
    for (let i = 0; i < 3; i++) {
      returns.push((await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'Expired', lines: [{ saleLineId: lineId, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body);
    }
    expect(returns.map((r) => [r.returnNumber, r.vatableSales, r.vatAmount, r.amountDue])).toEqual([
      [1, '14.73', '1.77', '16.50'],
      [2, '14.73', '1.77', '16.50'],
      [3, '14.74', '1.76', '16.50'],
    ]);
    const over = await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: [{ saleLineId: lineId, quantity: '1', disposition: 'RESTOCK' }] }).expect(422);
    expect(over.body.error).toMatchObject({ code: 'RETURN_EXCEEDS_SOLD', details: { remaining: '0' } });
    expect(await balance(s, noodles)).toBe('10');
    expect(await count(s, `SELECT sum(amount) AS n FROM cash_movements WHERE type = 'REFUND'`)).toBe(-49.5);
    expect((await http().get(`/v1/cashier-sessions/${session.id}`).set(s.cashier)).body.expectedCash).toBe('1000.00');
    expect((await http().get(`/v1/sales/${sold.id}`).set(s.cashier)).body.lines[0].returnedQuantity).toBe('3');
    expect((await http().get(`/v1/sales/${sold.id}/returns`).set(s.cashier).expect(200)).body.data).toHaveLength(3);
    // The slip handed over with the third refund: against sale R1-000001, its own buckets, refunded in cash.
    const slip = (await http().get(`/v1/sale-returns/${returns[2].id}/receipt`).set(s.cashier).expect(200)).body;
    expect(slip).toMatchObject({
      documentType: 'RETURN_SLIP',
      notice: 'RETURN / REFUND — NOT AN OFFICIAL INVOICE',
      transaction: { reference: 'RETURN 3 of R1-000001' },
      lines: [{ name: 'Pancit Canton', quantity: '1', amount: '16.50', flag: 'V' }],
      totals: { vatableSales: '14.74', vatAmount: '1.76', refund: '16.50' },
      tenders: [{ method: 'CASH', amount: '16.50' }],
      reason: 'Expired',
    });
  });

  it('damaged goods are refunded, not restocked, and written off as waste (cost leaves COGS for Spoilage)', async () => {
    const s = await store('ret-damaged');
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: s.cola, quantity: '5', unitCost: '12.00' }] }).expect(201);
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }], '50.00')).expect(201)).body;
    const r = (await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'Dented can', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201)).body;
    expect(await balance(s, s.cola)).toBe('3');
    const moves = await asOwnerInTenant(owner, s.t.tenantId, async (c) =>
      (await c.query(`SELECT type, quantity::text AS q, value::text AS v FROM stock_movements WHERE variant_id = $1 AND type IN ('RETURN', 'WASTE') ORDER BY created_at, type`, [s.cola])).rows);
    expect(moves.map((m) => [m.type, Number(m.q)])).toEqual([['RETURN', 1], ['WASTE', -1]]);
    const glBy = (key: string) => asOwnerInTenant(owner, s.t.tenantId, async (c) =>
      Number((await c.query(`SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = $1`, [key])).rows[0].v));
    expect(await glBy('INVENTORY_WASTE')).toBe(12);
    expect(await glBy('COGS')).toBe(12);
    const [audit] = await asOwnerInTenant(owner, s.t.tenantId, async (c) => (await c.query(`SELECT metadata FROM audit_logs WHERE action = 'sale.returned' AND metadata->>'saleReturnId' = $1`, [r.id])).rows);
    expect(audit.metadata.wasteAdjustmentId).toEqual(expect.any(String));
  });

  it('what the sale took from stock decides what comes back, not whether the item is tracked now', async () => {
    const s = await store('ret-track-flip');
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: s.cola, quantity: '5', unitCost: '12.00' }] }).expect(201);
    const productOf = (variantId: string) => asOwnerInTenant(owner, s.t.tenantId, async (c) => (await c.query(`SELECT product_id FROM product_variants WHERE id = $1`, [variantId])).rows[0].product_id as string);
    const cola = await productOf(s.cola);
    const session = await openSession(s);
    const tracked = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }], '50.00')).expect(201)).body;
    // Sold while tracked, returned after tracking was switched off: the units still come back. Tracking
    // is switched off only once the shelf is empty (audit 2026-10-27 #9), so the 3 left are written off first.
    expect((await http().patch(`/v1/products/${cola}`).set(s.auth).send({ trackInventory: false }).expect(409)).body.error.code).toBe('HAS_STOCK');
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, kind: 'WASTE', reason: 'Damaged', items: [{ variantId: s.cola, quantity: '-3' }] }).expect(201);
    expect(await balance(s, s.cola)).toBe('0');
    await http().patch(`/v1/products/${cola}`).set(s.auth).send({ trackInventory: false }).expect(200);
    await ret(s.manager, tracked.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'Wrong size', lines: [{ saleLineId: tracked.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    expect(await balance(s, s.cola)).toBe('1');
    // Sold while untracked, returned after tracking was switched on: nothing left stock, nothing comes back.
    const untracked = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(201)).body;
    expect(await balance(s, s.cola)).toBe('1');
    await http().patch(`/v1/products/${cola}`).set(s.auth).send({ trackInventory: true }).expect(200);
    await ret(s.manager, untracked.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'Wrong size', lines: [{ saleLineId: untracked.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    expect(await balance(s, s.cola)).toBe('1');
  });

  it('a whole-unit item comes back in whole units', async () => {
    const s = await store('ret-whole');
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }], '50.00')).expect(201)).body;
    const half = await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: [{ saleLineId: sold.lines[0].id, quantity: '0.5', disposition: 'RESTOCK' }] }).expect(422);
    expect(half.body.error.code).toBe('QUANTITY_NOT_ALLOWED');
    await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
  });

  it('returning an SC line refunds what the beneficiary paid (discount and VAT exemption carried over)', async () => {
    const s = await store('ret-sc');
    const session = await openSession(s);
    const sold = (await post(
      s.cashier,
      sale(session.id, [{ variantId: s.cola, quantity: '2', statutory: { scheme: 'SC', beneficiary: 'lolo' } }], '50.00', {
        beneficiaries: [{ ref: 'lolo', scheme: 'SC', name: 'Jose Rizal', idNumber: 'OSCA-1861' }],
      }),
    ).expect(201)).body;
    expect(sold.amountDue).toBe('32.00');
    const r = (await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'Wrong flavour', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }], expectedRefund: '16.00' }).expect(201)).body;
    expect(r).toMatchObject({ amountDue: '16.00', vatExemptSales: '20.00', statutoryDiscount: '4.00', vatAmount: '0.00' });
  });

  it('a void reverses the whole sale in its own session, once', async () => {
    const s = await store('ret-void');
    await http().post('/v1/stock/adjustments').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Opening', items: [{ variantId: s.cola, quantity: '5' }] }).expect(201);
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '2' }, { variantId: s.wrap, quantity: '1' }], '100.00')).expect(201)).body;
    const v = (await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'VOID', reason: 'Customer left' }).expect(201)).body;
    expect(v).toMatchObject({ kind: 'VOID', amountDue: sold.amountDue, gross: sold.gross });
    expect(v.lines).toHaveLength(2);
    expect(await balance(s, s.cola)).toBe('5');
    expect((await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'VOID', reason: 'again' }).expect(409)).body.error.code).toBe('ALREADY_RETURNED');

    const other = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(201)).body;
    // The shift's sale list says how each was paid and that the first was voided (the POS tags them).
    const listed = (await http().get('/v1/sales').query({ cashierSessionId: session.id }).set(s.cashier).expect(200)).body.data as { id: string; tenderMethods: string[]; voided: boolean; returnCount: number }[];
    expect(listed.find((x) => x.id === sold.id)).toMatchObject({ tenderMethods: ['CASH'], voided: true, returnCount: 1 });
    expect(listed.find((x) => x.id === other.id)).toMatchObject({ tenderMethods: ['CASH'], voided: false, returnCount: 0 });
    await http().post(`/v1/cashier-sessions/${session.id}/close`).set(s.cashier).send({ countedCash: '1022.40' }).expect(200);
    const next = await openSession(s);
    const late = await ret(s.manager, other.id, { cashierSessionId: next.id, kind: 'VOID', reason: 'too late' }).expect(422);
    expect(late.body.error.code).toBe('VOID_OUTSIDE_SESSION');
  });

  it('cashiers need a manager; refunds need cash in the drawer; the refund the cashier saw must match', async () => {
    const s = await store('ret-rules');
    const session = await openSession(s, s.cashier, '0');
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '22.40')).expect(201)).body;
    const line = [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }];
    await ret(s.cashier, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: line }).expect(403);
    await ret(s.cashier, sold.id, { cashierSessionId: session.id, kind: 'VOID', reason: 'x' }).expect(403);
    expect((await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: line, expectedRefund: '20.00' }).expect(409)).body.error).toMatchObject({ code: 'REFUND_CHANGED', details: { refund: '22.40' } });
    await http().post(`/v1/cashier-sessions/${session.id}/movements`).set(s.cashier).send({ type: 'PAY_OUT', amount: '10.00', reason: 'Supplies' }).expect(201);
    const short = await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'RETURN', reason: 'x', lines: line }).expect(422);
    expect(short.body.error).toMatchObject({ code: 'INSUFFICIENT_DRAWER_CASH', details: { available: '12.40' } });
    expect(await count(s, `SELECT count(*) AS n FROM sale_returns`)).toBe(0);
  });

  it('concurrent returns of the last unit: exactly one succeeds; a retried return is replayed', async () => {
    const s = await store('ret-race');
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(201)).body;
    const body = { cashierSessionId: session.id, kind: 'RETURN', reason: 'race', lines: [{ saleLineId: sold.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] };
    const res = await Promise.all(Array.from({ length: 4 }, () => ret(s.manager, sold.id, body)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
    const winner = res.find((r) => r.status === 201)!;
    const key = randomUUID();
    const s2 = await store('ret-replay');
    const sess2 = await openSession(s2);
    const sold2 = (await post(s2.cashier, sale(sess2.id, [{ variantId: s2.cola, quantity: '1' }], '50.00')).expect(201)).body;
    const body2 = { cashierSessionId: sess2.id, kind: 'VOID', reason: 'retry' };
    const a = await ret(s2.manager, sold2.id, body2, key).expect(201);
    const b = await ret(s2.manager, sold2.id, body2, key).expect(201);
    expect([b.body.id, b.headers['idempotent-replayed']]).toEqual([a.body.id, 'true']);
    expect(winner.body.returnNumber).toBe(1);
  });

  it('return documents are evidence: never edited or deleted', async () => {
    const s = await store('ret-immut');
    const session = await openSession(s);
    const sold = (await post(s.cashier, sale(session.id, [{ variantId: s.cola, quantity: '1' }], '50.00')).expect(201)).body;
    await ret(s.manager, sold.id, { cashierSessionId: session.id, kind: 'VOID', reason: 'x' }).expect(201);
    for (const q of ['UPDATE sale_returns SET reason = \'edited\'', 'DELETE FROM sale_return_lines']) {
      const err = await asOwnerInTenant(owner, s.t.tenantId, (c) => c.query(q)).then(() => null, (e: Error) => e.message);
      expect(err).toMatch(/append-only|not allowed|forbidden/i);
    }
  });
});

describe('sale list paging', () => {
  it('a member who reads only part of the sales pages through all of them, each once, in order', async () => {
    const s = await store('list-page');
    const r2 = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
    // A cashier who may read only register R1's sales; the branch cashier sells on R2 in between.
    const a = await addMember(owner, s.t.tenantId, 'cashier', { type: 'REGISTER', id: s.registerId });
    const onR1 = bearer(await loginToken(app, a.email));
    const [r1Session, r2Session] = [await openSession(s, onR1), await openSession(s, s.cashier, '1000.00', r2)];
    const ring = async (on: 'R1' | 'R2') => {
      const res = on === 'R1'
        ? await post(onR1, sale(r1Session.id, [{ variantId: s.wrap, quantity: '1' }], '15.00'))
        : await post(s.cashier, sale(r2Session.id, [{ variantId: s.wrap, quantity: '1' }], '15.00'));
      // A cashier granted only register R1 sells there (audit 2026-10-21: pricing used to need the branch).
      expect([on, res.status, res.body.error?.code]).toEqual([on, 201, undefined]);
    };
    for (const on of ['R1', 'R1', 'R1', 'R2', 'R1', 'R2', 'R2', 'R2', 'R1', 'R1', 'R2'] as const) await ring(on);
    const expected = (await asOwnerInTenant(owner, s.t.tenantId, (c) => c.query<{ id: string }>(`SELECT id FROM sales WHERE register_id = $1 ORDER BY id DESC`, [s.registerId]))).rows.map((r) => r.id);
    expect(expected).toHaveLength(6);

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 10; i++) {
      const page = (await http().get('/v1/sales').query({ limit: 2, ...(cursor && { cursor }) }).set(onR1).expect(200)).body as { data: { id: string }[]; nextCursor: string | null };
      seen.push(...page.data.map((x) => x.id));
      sizes.push(page.data.length);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(expected); // none repeated, none skipped, newest first
    expect(sizes.slice(0, -1).every((n) => n === 2)).toBe(true); // full pages until the end
    // Someone who reads the whole branch pages through all eleven.
    const all: string[] = [];
    cursor = undefined;
    for (let i = 0; i < 10; i++) {
      const page = (await http().get('/v1/sales').query({ limit: 4, ...(cursor && { cursor }) }).set(s.manager).expect(200)).body as { data: { id: string }[]; nextCursor: string | null };
      all.push(...page.data.map((x) => x.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(all).toHaveLength(11);
    expect(new Set(all).size).toBe(11);
  });
});
