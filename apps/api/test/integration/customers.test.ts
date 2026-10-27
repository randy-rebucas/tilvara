import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/** Customers (SPEC §6.9, ADR-0018): profiles, consent, history, store credit, export, anonymising. */
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
  entityId: string;
  branchId: string;
  registerId: string;
  register2Id: string;
  cola: string;
  rice: string;
  cashier: Auth;
  cashierId: string;
  cashier2: Auth;
  manager: Auth;
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
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID())
    .send({ branchId: br.body.id, reason: 'Opening stock', items: [{ variantId: cola, quantity: '50', unitCost: '12.00' }, { variantId: rice, quantity: '50', unitCost: '40.00' }] }).expect(201);
  const scope = { type: 'BRANCH' as const, id: br.body.id };
  const c = await addMember(owner, t.tenantId, 'cashier', scope);
  const c2 = await addMember(owner, t.tenantId, 'cashier', scope);
  const m = await addMember(owner, t.tenantId, 'branch_manager', scope);
  return {
    t, auth, entityId: le.body.id, branchId: br.body.id, registerId: reg.body.id, register2Id: reg2.body.id, cola, rice,
    cashier: bearer(await loginToken(app, c.email)), cashierId: c.userId, cashier2: bearer(await loginToken(app, c2.email)), manager: bearer(await loginToken(app, m.email)),
  };
}

const openSession = async (auth: Auth, registerId: string, openingFloat = '500.00') =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat }).expect(201)).body.id as string;
const sell = (auth: Auth, body: object) => http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send(body);
const sale = (sessionId: string, lines: object[], tenders: object[], extra: object = {}) => ({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders, ...extra });
async function q<T extends pg.QueryResultRow>(s: Store, sql: string, params: unknown[] = []): Promise<T[]> {
  return asOwnerInTenant(owner, s.t.tenantId, async (c) => (await c.query<T>(sql, params)).rows);
}
const gl = async (s: Store, key: string) =>
  Number((await q<{ v: string }>(s, `SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = $1`, [key]))[0]!.v);

