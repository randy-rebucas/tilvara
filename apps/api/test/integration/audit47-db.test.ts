import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, ensurePlanPrices, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/**
 * Audit 2026-10-31 (session 46), database and counter fixes (migrations 0136–0137): ops' words out of the business's
 * log (#1), a card payment being cancelled refused by a sale (#5), no shift after today's Z-reading (#6), an upgrade
 * during a paid trial (#8), a plan paid ahead waits for its period (#10), `support subscription-set` voids open bills
 * (#11) and a tiny upgrade applies at once (#13).
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  await ensurePlanPrices(owner);
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const sql = <T = Record<string, unknown>>(t: { tenantId: string }, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

/** A VAT shop with Cola ₱22.40 on hand at B1 and a cashier's shift on R1. */
async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const cola = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '22.40' }] }).expect(201)).body.variants[0].id as string;
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '10', unitCost: '15.00' }] }).expect(201);
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  return { t, tenantId: t.tenantId, auth, branchId, registerId, cola, cashier, session };
}

describe('#5 a card payment being cancelled is never used by a sale', () => {
  it('a sale refuses a payment whose cancel was sent; a refused cancel frees it; a cancel marks it first', async () => {
    const s = await shop('db46-cancel');
    const tx = randomUUID();
    const intent = (await http().post('/v1/payment-intents').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: tx, method: 'CARD', amount: '22.40' }).expect(201)).body as { id: string; status: string };
    expect(intent.status).toBe('SUCCEEDED');
    // The cancel's first transaction has committed and the provider call is under way.
    await sql(s, 'UPDATE payment_intents SET cancel_requested_at = now() WHERE id = $1', [intent.id]);
    const sale = { cashierSessionId: s.session, clientTransactionId: tx, lines: [{ variantId: s.cola, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: intent.id }] };
    const refused = await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID()).send(sale).expect(409);
    expect(refused.body.error.code).toBe('PAYMENT_CANCELLING');
    expect(await sql(s, 'SELECT count(*)::int AS n FROM sales')).toEqual([{ n: 0 }]);
    // The cancel goes through: the payment is cancelled, never part of a sale.
    const canceled = (await http().post(`/v1/payment-intents/${intent.id}/cancel`).set(s.cashier).expect(200)).body as { status: string };
    expect(canceled.status).toBe('CANCELED');

    // A payment used by a sale: the cancel is refused before anything reaches the provider, and nothing is marked.
    const tx2 = randomUUID();
    const used = (await http().post('/v1/payment-intents').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: tx2, method: 'CARD', amount: '22.40' }).expect(201)).body as { id: string };
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ ...sale, clientTransactionId: tx2, tenders: [{ method: 'INTENT', paymentIntentId: used.id }] }).expect(201);
    expect((await http().post(`/v1/payment-intents/${used.id}/cancel`).set(s.cashier).expect(409)).body.error.code).toBe('PAYMENT_CONSUMED');
    expect(await sql(s, 'SELECT status, cancel_requested_at FROM payment_intents WHERE id = $1', [used.id])).toEqual([{ status: 'SUCCEEDED', cancel_requested_at: null }]);
  });
});

describe('#6 no shift after the register’s Z-reading for today', () => {
  it('today’s reading closes the register for the day; another register still opens', async () => {
    const s = await shop('db46-z');
    await http().post(`/v1/cashier-sessions/${s.session}/close`).set(s.cashier).send({ countedCash: '1000.00' }).expect(200);
    const [{ today }] = (await owner.query<{ today: string }>(`SELECT (now() AT TIME ZONE 'Asia/Manila')::date::text AS today`)).rows as [{ today: string }];
    await http().post(`/v1/registers/${s.registerId}/z-readings`).set(s.auth).send({ day: today }).expect(201);
    const refused = await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: s.registerId, openingFloat: '1000.00' }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'Z_READING_TAKEN', details: { businessDay: today } });
    const r2 = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.branchId, code: 'R2', name: 'R2' }).expect(201)).body.id as string;
    await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: r2, openingFloat: '1000.00' }).expect(201);
  });
});

