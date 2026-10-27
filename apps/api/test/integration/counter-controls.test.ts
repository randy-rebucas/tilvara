import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, stepAt } from '../../src/auth/totp.js';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, PASSWORD, signup, uniq, type SignedUp } from './helpers.js';

/** Counter controls (session 20): line discounts, manager-approved prices, held carts and exchanges. */
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
  register2Id: string;
  cola: string;
  rice: string;
  cashier: Auth;
  cashierEmail: string;
  cashierId: string;
  cashier2: Auth;
  cashier2Email: string;
  manager: Auth;
  managerEmail: string;
  managerId: string;
}

async function store(prefix: string): Promise<Store> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const reg2 = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R2', name: 'Counter 2' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (body: Record<string, unknown>, price: string) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: taxes.VAT, ...body, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cola = await product({ name: 'Cola 290ml' }, '22.40');
  const rice = await product({ name: 'Rice 1kg', taxCategoryId: taxes.VAT_EXEMPT }, '56.00');
  const scope = { type: 'BRANCH' as const, id: br.body.id };
  const c = await addMember(owner, t.tenantId, 'cashier', scope);
  const c2 = await addMember(owner, t.tenantId, 'cashier', scope);
  const m = await addMember(owner, t.tenantId, 'branch_manager', scope);
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID())
    .send({ branchId: br.body.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '50', unitCost: '12.00' }, { variantId: rice, quantity: '50', unitCost: '40.00' }] }).expect(201);
  return {
    t, auth, branchId: br.body.id, registerId: reg.body.id, register2Id: reg2.body.id, cola, rice,
    cashier: bearer(await loginToken(app, c.email)), cashierEmail: c.email, cashierId: c.userId,
    cashier2: bearer(await loginToken(app, c2.email)), cashier2Email: c2.email,
    manager: bearer(await loginToken(app, m.email)), managerEmail: m.email, managerId: m.userId,
  };
}

const openSession = async (auth: Auth, registerId: string, openingFloat = '1000.00') =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat }).expect(201)).body.id as string;

const sell = (auth: Auth, body: object, key = randomUUID()) => http().post('/v1/sales').set(auth).set('Idempotency-Key', key).send(body);
const quote = (auth: Auth, branchId: string, lines: object[]) => http().post('/v1/tax/quote').set(auth).send({ branchId, lines });

async function q<T extends pg.QueryResultRow>(s: Store, sql: string, params: unknown[] = []): Promise<T[]> {
  return asOwnerInTenant(owner, s.t.tenantId, async (c) => (await c.query<T>(sql, params)).rows);
}
const drawer = async (s: Store, sessionId: string) => Number((await q<{ v: string }>(s, `SELECT coalesce(sum(amount), 0) AS v FROM cash_movements WHERE cashier_session_id = $1`, [sessionId]))[0]!.v);

describe('line discounts at the counter', () => {
  it('a rate or an amount, only with sales.discount, computed and recorded by the server', async () => {
    const s = await store('disc');
    const refused = await quote(s.cashier, s.branchId, [{ variantId: s.cola, quantity: '2', discountRate: '0.1' }]).expect(403);
    expect(refused.body.error.details.missing).toEqual(['sales.discount']);
    await quote(s.manager, s.branchId, [{ variantId: s.cola, quantity: '1', discount: '1.00', discountRate: '0.1' }]).expect(400);

    const session = await openSession(s.manager, s.registerId);
    // 10 % of 2 × ₱22.40 = ₱4.48; the rice line takes ₱6.00 off.
    const lines = [{ id: 'a', variantId: s.cola, quantity: '2', discountRate: '0.1' }, { id: 'b', variantId: s.rice, quantity: '1', discount: '6.00' }];
    const shown = (await quote(s.manager, s.branchId, lines).expect(200)).body;
    expect(shown.lines.map((l: { discount: string; amountDue: string }) => [l.discount, l.amountDue])).toEqual([['4.48', '40.32'], ['6.00', '50.00']]);
    const sale = await sell(s.manager, { cashierSessionId: session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '100.00' }], expectedAmountDue: shown.totals.amountDue }).expect(201);
    expect(sale.body).toMatchObject({ discount: '10.48', amountDue: '90.32', changeDue: '9.68' });
  });
});