describe('customer profiles', () => {
  it('managers add and correct customers; cashiers find them; changes are audited by field name only', async () => {
    const s = await store('cust');
    const body = { displayName: 'Maria Santos', phone: '0917 123 4567', email: 'Maria@Example.ph', code: 'C-001', marketingConsent: true, consentSource: 'COUNTER' };
    expect((await http().post('/v1/customers').set(s.cashier).send(body).expect(403)).body.error.details.missing).toEqual(['customers.manage']);
    const maria = (await http().post('/v1/customers').set(s.manager).send(body).expect(201)).body;
    expect(maria).toMatchObject({ displayName: 'Maria Santos', email: 'maria@example.ph', marketingConsent: true, storeCredit: [], canManage: true });
    expect((await http().post('/v1/customers').set(s.manager).send({ ...body, displayName: 'Other', marketingConsent: false }).expect(409)).body.error.code).toBe('CUSTOMER_CODE_TAKEN');
    await http().post('/v1/customers').set(s.manager).send({ displayName: 'Jose Rizal' }).expect(201);
    await http().post('/v1/customers').set(s.manager).send({ displayName: 'x', phone: 'call me' }).expect(400);

    // A cashier finds them by name, phone or number.
    for (const term of ['maria', '0917', 'c-001']) {
      const found = (await http().get('/v1/customers').query({ q: term }).set(s.cashier).expect(200)).body.data;
      expect([term, found.map((c: { id: string }) => c.id)]).toEqual([term, [maria.id]]);
    }
    expect((await http().get(`/v1/customers/${maria.id}`).set(s.cashier).expect(200)).body.canManage).toBe(false);

    const fixed = (await http().patch(`/v1/customers/${maria.id}`).set(s.manager).send({ phone: '0918 765 4321', address: '' }).expect(200)).body;
    expect([fixed.phone, fixed.address]).toEqual(['0918 765 4321', null]);
    const audit = await q<{ action: string; metadata: Record<string, unknown> }>(s, `SELECT action, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY occurred_at, id`, [maria.id]);
    expect(audit.map((a) => a.action)).toEqual(['customer.created', 'customer.corrected']);
    expect(audit[1]!.metadata).toEqual({ fields: ['phone'] });
    // No personal value is copied into the audit log.
    expect(JSON.stringify(audit)).not.toMatch(/Maria|0917|0918|example\.ph/);

    // Consent: anyone who may open the customer can record a "stop"; giving consent needs a manager.
    await http().post(`/v1/customers/${maria.id}/consent`).set(s.cashier).send({ marketingConsent: true, source: 'COUNTER' }).expect(200); // unchanged: already given
    const stopped = (await http().post(`/v1/customers/${maria.id}/consent`).set(s.cashier).send({ marketingConsent: false, source: 'REQUEST' }).expect(200)).body;
    expect(stopped.marketingConsent).toBe(false);
    await http().post(`/v1/customers/${maria.id}/consent`).set(s.cashier).send({ marketingConsent: true, source: 'COUNTER' }).expect(403);
    const consents = await q<{ granted: boolean; source: string }>(s, `SELECT granted, source FROM customer_consent_events WHERE customer_id = $1 ORDER BY recorded_at, id`, [maria.id]);
    expect(consents).toEqual([{ granted: true, source: 'COUNTER' }, { granted: false, source: 'REQUEST' }]);

    // Archived customers leave the search and cannot be put on a sale.
    const jose = (await http().get('/v1/customers').query({ q: 'jose' }).set(s.manager).expect(200)).body.data[0];
    await http().post(`/v1/customers/${jose.id}/archive`).set(s.manager).expect(200);
    expect((await http().get('/v1/customers').query({ q: 'jose' }).set(s.manager).expect(200)).body.data).toEqual([]);
    const session = await openSession(s.cashier, s.registerId);
    expect((await sell(s.cashier, sale(session, [{ variantId: s.cola, quantity: '1' }], [{ method: 'CASH', tendered: '22.40' }], { customerId: jose.id })).expect(409)).body.error.code).toBe('ARCHIVED');
  });

  it('a lapsed or suspended business still records a "stop" and an erasure, nothing else', async () => {
    const t = await signup(app, 'cust-ro');
    const auth = bearer(t.access);
    const add = async (displayName: string) =>
      (await http().post('/v1/customers').set(auth).send({ displayName, phone: '0917 555 0101', marketingConsent: true, consentSource: 'COUNTER' }).expect(201)).body.id as string;
    const [ana, ben, cora] = [await add('Ana Cruz'), await add('Ben Reyes'), await add('Cora Lim')];
    await http().post(`/v1/customers/${cora}/consent`).set(auth).send({ marketingConsent: false, source: 'REQUEST' }).expect(200);

    // The trial lapses: records are read-only.
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 second'`));
    expect((await http().patch(`/v1/customers/${ana}`).set(auth).send({ phone: '0918 000 0000' }).expect(402)).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    expect((await http().post(`/v1/customers/${cora}/consent`).set(auth).send({ marketingConsent: true, source: 'ADMIN' }).expect(402)).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    expect((await http().post(`/v1/customers/${ana}/consent`).set(auth).send({ marketingConsent: false, source: 'REQUEST' }).expect(200)).body.marketingConsent).toBe(false);
    expect((await http().post(`/v1/customers/${ben}/anonymise`).set(auth).send({ reason: 'The customer asked to be forgotten' }).expect(200)).body.anonymisedAt).not.toBeNull();
    await http().post(`/v1/customers/${ana}/archive`).set(auth).expect(402);

    // Suspended: the same two writes, and only those.
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [t.tenantId]));
    const cora2 = (await http().get(`/v1/customers/${cora}`).set(auth).expect(200)).body;
    expect(cora2.marketingConsent).toBe(false);
    expect((await http().post(`/v1/customers/${cora}/consent`).set(auth).send({ marketingConsent: true, source: 'ADMIN' }).expect(403)).body.error.code).toBe('TENANT_SUSPENDED');
    await http().post('/v1/customers').set(auth).send({ displayName: 'New' }).expect(403);
    await http().post(`/v1/customers/${ana}/anonymise`).set(auth).send({ reason: 'Asked to be forgotten' }).expect(200);

    const actions = await asOwnerInTenant(owner, t.tenantId, async (c) =>
      (await c.query<{ action: string }>(`SELECT action FROM audit_logs WHERE resource_type = 'customer' AND action IN ('customer.consent_withdrawn', 'customer.anonymised') ORDER BY occurred_at, id`)).rows.map((r) => r.action));
    expect(actions).toEqual(['customer.consent_withdrawn', 'customer.consent_withdrawn', 'customer.anonymised', 'customer.anonymised']);
  });
});