describe('billing (ADR-0027, audit 47)', () => {
  type Bill = { id: string; number: string; kind: string; planCode: string; amount: string; status: string };
  const bills = async (t: SignedUp) => (await http().get('/v1/subscription/bills').set(bearer(t.access)).expect(200)).body.data as Bill[];
  const choose = (t: SignedUp, planCode: string) => http().put('/v1/subscription/plan').set(bearer(t.access)).send({ planCode }).expect(200).then((r) => r.body as { effect: string; billId?: string });
  const setSubscription = (t: SignedUp, plan: string, status: string, periodEnd: Date | null) =>
    owner.query('SELECT platform_set_subscription($1, $2, $3, $4, null)', [t.tenantId, plan, status, periodEnd]);
  const trial = (t: SignedUp, plan: string, endsAt: Date) =>
    sql(t, `UPDATE subscriptions SET plan_code = $1, status = 'TRIALING', trial_ends_at = $2, current_period_end = NULL, grace_ends_at = NULL, scheduled_plan_code = NULL`, [plan, endsAt]);
  const tick = async (): Promise<Record<string, number>> => {
    for (let i = 0; i < 50; i++) {
      const r = (await owner.query<{ r: Record<string, number> }>('SELECT platform_billing_tick() AS r')).rows[0]!.r;
      if (!r.skipped) return r;
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error('the billing pass stayed held');
  };
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
  const pay = async (t: SignedUp, billId: string) => {
    const page = new URL((await http().post(`/v1/subscription/bills/${billId}/checkout`).set(bearer(t.access)).expect(200)).body.url).searchParams.get('id')!;
    await http().post('/v1/billing/dev-checkout/pay').query({ id: page }).type('form').send({ method: 'GCASH' }).expect(303);
  };
  const subscription = async (t: SignedUp) =>
    (await sql<{ plan_code: string; status: string; scheduled_plan_code: string | null; cancel_at_period_end: boolean }>(
      t, 'SELECT plan_code, status, scheduled_plan_code, cancel_at_period_end FROM subscriptions'))[0]!;
  const prices = async () =>
    Object.fromEntries((await owner.query<{ code: string; p: string }>('SELECT code, monthly_price::text AS p FROM plans')).rows.map((r) => [r.code, Number(r.p)]));
  const slugOf = async (t: SignedUp) => (await sql<{ slug: string }>(t, 'SELECT slug FROM tenants WHERE id = $1', [t.tenantId]))[0]!.slug;

  it('#1 ops’ login, reason and ticket stay in the platform log; the business’s log says support', async () => {
    const t = await signup(app, 'db46-ops');
    const slug = await slugOf(t);
    const { billId } = await choose(t, 'growth');
    const [b] = await sql<{ number: string; amount: string }>(t, 'SELECT number, amount::text FROM billing_bills WHERE id = $1', [billId]);
    expect(await owner.query(`SELECT platform_billing_record_payment($1, $2, $3, 'BANK_TRANSFER', $4, now(), 'ops-staff46', 'Paid by bank, see statement', 'T-4601')`,
      [slug, b!.number, b!.amount, uniq('REF')]).then((r) => r.rows[0])).toEqual({ platform_billing_record_payment: 'APPLIED' });
    await owner.query(`SELECT platform_change_subscription($1, 'growth', 'ACTIVE', null, $2, null, 'ops-staff46', 'Comped a month for the outage', 'T-4602')`, [slug, inDays(60)]);
    const { billId: upgrade } = await choose(t, 'enterprise');
    const [u] = await sql<{ number: string }>(t, 'SELECT number FROM billing_bills WHERE id = $1', [upgrade]);
    await owner.query(`SELECT platform_billing_void_bill($1, $2, 'ops-staff46', 'Customer disputed the charge', 'T-4603')`, [slug, u!.number]);

    const rows = await sql<{ action: string; metadata: Record<string, unknown> }>(t, `SELECT action, metadata FROM audit_logs WHERE action LIKE 'billing.%' OR action LIKE 'subscription.%'`);
    const text = JSON.stringify(rows);
    for (const word of ['ops-staff46', 'ops:', 'T-460', 'statement', 'outage', 'disputed']) expect(text).not.toContain(word);
    expect(rows.find((r) => r.action === 'billing.payment_recorded')!.metadata).toMatchObject({ by: 'support' });
    expect(rows.find((r) => r.action === 'billing.bill_voided' && r.metadata.number === u!.number)!.metadata).toMatchObject({ reason: 'CHANGED_BY_SUPPORT' });
    expect(rows.filter((r) => r.action === 'subscription.changed').map((r) => r.metadata.reason)).toEqual(expect.arrayContaining(['BILL_PAID', 'CHANGED_BY_SUPPORT']));

    // NULL-tenant rows are read as the platform role (CLAUDE.md).
    const c = await owner.connect();
    let platform: { action: string; metadata: Record<string, string> }[];
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE onepos_platform');
      platform = (await c.query(`SELECT action, metadata FROM audit_logs WHERE tenant_id IS NULL AND metadata ->> 'tenantId' = $1 ORDER BY occurred_at, id`, [t.tenantId])).rows;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(platform.map((r) => [r.action, r.metadata.actor, r.metadata.ticket])).toEqual([
      ['support.billing_payment', 'ops-staff46', 'T-4601'],
      ['support.subscription_changed', 'ops-staff46', 'T-4602'],
      ['support.billing_void', 'ops-staff46', 'T-4603'],
    ]);
  });

  it('#8 an upgrade during a trial whose first month is paid charges the paid month only', async () => {
    const t = await signup(app, 'db46-trialup');
    await trial(t, 'starter', inDays(13));
    const { billId } = await choose(t, 'starter');
    await pay(t, billId!);
    const up = await choose(t, 'enterprise');
    const bill = (await bills(t)).find((b) => b.id === up.billId)!;
    const p = await prices();
    // The difference for the one paid month; it was ×(1 + 13/30) before (the trial days counted as unpaid time).
    expect(Number(bill.amount)).toBeCloseTo(p.enterprise! - p.starter!, 0);
  });

  it('#10 a first month paid during a trial keeps the trial’s plan until the paid month starts', async () => {
    const t = await signup(app, 'db46-defer');
    await trial(t, 'growth', new Date(Date.now() + 8_000));
    const { billId } = await choose(t, 'starter');
    await pay(t, billId!);
    expect(await subscription(t)).toMatchObject({ plan_code: 'growth', status: 'ACTIVE', scheduled_plan_code: 'starter' });
    // Wait for the paid month to start by the database's clock (the pass compares with now()).
    for (let i = 0; i < 40 && (await sql<{ started: boolean }>(t, `SELECT bool_and(period_start <= now()) AS started FROM billing_bills WHERE status = 'PAID'`))[0]!.started !== true; i++) {
      await new Promise((res) => setTimeout(res, 500));
    }
    await tick();
    expect(await subscription(t)).toMatchObject({ plan_code: 'starter', scheduled_plan_code: null });
    const [row] = await sql<{ metadata: Record<string, string> }>(t, `SELECT metadata FROM audit_logs WHERE action = 'subscription.changed' AND metadata ->> 'reason' = 'PAID_PERIOD_STARTED'`);
    expect(row!.metadata).toMatchObject({ fromPlan: 'growth', plan: 'starter', actor: 'billing' });
  }, 30_000);

  it('#11 support subscription-set voids the open bills and clears a stop or a scheduled plan', async () => {
    const t = await signup(app, 'db46-set');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(5));
    await tick();
    const [renewal] = await bills(t);
    expect(renewal).toMatchObject({ kind: 'RENEWAL', status: 'OPEN' });
    await sql(t, `UPDATE subscriptions SET cancel_at_period_end = true, scheduled_plan_code = 'starter'`);
    await owner.query(`SELECT platform_change_subscription($1, 'growth', 'ACTIVE', null, $2, null, 'ops-staff46', 'Three months free for the pilot', 'T-4611')`,
      [await slugOf(t), inDays(90)]);
    expect((await bills(t)).map((b) => b.status)).toEqual(['VOID']);
    expect(await subscription(t)).toMatchObject({ status: 'ACTIVE', cancel_at_period_end: false, scheduled_plan_code: null });
  });

  it('#13 an upgrade worth less than ₱20 applies at once, without a bill', async () => {
    const t = await signup(app, 'db46-tiny');
    await setSubscription(t, 'growth', 'ACTIVE', new Date(Date.now() + 60 * 60_000));
    expect(await choose(t, 'enterprise')).toEqual({ effect: 'NOW' });
    expect(await bills(t)).toEqual([]);
    expect((await subscription(t)).plan_code).toBe('enterprise');
  });
});