describe('manager-approved price changes', () => {
  let s: Store;
  let session: string;
  beforeAll(async () => {
    s = await store('override');
    session = await openSession(s.cashier, s.registerId);
  });

  const ask = (auth: Auth, body: Record<string, unknown>) => http().post('/v1/price-overrides').set(auth).send({ branchId: s.branchId, variantId: s.cola, unitPrice: '20.00', quantity: '1', reason: 'Dented can', ...body });

  it('needs the permission or a manager who signs in on the spot; refusals are audited', async () => {
    expect((await ask(s.cashier, {}).expect(403)).body.error.code).toBe('APPROVAL_REQUIRED');
    // A wrong password is a 403 (the cashier stays signed in) and counts towards the manager's lockout.
    expect((await ask(s.cashier, { email: s.managerEmail, password: 'not the password' }).expect(403)).body.error.code).toBe('APPROVER_INVALID_CREDENTIALS');
    expect((await ask(s.cashier, { email: `${uniq('nobody')}@example.ph`, password: PASSWORD }).expect(403)).body.error.code).toBe('APPROVER_INVALID_CREDENTIALS');
    // Session 40: another business's owner, with their right password, is answered like an unknown email.
    const outsider = await signup(app, 'approver-out');
    expect((await ask(s.cashier, { email: outsider.email, password: PASSWORD }).expect(403)).body.error.code).toBe('APPROVER_INVALID_CREDENTIALS');
    // Another cashier's own password is right, but they may not approve prices.
    expect((await ask(s.cashier, { email: s.cashier2Email, password: PASSWORD }).expect(403)).body.error.code).toBe('APPROVER_NOT_ALLOWED');
    await ask(s.cashier, { email: s.managerEmail }).expect(400);
    expect((await ask(s.manager, { unitPrice: '22.40' }).expect(422)).body.error.code).toBe('PRICE_UNCHANGED');

    const refusedRows = await q<{ metadata: { code: string } }>(s, `SELECT metadata FROM audit_logs WHERE action = 'sale.price_override_refused' ORDER BY occurred_at`);
    expect(refusedRows.map((r) => r.metadata.code)).toEqual(['APPROVER_INVALID_CREDENTIALS', 'APPROVER_INVALID_CREDENTIALS', 'APPROVER_INVALID_CREDENTIALS', 'APPROVER_NOT_ALLOWED']);
    const [locked] = await asOwnerInTenant(owner, s.t.tenantId, async (c) => {
      await c.query('SET LOCAL ROLE onepos_platform');
      return (await c.query<{ n: number }>(`SELECT failed_login_count AS n FROM users WHERE id = $1`, [s.managerId])).rows;
    });
    expect(locked!.n).toBeGreaterThanOrEqual(1);
    // …and the outsider's account was never tried, so nothing counts towards their lockout.
    const [untouched] = await asOwnerInTenant(owner, s.t.tenantId, async (c) => {
      await c.query('SET LOCAL ROLE onepos_platform');
      return (await c.query<{ n: number }>(`SELECT failed_login_count AS n FROM users WHERE id = $1`, [outsider.userId])).rows;
    });
    expect(untouched!.n).toBe(0);
  });

  it('prices one line of one sale by the cashier who asked, at the approved price', async () => {
    const approved = (await ask(s.cashier, { email: s.managerEmail, password: PASSWORD, quantity: '2' }).expect(201)).body;
    expect(approved).toMatchObject({ approvalMethod: 'CREDENTIALS', approvedBy: s.managerId, listUnitPrice: '22.4', unitPrice: '20', quantity: '2', requestedBy: s.cashierId });

    const line = { id: 'x', variantId: s.cola, quantity: '2', priceOverrideId: approved.id };
    // The approval is for 2: a third one at that price needs another approval.
    const more = (await quote(s.cashier, s.branchId, [{ ...line, quantity: '3' }]).expect(422)).body.error;
    expect(more).toMatchObject({ code: 'PRICE_OVERRIDE_QUANTITY', details: { approvedQuantity: '2' } });
    const shown = (await quote(s.cashier, s.branchId, [line]).expect(200)).body;
    expect(shown.lines[0]).toMatchObject({ unitPrice: '20', gross: '40.00', amountDue: '40.00', priceOverrideId: approved.id, listUnitPrice: '22.4' });
    // Someone else's approval, another item, the same approval twice in one cart.
    // A held cart resumed by another cashier lands here: the message says to ask again (audit 2026-10-21).
    expect((await quote(s.cashier2, s.branchId, [line]).expect(422)).body.error).toMatchObject({
      code: 'PRICE_OVERRIDE_MISMATCH', message: expect.stringMatching(/cashier who asked.*ask for the approval again/), details: { reason: 'OTHER_CASHIER' },
    });
    expect((await quote(s.cashier, s.branchId, [{ ...line, variantId: s.rice }]).expect(422)).body.error.code).toBe('PRICE_OVERRIDE_MISMATCH');
    expect((await quote(s.cashier, s.branchId, [line, { ...line, id: 'y' }]).expect(422)).body.error.code).toBe('PRICE_OVERRIDE_REPEATED');

    const sale = await sell(s.cashier, { cashierSessionId: session, clientTransactionId: randomUUID(), lines: [line], tenders: [{ method: 'CASH', tendered: '40.00' }], expectedAmountDue: '40.00' }).expect(201);
    expect(sale.body.lines[0]).toMatchObject({ unitPrice: '20', priceOverrideId: approved.id, amountDue: '40.00' });
    const again = await sell(s.cashier, { cashierSessionId: session, clientTransactionId: randomUUID(), lines: [line], tenders: [{ method: 'CASH', tendered: '40.00' }] }).expect(409);
    expect(again.body.error.code).toBe('PRICE_OVERRIDE_USED');
    expect((await q(s, `SELECT 1 FROM audit_logs WHERE action = 'sale.price_override_approved' AND resource_id = $1`, [approved.id])).length).toBe(1);
  });

  it('a manager on their own shift approves themself; an expired approval is refused', async () => {
    const own = (await ask(s.manager, { unitPrice: '25.00', reason: 'Last one, chilled' }).expect(201)).body;
    expect(own).toMatchObject({ approvalMethod: 'SELF', approvedBy: s.managerId });

    const [old] = await q<{ id: string }>(s, `
      INSERT INTO price_overrides (tenant_id, branch_id, variant_id, price_id, list_unit_price, unit_price, reason, requested_by, approved_by, approval_method, created_at, expires_at)
      SELECT tenant_id, branch_id, variant_id, price_id, list_unit_price, 19, reason, requested_by, approved_by, approval_method, now() - interval '2 hours', now() - interval '90 minutes'
        FROM price_overrides WHERE id = $1 RETURNING id`, [own.id]);
    expect((await quote(s.manager, s.branchId, [{ variantId: s.cola, quantity: '1', priceOverrideId: old!.id }]).expect(422)).body.error.code).toBe('PRICE_OVERRIDE_EXPIRED');
  });

  it('an approver who uses two-step sign-in gives their code too', async () => {
    const started = await http().post('/v1/auth/mfa/enroll').set(s.auth).send({ password: PASSWORD }).expect(200);
    const secret = base32Decode(started.body.secret);
    await http().post('/v1/auth/mfa/confirm').set(s.auth).send({ code: hotp(secret, stepAt(Date.now() / 1000)) }).expect(200);
    expect((await ask(s.cashier, { email: s.t.email, password: PASSWORD }).expect(403)).body.error.code).toBe('APPROVER_CODE_REQUIRED');
    expect((await ask(s.cashier, { email: s.t.email, password: PASSWORD, code: '000000' }).expect(403)).body.error.code).toBe('APPROVER_INVALID_CODE');
    const ok = await ask(s.cashier, { email: s.t.email, password: PASSWORD, code: hotp(secret, stepAt(Date.now() / 1000) + 1) }).expect(201);
    expect(ok.body).toMatchObject({ approvalMethod: 'CREDENTIALS', approvedBy: s.t.userId });
  });

  it('the database refuses a sale line that does not match its approval', async () => {
    const approved = (await ask(s.manager, { unitPrice: '18.00' }).expect(201)).body;
    const err = await q(s, `
      INSERT INTO sale_lines (tenant_id, sale_id, line_no, client_line_id, variant_id, sku, name, tax_category_code, vat_treatment, quantity, unit_price,
                              price_includes_tax, price_id, price_list_id, gross, discount, statutory_discount, vat_exemption_amount, vatable_sales, vat_amount,
                              vat_exempt_sales, zero_rated_sales, percentage_tax_sales, amount_due, tax_snapshot, price_override_id)
      SELECT tenant_id, sale_id, 99, 'forged', variant_id, sku, name, tax_category_code, vat_treatment, quantity, 17.00,
             price_includes_tax, price_id, price_list_id, gross, discount, statutory_discount, vat_exemption_amount, vatable_sales, vat_amount,
             vat_exempt_sales, zero_rated_sales, percentage_tax_sales, amount_due, tax_snapshot, $1
        FROM sale_lines LIMIT 1`, [approved.id]).catch((e: Error) => e);
    expect(String(err)).toMatch(/does not match/);
  });
});