describe('purchases and store credit', () => {
  let s: Store;
  let maria: { id: string };
  let session: string;
  let managerSession: string;
  let bought: { id: string; lines: { id: string; variantId: string }[] };

  beforeAll(async () => {
    s = await store('credit');
    maria = (await http().post('/v1/customers').set(s.manager).send({ displayName: 'Maria Santos', phone: '09171234567' }).expect(201)).body;
    session = await openSession(s.cashier, s.registerId);
    managerSession = await openSession(s.manager, s.register2Id);
  });

  it('a sale names its customer; purchase history shows what the reader may see', async () => {
    bought = (await sell(s.cashier, sale(session, [{ variantId: s.cola, quantity: '2' }, { variantId: s.rice, quantity: '1' }], [{ method: 'CASH', tendered: '100.80' }], { customerId: maria.id })).expect(201)).body;
    expect(bought).toMatchObject({ customerId: maria.id, amountDue: '100.80' });
    await sell(s.manager, sale(managerSession, [{ variantId: s.cola, quantity: '1' }], [{ method: 'CASH', tendered: '22.40' }], { customerId: maria.id })).expect(201);
    const forManager = (await http().get(`/v1/customers/${maria.id}/sales`).set(s.manager).expect(200)).body.data;
    expect(forManager.map((x: { amountDue: string }) => x.amountDue)).toEqual(['22.40', '100.80']);
    // Cashiers hold sales.read at their branch: they see both. Someone with customers.read only sees none.
    expect((await http().get(`/v1/customers/${maria.id}/sales`).set(s.cashier2).expect(200)).body.data).toHaveLength(2);
    const reader = await http().post('/v1/roles').set(s.auth).send({ key: uniq('look').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30), name: 'Customer lookup', permissions: ['customers.read'] }).expect(201);
    const lookup = await addMember(owner, s.t.tenantId, 'cashier');
    await asOwnerInTenant(owner, s.t.tenantId, (c) => c.query(`UPDATE membership_roles SET role_id = $1 WHERE membership_id = $2`, [reader.body.id, lookup.membershipId]));
    const lookupAuth = bearer(await loginToken(app, lookup.email));
    expect((await http().get(`/v1/customers/${maria.id}`).set(lookupAuth).expect(200)).body.displayName).toBe('Maria Santos');
    expect((await http().get(`/v1/customers/${maria.id}/sales`).set(lookupAuth).expect(200)).body.data).toEqual([]);
    const receipt = (await http().get(`/v1/sales/${bought.id}/receipt`).set(s.cashier).expect(200)).body;
    expect(receipt.customer).toMatchObject({ name: 'Maria Santos' });
  });

  it('a return given as store credit moves no cash; the credit pays part of a later sale; the books follow', async () => {
    const drawerBefore = Number((await http().get(`/v1/cashier-sessions/${managerSession}`).set(s.manager).expect(200)).body.expectedCash);
    const colaLine = bought.lines.find((l) => l.variantId === s.cola)!.id;
    const back = (await http().post(`/v1/sales/${bought.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: managerSession, kind: 'RETURN', reason: 'Wrong flavour', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: colaLine, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(back).toMatchObject({ refundMethod: 'STORE_CREDIT', amountDue: '22.40' });
    expect(Number((await http().get(`/v1/cashier-sessions/${managerSession}`).set(s.manager).expect(200)).body.expectedCash)).toBe(drawerBefore);
    expect((await http().get(`/v1/customers/${maria.id}`).set(s.cashier).expect(200)).body.storeCredit).toEqual([{ legalEntityId: s.entityId, legalEntityName: 'credit Corp', balance: '22.40' }]);
    expect(await gl(s, 'CUSTOMER_STORE_CREDIT')).toBeCloseTo(-22.4, 4);

    // Too much, or for nobody: refused, nothing recorded.
    expect((await sell(s.cashier, sale(session, [{ variantId: s.rice, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '30.00' }, { method: 'CASH', tendered: '26.00' }], { customerId: maria.id })).expect(409)).body.error).toMatchObject({ code: 'INSUFFICIENT_STORE_CREDIT', details: { balance: '22.40' } });
    await sell(s.cashier, sale(session, [{ variantId: s.rice, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '22.40' }, { method: 'CASH', tendered: '33.60' }])).expect(400);
    expect((await sell(s.cashier, sale(session, [{ variantId: s.cola, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '22.41' }], { customerId: maria.id })).expect(422)).body.error.code).toBe('OVERPAYMENT');

    const paid = (await sell(s.cashier, sale(session, [{ variantId: s.rice, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '22.40' }, { method: 'CASH', tendered: '40.00' }], { customerId: maria.id })).expect(201)).body;
    expect(paid).toMatchObject({ amountDue: '56.00', changeDue: '6.40' });
    expect(paid.tenders.map((t: { method: string; amount: string }) => [t.method, t.amount])).toEqual([['STORE_CREDIT', '22.40'], ['CASH', '33.60']]);
    expect((await http().get(`/v1/customers/${maria.id}`).set(s.cashier).expect(200)).body.storeCredit[0].balance).toBe('0.00');
    expect(await gl(s, 'CUSTOMER_STORE_CREDIT')).toBeCloseTo(0, 4);
    const [cash] = await q<{ v: string }>(s, `SELECT sum(amount) AS v FROM cash_movements WHERE sale_id = $1`, [paid.id]);
    expect(Number(cash!.v)).toBe(33.6);
    const ledger = (await http().get(`/v1/customers/${maria.id}/store-credit`).set(s.cashier).expect(200)).body.data;
    expect(ledger.map((e: { kind: string; amount: string; canOpen: boolean }) => [e.kind, e.amount, e.canOpen])).toEqual([['REDEEM', '-22.40', true], ['RETURN', '22.40', true]]);
    // Paged newest first; a reader who may not read those sales sees the entries but may not open their documents.
    const first = (await http().get(`/v1/customers/${maria.id}/store-credit?limit=1`).set(s.cashier).expect(200)).body;
    expect([first.data.map((e: { kind: string }) => e.kind), first.nextCursor]).toEqual([['REDEEM'], first.data[0].id]);
    const rest = (await http().get(`/v1/customers/${maria.id}/store-credit?limit=1&cursor=${first.nextCursor}`).set(s.cashier).expect(200)).body;
    expect([rest.data.map((e: { kind: string }) => e.kind), rest.nextCursor]).toEqual([['RETURN'], null]);
    const other = await addMember(owner, s.t.tenantId, 'cashier', { type: 'REGISTER', id: s.register2Id });
    const otherAuth = bearer(await loginToken(app, other.email));
    const view = (await http().get(`/v1/customers/${maria.id}/store-credit`).set(otherAuth).expect(200)).body.data;
    expect(view.map((e: { canOpen: boolean }) => e.canOpen)).toEqual([false, false]);
  });

  it('two tills spending the same credit at once: one of them gets it', async () => {
    const lines = bought.lines.filter((l) => l.variantId === s.rice);
    await http().post(`/v1/sales/${bought.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: managerSession, kind: 'RETURN', reason: 'Spoiled', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: lines[0]!.id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201);
    const spend = (auth: Auth, sess: string) => sell(auth, sale(sess, [{ variantId: s.rice, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '56.00' }], { customerId: maria.id }));
    const both = await Promise.all([spend(s.cashier, session), spend(s.manager, managerSession)]);
    expect(both.map((r) => [r.status, r.body.error?.code ?? null]).sort()).toEqual([[201, null], [409, 'INSUFFICIENT_STORE_CREDIT']]);
    expect((await http().get(`/v1/customers/${maria.id}`).set(s.manager).expect(200)).body.storeCredit[0].balance).toBe('0.00');
  });

  it('a refund as store credit needs a customer; the database guards the credit ledger', async () => {
    const anon = (await sell(s.cashier, sale(session, [{ variantId: s.cola, quantity: '1' }], [{ method: 'CASH', tendered: '22.40' }])).expect(201)).body;
    expect((await http().post(`/v1/sales/${anon.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: managerSession, kind: 'RETURN', reason: 'x', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: anon.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(422)).body.error.code).toBe('CUSTOMER_REQUIRED');
    // Naming the customer at the counter works for a sale rung up without one.
    await http().post(`/v1/sales/${anon.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: managerSession, kind: 'RETURN', reason: 'x', refundTo: 'STORE_CREDIT', customerId: maria.id, lines: [{ saleLineId: anon.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);

    const [entry] = await q<{ id: string; sale_return_id: string }>(s, `SELECT id, sale_return_id FROM customer_credit_entries WHERE kind = 'RETURN' ORDER BY created_at DESC LIMIT 1`);
    const forged = [
      // Credit for nothing, or more than the return gave.
      `INSERT INTO customer_credit_entries (tenant_id, legal_entity_id, branch_id, customer_id, kind, amount, sale_return_id, created_by) SELECT tenant_id, legal_entity_id, branch_id, customer_id, kind, amount + 1, sale_return_id, created_by FROM customer_credit_entries WHERE id = '${entry!.id}'`,
      // Spending credit the customer does not have.
      `INSERT INTO customer_credit_entries (tenant_id, legal_entity_id, branch_id, customer_id, kind, amount, sale_id, created_by) SELECT tenant_id, legal_entity_id, branch_id, customer_id, 'REDEEM', -1000, '${anon.id}', created_by FROM customer_credit_entries WHERE id = '${entry!.id}'`,
      `UPDATE customer_credit_entries SET amount = 1000`,
      `DELETE FROM customer_credit_entries`,
    ];
    for (const sql of forged) expect(String(await q(s, sql).catch((e: Error) => e))).toMatch(/does not match|below zero|append-only|not allowed|forbid|immutable/i);
  });

  it('export gives everything held; anonymising waits for the credit, then forgets the person for good', async () => {
    expect((await http().post(`/v1/customers/${maria.id}/export`).set(s.cashier).expect(403)).body.error.details.missing).toEqual(['customers.manage']);
    const dump = (await http().post(`/v1/customers/${maria.id}/export`).set(s.manager).expect(200)).body;
    expect(dump).toMatchObject({ format: 'tilvara-customer-export/1', customer: { displayName: 'Maria Santos', phone: '09171234567' } });
    expect(dump.purchases.length).toBeGreaterThanOrEqual(3);
    expect(dump.purchases[0].lines.map((l: { name: string }) => l.name)).toEqual(['Cola 290ml', 'Rice 1kg']);
    expect(dump.storeCredit.length).toBeGreaterThanOrEqual(3);

    const refused = await http().post(`/v1/customers/${maria.id}/anonymise`).set(s.manager).send({ reason: 'Customer asked' }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'CUSTOMER_HAS_CREDIT', details: { balances: [{ legalEntityId: s.entityId, balance: '22.40' }] } });
    await sell(s.cashier, sale(session, [{ variantId: s.cola, quantity: '1' }], [{ method: 'STORE_CREDIT', amount: '22.40' }], { customerId: maria.id })).expect(201);

    const gone = (await http().post(`/v1/customers/${maria.id}/anonymise`).set(s.manager).send({ reason: 'Customer asked' }).expect(200)).body;
    expect(gone).toMatchObject({ displayName: 'Anonymised customer', phone: null, email: null, code: null, marketingConsent: false });
    expect(gone.anonymisedAt).toBeTruthy();
    expect((await http().patch(`/v1/customers/${maria.id}`).set(s.manager).send({ displayName: 'Maria' }).expect(409)).body.error.code).toBe('CUSTOMER_ANONYMISED');
    // Their sales stay, pointing at the anonymised row.
    expect((await http().get(`/v1/customers/${maria.id}/sales`).set(s.manager).expect(200)).body.data.length).toBeGreaterThanOrEqual(3);
    for (const sql of [`UPDATE customers SET display_name = 'Maria Santos' WHERE anonymised_at IS NOT NULL`, `DELETE FROM customers`]) {
      expect(String(await q(s, sql).catch((e: Error) => e))).toMatch(/anonymised|never deleted/);
    }
    expect((await q(s, `SELECT action FROM audit_logs WHERE resource_id = $1 AND action IN ('customer.exported', 'customer.anonymised')`, [maria.id])).length).toBe(2);
  });
});

describe('store credit never turns into drawer cash (audit 2026-10-21)', () => {
  let s: Store;
  let maria: { id: string };
  let managerSession: string;
  const drawer = async () => (await http().get(`/v1/cashier-sessions/${managerSession}`).set(s.manager).expect(200)).body.expectedCash as string;
  const balance = async () => (await http().get(`/v1/customers/${maria.id}`).set(s.manager).expect(200)).body.storeCredit[0]?.balance as string;
  const giveBack = (saleId: string, body: object) =>
    http().post(`/v1/sales/${saleId}/returns`).set(s.manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: managerSession, reason: 'Changed mind', ...body });

  beforeAll(async () => {
    s = await store('credit-back');
    maria = (await http().post('/v1/customers').set(s.manager).send({ displayName: 'Maria Cruz' }).expect(201)).body;
    managerSession = await openSession(s.manager, s.registerId);
    // ₱112.00 of credit: two bags of rice returned as store credit.
    const rice = (await sell(s.manager, sale(managerSession, [{ variantId: s.rice, quantity: '2' }], [{ method: 'CASH', tendered: '112.00' }], { customerId: maria.id })).expect(201)).body;
    await giveBack(rice.id, { kind: 'RETURN', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: rice.lines[0].id, quantity: '2', disposition: 'RESTOCK' }] }).expect(201);
    expect(await balance()).toBe('112.00');
  });

  it('a void of a sale paid with store credit gives the credit back, not cash; an exchange of it is refused', async () => {
    const paid = (await sell(s.manager, sale(managerSession, [{ variantId: s.cola, quantity: '2' }], [{ method: 'STORE_CREDIT', amount: '44.80' }], { customerId: maria.id })).expect(201)).body;
    expect(await balance()).toBe('67.20');
    // Exchanging it would hand the credit over as cash change: refused, at the preview and at the exchange.
    const lines = [{ saleLineId: paid.lines[0].id, quantity: '1', disposition: 'RESTOCK' }];
    expect((await http().post(`/v1/sales/${paid.id}/returns/preview`).set(s.manager).send({ lines }).expect(409)).body.error.code).toBe('EXCHANGE_STORE_CREDIT');
    expect((await http().post('/v1/exchanges').set(s.manager).set('Idempotency-Key', randomUUID()).send({
      cashierSessionId: managerSession, saleId: paid.id, reason: 'Other size', returnLines: lines,
      sale: { clientTransactionId: randomUUID(), lines: [{ variantId: s.cola, quantity: '1' }], tenders: [] },
    }).expect(409)).body.error.code).toBe('EXCHANGE_STORE_CREDIT');

    const before = await drawer();
    const glBefore = await gl(s, 'CUSTOMER_STORE_CREDIT');
    const back = (await giveBack(paid.id, { kind: 'VOID' }).expect(201)).body;
    expect(back).toMatchObject({ amountDue: '44.80', refundMethod: 'STORE_CREDIT' });
    expect(await drawer()).toBe(before);
    expect(await balance()).toBe('112.00');
    expect(await gl(s, 'CUSTOMER_STORE_CREDIT') - glBefore).toBeCloseTo(-44.8, 4);
    expect((await q(s, `SELECT 1 FROM cash_movements WHERE sale_return_id = $1`, [back.id])).length).toBe(0);
    const slip = (await http().get(`/v1/sale-returns/${back.id}/receipt`).set(s.manager).expect(200)).body;
    expect(slip.tenders).toEqual([{ method: 'STORE_CREDIT', amount: '44.80' }]);
  });

  // Needs the DDL in the audit report (customer_credit_entries_match must accept a credit share of a cash refund).
  it('returns of a sale paid partly with credit give that share back as credit, the rest in cash, never more credit than was used', async () => {
    const paid = (await sell(s.manager, sale(managerSession, [{ variantId: s.cola, quantity: '3' }], [{ method: 'STORE_CREDIT', amount: '22.40' }, { method: 'CASH', tendered: '44.80' }], { customerId: maria.id })).expect(201)).body;
    expect(await balance()).toBe('89.60');
    const line = paid.lines[0].id as string;
    const glCash = await gl(s, 'CASH_ON_HAND');
    const glCredit = await gl(s, 'CUSTOMER_STORE_CREDIT');

    // One of three: ₱22.40 back, a third of it (₱7.47) as credit, ₱14.93 in cash.
    let before = Number(await drawer());
    const first = (await giveBack(paid.id, { kind: 'RETURN', lines: [{ saleLineId: line, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(first).toMatchObject({ amountDue: '22.40', refundMethod: 'CASH', refunds: [{ method: 'STORE_CREDIT', amount: '7.47' }, { method: 'CASH', amount: '14.93' }] });
    expect(Number(await drawer())).toBeCloseTo(before - 14.93, 2);
    expect(await balance()).toBe('97.07');

    // The last two: the rest of the credit exactly (₱14.93), ₱29.87 in cash. Total credit back = ₱22.40 used.
    before = Number(await drawer());
    const last = (await giveBack(paid.id, { kind: 'RETURN', lines: [{ saleLineId: line, quantity: '2', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(last.refunds).toEqual([{ method: 'STORE_CREDIT', amount: '14.93' }, { method: 'CASH', amount: '29.87' }]);
    expect(Number(await drawer())).toBeCloseTo(before - 29.87, 2);
    expect(await balance()).toBe('112.00');
    const slip = (await http().get(`/v1/sale-returns/${last.id}/receipt`).set(s.manager).expect(200)).body;
    expect(slip.tenders).toEqual([{ method: 'STORE_CREDIT', amount: '14.93' }, { method: 'CASH', amount: '29.87' }]);
    // Books: the credit came back to the liability, only the cash share left Cash on hand.
    expect(await gl(s, 'CUSTOMER_STORE_CREDIT') - glCredit).toBeCloseTo(-22.4, 4);
    expect(await gl(s, 'CASH_ON_HAND') - glCash).toBeCloseTo(-44.8, 4);
  });

  it('the by-tender report and the Z-reading count a split refund under where the money went (audit 2026-10-21 §3)', async () => {
    // This store's day: sales CASH 112.00 + 44.80, STORE_CREDIT 44.80 + 22.40. Refunds as credit 112.00 (return),
    // 44.80 (void), 7.47 + 14.93 (credit shares of two CASH returns); in cash only 14.93 + 29.87.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const byTender = (await http().get('/v1/reports/by-tender').query({ branchId: s.branchId, from: today, to: today }).set(s.manager).expect(200)).body.data;
    expect(byTender).toEqual([
      { method: 'CASH', tenders: 2, collected: '156.80', refundsCount: 2, refunded: '44.80', net: '112.00' },
      { method: 'STORE_CREDIT', tenders: 2, collected: '67.20', refundsCount: 4, refunded: '179.20', net: '-112.00' },
    ]);
    const countedCash = await drawer();
    await http().post(`/v1/cashier-sessions/${managerSession}/close`).set(s.manager).send({ countedCash }).expect(200);
    const z = (await http().post(`/v1/registers/${s.registerId}/z-readings`).set(s.manager).send({ day: today }).expect(201)).body;
    expect(z.tenders).toEqual({ CASH: '112.00', STORE_CREDIT: '-112.00' });
    // The tenders still add up to the day's net.
    expect(z).toMatchObject({ salesAmount: '224.00', returnsAmount: '179.20', voidsAmount: '44.80', netAmount: '0.00' });
  });
});