describe('held carts', () => {
  it('park a cart, serve the next customer, resume it once at the same register; the cart then forgets its lines', async () => {
    const s = await store('hold');
    const session = await openSession(s.manager, s.registerId);
    const cart = {
      cashierSessionId: session,
      label: 'Lady in blue',
      lines: [
        { id: 'l1', variantId: s.cola, sku: 'COLA', name: 'Cola 290ml', quantity: '3', discountRate: '0.1' },
        { id: 'l2', variantId: s.rice, sku: 'RICE', name: 'Rice 1kg', quantity: '1', statutory: { scheme: 'SC', beneficiary: 'b1' } },
      ],
      beneficiaries: [{ ref: 'b1', scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }],
      amountDue: '105.28',
    };
    // A cashier holds carts on their own shift only.
    await http().post('/v1/held-carts').set(s.cashier).send(cart).expect(403);
    const held = (await http().post('/v1/held-carts').set(s.manager).send(cart).expect(201)).body;
    const second = (await http().post('/v1/held-carts').set(s.manager).send({ ...cart, label: 'Man with a hat', beneficiaries: [], lines: [cart.lines[0]], amountDue: undefined }).expect(201)).body;

    const list = (await http().get(`/v1/held-carts?registerId=${s.registerId}`).set(s.manager).expect(200)).body.data;
    expect(list.map((c: { label: string; lineCount: number; amountDue: string }) => [c.label, c.lineCount, c.amountDue])).toEqual([['Lady in blue', 2, '105.28'], ['Man with a hat', 1, null]]);
    expect(list[0].items).toEqual([{ name: 'Cola 290ml', quantity: '3' }, { name: 'Rice 1kg', quantity: '1' }]);
    expect((await http().get(`/v1/held-carts?registerId=${s.register2Id}`).set(s.manager).expect(200)).body.data).toEqual([]);

    // Another register's shift cannot take it.
    const other = await openSession(s.cashier, s.register2Id);
    expect((await http().post(`/v1/held-carts/${held.id}/resume`).set(s.cashier).send({ cashierSessionId: other }).expect(422)).body.error.code).toBe('WRONG_REGISTER');

    // Two tills try at once: it comes back once.
    const both = await Promise.all([1, 2].map(() => http().post(`/v1/held-carts/${held.id}/resume`).set(s.manager).send({ cashierSessionId: session })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const back = both.find((r) => r.status === 200)!.body;
    expect(back).toMatchObject({ label: 'Lady in blue', lines: cart.lines, beneficiaries: cart.beneficiaries });

    const [row] = await q<{ status: string; lines: unknown; beneficiaries: unknown }>(s, `SELECT status, lines, beneficiaries FROM held_carts WHERE id = $1`, [held.id]);
    expect(row).toEqual({ status: 'RESUMED', lines: [], beneficiaries: [] });
    await http().post(`/v1/held-carts/${second.id}/discard`).set(s.manager).expect(200);
    expect((await http().post(`/v1/held-carts/${second.id}/discard`).set(s.manager).expect(409)).body.error.code).toBe('HELD_CART_CLOSED');
    expect((await http().get(`/v1/held-carts?registerId=${s.registerId}`).set(s.manager).expect(200)).body.data).toEqual([]);

    // The table guards itself: no reopening, no keeping the lines, no deleting.
    for (const sql of [`UPDATE held_carts SET status = 'OPEN', closed_at = NULL, closed_by = NULL`, `UPDATE held_carts SET lines = '[1]'`, `DELETE FROM held_carts`]) {
      expect(String(await q(s, sql).catch((e: Error) => e))).toMatch(/held cart|never deleted/);
    }
    expect((await q(s, `SELECT action FROM audit_logs WHERE resource_type = 'held_cart' ORDER BY occurred_at, id`)).map((r) => r.action)).toEqual(['held_cart.held', 'held_cart.held', 'held_cart.resumed', 'held_cart.discarded']);
  });
});

describe('exchanges', () => {
  let s: Store;
  let earlier: { id: string; lines: { id: string; variantId: string }[] };
  let session: string;

  beforeAll(async () => {
    s = await store('exch');
    // The earlier sale was made on a shift that is now closed.
    const first = await openSession(s.manager, s.registerId, '0.00');
    earlier = (await sell(s.manager, { cashierSessionId: first, clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '2' }, { variantId: s.rice, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '156.80' }] }).expect(201)).body;
    await http().post(`/v1/cashier-sessions/${first}/close`).set(s.manager).send({ countedCash: '156.80' }).expect(200);
    session = await openSession(s.manager, s.registerId, '100.00');
  });

  const exchange = (auth: Auth, body: Record<string, unknown>, key = randomUUID()) => http().post('/v1/exchanges').set(auth).set('Idempotency-Key', key).send(body);
  const line = (variantId: string) => earlier.lines.find((l) => l.variantId === variantId)!.id;

  it('a dearer item: the refund pays first, the customer pays the rest, the drawer and books move by the difference', async () => {
    const before = await drawer(s, session);
    // What the counter shows before taking money: the refund of the item coming back.
    const preview = (await http().post(`/v1/sales/${earlier.id}/returns/preview`).set(s.manager).send({ lines: [{ saleLineId: line(s.cola), quantity: '1' }] }).expect(200)).body;
    expect(preview).toMatchObject({ refund: '22.40', lines: [{ saleLineId: line(s.cola), quantity: '1', amountDue: '22.40' }] });
    expect((await http().post(`/v1/sales/${earlier.id}/returns/preview`).set(s.cashier).send({ lines: [{ saleLineId: line(s.cola), quantity: '1' }] }).expect(403)).body.error.details.missing).toEqual(['sales.refund']);
    const body = {
      cashierSessionId: session, saleId: earlier.id, reason: 'Wrong size', expectedRefund: '22.40',
      returnLines: [{ saleLineId: line(s.cola), quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.rice, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '40.00' }], expectedAmountDue: '56.00' },
    };
    const key = randomUUID();
    const res = (await exchange(s.manager, body, key).expect(201)).body;
    expect(res.saleReturn).toMatchObject({ kind: 'RETURN', amountDue: '22.40', saleId: earlier.id });
    expect(res.sale).toMatchObject({ amountDue: '56.00', amountTendered: '62.40', changeDue: '6.40' });
    expect(res.sale.tenders.map((t: { amount: string; tendered: string; change: string; exchangeReturnId: string | null }) => [t.amount, t.tendered, t.change, t.exchangeReturnId]))
      .toEqual([['22.40', '22.40', '0.00', res.saleReturn.id], ['33.60', '40.00', '6.40', null]]);
    // The customer handed over ₱40 and got ₱6.40 back: ₱33.60 more in the drawer.
    expect(await drawer(s, session)).toBeCloseTo(before + 33.6, 2);
    // A retry with the same key answers the same exchange and records nothing more.
    expect((await exchange(s.manager, body, key).expect(201)).body.sale.id).toBe(res.sale.id);
    expect((await q(s, `SELECT 1 FROM sales WHERE id <> $1 AND id <> $2`, [res.sale.id, earlier.id])).length).toBe(0);

    const receipt = (await http().get(`/v1/sales/${res.sale.id}/receipt`).set(s.manager).expect(200)).body;
    expect(receipt.tenders[0]).toMatchObject({ method: 'CASH', amount: '22.40', exchangeReturnNumber: res.saleReturn.returnNumber });
    // Each document posted its own entry; together they move cash by ₱33.60.
    const [cash] = await q<{ v: string }>(s, `
      SELECT sum(l.debit - l.credit) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
       WHERE a.system_key = 'CASH_ON_HAND' AND e.source_id IN ($1, $2)`, [res.sale.id, res.saleReturn.id]);
    expect(Number(cash!.v)).toBeCloseTo(33.6, 4);
    // The cola went back on the shelf.
    const [stock] = await q<{ n: string }>(s, `SELECT quantity AS n FROM stock_balances WHERE variant_id = $1 AND branch_id = $2`, [s.cola, s.branchId]);
    expect(Number(stock!.n)).toBe(49);
  });

  it('a cheaper item: the difference comes back as change; nothing to pay on top', async () => {
    const before = await drawer(s, session);
    const res = (await exchange(s.manager, {
      cashierSessionId: session, saleId: earlier.id, reason: 'Changed mind',
      returnLines: [{ saleLineId: line(s.rice), quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '1' }] },
    }).expect(201)).body;
    expect(res.sale).toMatchObject({ amountDue: '22.40', amountTendered: '56.00', changeDue: '33.60' });
    expect(await drawer(s, session)).toBeCloseTo(before - 33.6, 2);
    // Paying on top of a refund that already covers the sale is refused.
    const extra = await exchange(s.manager, {
      cashierSessionId: session, saleId: earlier.id, reason: 'Changed mind',
      returnLines: [{ saleLineId: line(s.rice), quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '5.00' }] },
    }).expect(422);
    expect(extra.body.error.code).toBe('UNNECESSARY_TENDER');
  });

  it('refused as a whole: without the refund permission, with too little in the drawer, or more than was sold', async () => {
    const cashierSession = await openSession(s.cashier, s.register2Id, '0.00');
    const base = { saleId: earlier.id, reason: 'Wrong size', returnLines: [{ saleLineId: line(s.cola), quantity: '1', disposition: 'RESTOCK' }], sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.rice, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '40.00' }] } };
    expect((await exchange(s.cashier, { ...base, cashierSessionId: cashierSession }).expect(403)).body.error.details.missing).toEqual(['sales.refund']);
    expect((await exchange(s.manager, { ...base, cashierSessionId: session, returnLines: [{ saleLineId: line(s.cola), quantity: '5', disposition: 'RESTOCK' }] }).expect(422)).body.error.code).toBe('RETURN_EXCEEDS_SOLD');

    // A shift with an empty drawer cannot give back the difference on a cheaper item.
    await http().post(`/v1/cashier-sessions/${session}/close`).set(s.manager).send({ countedCash: String(await drawer(s, session)) }).expect(200);
    const empty = await openSession(s.manager, s.registerId, '0.00');
    const counts = async () => (await q<{ n: string }>(s, `SELECT (SELECT count(*) FROM sales) + (SELECT count(*) FROM sale_returns) AS n`))[0]!.n;
    const before = await counts();
    const short = await exchange(s.manager, {
      cashierSessionId: empty, saleId: earlier.id, reason: 'Changed mind',
      returnLines: [{ saleLineId: line(s.rice), quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '1' }] },
    }).expect(422);
    expect(short.body.error).toMatchObject({ code: 'INSUFFICIENT_DRAWER_CASH', details: { shortBy: '33.60' } });
    expect(await counts()).toBe(before);
  });
});
