import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadServerEnv } from '@1pos/config';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingContacts, billingMail } from '@1pos/database';
import { AppModule } from '../../src/app.module.js';
import { BillingProvider, type CheckoutRequest, type OpenedCheckout } from '../../src/billing/provider.js';
import { configureApp } from '../../src/bootstrap.js';
import { ENV } from '../../src/infrastructure/env.provider.js';
import { addMember, asOwnerInTenant, bearer, createApp, ensurePlanPrices, loginToken, ownerPool, signup, type SignedUp } from './helpers.js';

/**
 * Subscription billing (ADR-0027, migrations 0128–0129): bills, the owner's plan choices, payment pages,
 * provider webhooks, manual payments by ops and the hourly pass. Prices are the test ones (`PLAN_PRICES`).
 */
let app: INestApplication;
let owner: pg.Pool;
let appRole: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  appRole = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  await ensurePlanPrices(owner);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await appRole.end();
});

const sub = async (t: SignedUp) => (await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body;
const bills = async (t: SignedUp) => (await http().get('/v1/subscription/bills').set(bearer(t.access)).expect(200)).body.data as {
  id: string; number: string; kind: string; planCode: string; amount: string; vatAmount: string; status: string; periodStart: string; periodEnd: string; voidReason: string | null;
  payments: { amount: string; method: string; applied: boolean }[];
  receipt: { id: string; number: string } | null;
}[];
const choose = (t: SignedUp, planCode: string) => http().put('/v1/subscription/plan').set(bearer(t.access)).send({ planCode });
const slugOf = (t: SignedUp) => asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [t.tenantId])).rows[0]!.slug);
const setSubscription = (t: SignedUp, plan: string, status: string, periodEnd: Date | null, graceEndsAt: Date | null = null) =>
  owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [t.tenantId, plan, status, periodEnd, graceEndsAt]);
/** The hourly pass. It runs over every business in the test database; these tests only look at their own. */
const tick = async () => (await owner.query<{ r: Record<string, number> }>('SELECT platform_billing_tick() AS r')).rows[0]!.r;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
const days = (a: string | Date, b: string | Date) => (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

/** Pays a bill through the dev payment page, as the owner's browser would. */
async function payByPage(t: SignedUp, billId: string, method = 'GCASH') {
  const page = (await http().post(`/v1/subscription/bills/${billId}/checkout`).set(bearer(t.access)).expect(200)).body as { url: string; provider: string };
  expect(page.provider).toBe('DEV');
  const id = new URL(page.url).searchParams.get('id')!;
  const html = await http().get('/v1/billing/dev-checkout').query({ id }).expect(200);
  expect(html.text).toContain('Dev checkout');
  const paid = await http().post('/v1/billing/dev-checkout/pay').query({ id }).type('form').send({ method }).expect(303);
  expect(paid.headers.location).toMatch(/\/subscription\?paid=B-\d{6}$/);
  return id;
}

describe('plans and bills', () => {
  it('lists the plans with their prices and what the business has over each one’s limits', async () => {
    const t = await signup(app, 'bill-plans');
    const plans = (await http().get('/v1/subscription/plans').set(bearer(t.access)).expect(200)).body as { code: string; monthlyPrice: string; priced: boolean; current: boolean; overLimits: string[] }[];
    expect(plans.map((p) => [p.code, p.monthlyPrice, p.priced, p.current])).toEqual([
      ['starter', '499.0000', true, false],
      ['growth', '1499.0000', true, true],
      ['enterprise', '4999.0000', true, false],
    ]);
    expect(plans.every((p) => p.overLimits.length === 0)).toBe(true);
    expect(await sub(t)).toMatchObject({ plan: { code: 'growth', monthlyPrice: '1499.0000', currency: 'PHP' }, scheduledPlan: null, cancelAtPeriodEnd: false });
    expect(await bills(t)).toEqual([]);
  });

  it('a trial chooses a plan, pays on the payment page, and is paid until a month after the trial', async () => {
    const t = await signup(app, 'bill-trial');
    const trialEnds = (await sub(t)).trialEndsAt as string;
    const chosen = (await choose(t, 'starter').expect(200)).body;
    expect(chosen.effect).toBe('BILL');
    const [bill] = await bills(t);
    // Prices include 12% VAT (Tilvara is VAT-registered): 499 × 12/112 = 53.46.
    expect(bill).toMatchObject({ id: chosen.billId, number: 'B-000001', kind: 'START', planCode: 'starter', amount: '499.0000', vatAmount: '53.4600', status: 'OPEN' });
    // The owners' reminder above every page: the open bill to pay next.
    expect((await sub(t)).openBill).toMatchObject({ id: chosen.billId, number: 'B-000001', amount: '499.0000' });
    expect(new Date(bill!.periodStart).getTime()).toBe(new Date(trialEnds).getTime());
    // Choosing again replaces the open bill (one open bill for the period).
    const again = (await choose(t, 'growth').expect(200)).body;
    const list = await bills(t);
    expect(list.map((b) => [b.number, b.planCode, b.status])).toEqual([['B-000002', 'growth', 'OPEN'], ['B-000001', 'starter', 'VOID']]);
    // A double click opens one page.
    const first = (await http().post(`/v1/subscription/bills/${again.billId}/checkout`).set(bearer(t.access)).expect(200)).body.url;
    const second = (await http().post(`/v1/subscription/bills/${again.billId}/checkout`).set(bearer(t.access)).expect(200)).body.url;
    expect(second).toBe(first);
    await payByPage(t, again.billId);
    const after = await sub(t);
    expect(after).toMatchObject({ plan: { code: 'growth' }, status: 'ACTIVE', access: 'FULL', graceEndsAt: null });
    expect(days(after.currentPeriodEnd, trialEnds)).toBeGreaterThanOrEqual(28);
    expect(days(after.currentPeriodEnd, trialEnds)).toBeLessThanOrEqual(31);
    const [paid] = await bills(t);
    expect(paid).toMatchObject({ status: 'PAID', payments: [{ amount: '1499.0000', method: 'GCASH', applied: true }] });
    // A paid bill gets no new page.
    expect((await http().post(`/v1/subscription/bills/${again.billId}/checkout`).set(bearer(t.access)).expect(409)).body.error.code).toBe('BILL_NOT_OPEN');
    const actions = await asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'billing.%' OR action LIKE 'subscription.%' ORDER BY occurred_at, id`)).rows.map((r) => r.action));
    expect(actions).toEqual(expect.arrayContaining(['billing.bill_issued', 'billing.bill_voided', 'subscription.plan_chosen', 'billing.payment_recorded', 'billing.bill_paid', 'subscription.changed']));
  });

  it('a lapsed (read-only) business renews by itself: it chooses a plan and pays while read-only', async () => {
    const t = await signup(app, 'bill-lapsed');
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '20 days'`));
    expect((await http().post('/v1/categories').set(bearer(t.access)).send({ name: 'x' }).expect(402)).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    const chosen = (await choose(t, 'growth').expect(200)).body;
    const [bill] = await bills(t);
    // Starts today, not at the long-past trial end.
    expect(Math.abs(days(bill!.periodStart, new Date()))).toBeLessThan(0.01);
    await payByPage(t, chosen.billId, 'CARD');
    expect(await sub(t)).toMatchObject({ status: 'ACTIVE', access: 'FULL' });
    await http().post('/v1/categories').set(bearer(t.access)).send({ name: 'x' }).expect(201);
  });

  it('only the owner pays or changes the plan; a suspended business cannot; plans without a price are not billed', async () => {
    const t = await signup(app, 'bill-perm');
    const admin = await loginToken(app, (await addMember(owner, t.tenantId, 'admin')).email);
    const cashier = await loginToken(app, (await addMember(owner, t.tenantId, 'cashier')).email);
    await http().put('/v1/subscription/plan').set(bearer(cashier)).send({ planCode: 'growth' }).expect(403);
    await http().put('/v1/subscription/plan').set(bearer(admin)).send({ planCode: 'growth' }).expect(403);
    await http().get('/v1/subscription/bills').set(bearer(cashier)).expect(403);
    await http().get('/v1/subscription/bills').set(bearer(admin)).expect(200);
    expect((await choose(t, 'platinum').expect(422)).body.error.code).toBe('PLAN_NOT_AVAILABLE');
    const chosen = (await choose(t, 'growth').expect(200)).body;
    await http().post(`/v1/subscription/bills/${chosen.billId}/checkout`).set(bearer(admin)).expect(403);
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [t.tenantId]));
    try {
      expect((await choose(t, 'starter')).status).toBe(403);
      expect((await http().post(`/v1/subscription/bills/${chosen.billId}/checkout`).set(bearer(t.access))).status).toBe(403);
    } finally {
      await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE tenants SET status = 'ACTIVE' WHERE id = $1`, [t.tenantId]));
    }
    await owner.query(`SELECT platform_set_plan_price('starter', 0, 'tests', 'unpriced plan case')`);
    try {
      expect((await choose(t, 'starter').expect(409)).body.error.code).toBe('PLAN_NOT_PRICED');
      expect((await http().get('/v1/subscription/plans').set(bearer(t.access)).expect(200)).body.find((p: { code: string }) => p.code === 'starter').priced).toBe(false);
    } finally {
      await ensurePlanPrices(owner);
    }
  });

  it('refuses a plan smaller than what the business already has', async () => {
    const t = await signup(app, 'bill-limits');
    const entityId = (await http().post('/v1/legal-entities').set(bearer(t.access)).send({ registeredName: 'X Corp', vatStatus: 'VAT' }).expect(201)).body.id;
    await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'One' }).expect(201);
    await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B2', name: 'Two', birBranchCode: '00002' }).expect(201);
    const refused = (await choose(t, 'starter').expect(409)).body.error;
    expect(refused).toMatchObject({ code: 'PLAN_LIMITS_EXCEEDED', details: { limit: 'maxBranches', max: 1, used: 2 } });
    const plans = (await http().get('/v1/subscription/plans').set(bearer(t.access)).expect(200)).body as { code: string; overLimits: string[] }[];
    expect(plans.find((p) => p.code === 'starter')!.overLimits).toEqual(['maxBranches']);
  });
});

describe('a paid period: upgrades, downgrades, renewals, grace and cancellation', () => {
  it('an upgrade is billed for the rest of the period and applies when paid', async () => {
    const t = await signup(app, 'bill-upgrade');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(15));
    const chosen = (await choose(t, 'enterprise').expect(200)).body;
    expect(chosen.effect).toBe('BILL');
    const [bill] = await bills(t);
    expect(bill).toMatchObject({ kind: 'UPGRADE', planCode: 'enterprise', status: 'OPEN' });
    // (4999 − 1499) × about 15/30.
    expect(Number(bill!.amount)).toBeGreaterThan(1650);
    expect(Number(bill!.amount)).toBeLessThan(1850);
    expect((await sub(t)).plan.code).toBe('growth');
    await payByPage(t, bill!.id);
    const after = await sub(t);
    expect(after).toMatchObject({ plan: { code: 'enterprise' }, status: 'ACTIVE' });
    expect(Math.abs(days(after.currentPeriodEnd, inDays(15)))).toBeLessThan(0.01);
  });

  it('a cheaper plan starts at renewal; the renewal bill, past due with grace, then paid', async () => {
    const t = await signup(app, 'bill-renew');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(20));
    expect((await choose(t, 'starter').expect(200)).body.effect).toBe('AT_RENEWAL');
    expect(await sub(t)).toMatchObject({ plan: { code: 'growth' }, scheduledPlan: { code: 'starter', name: 'Starter' } });
    expect(await bills(t)).toEqual([]);
    // Five days before the paid-until date the pass issues the renewal, for the chosen plan.
    await setSubscription(t, 'growth', 'ACTIVE', inDays(5));
    await tick();
    const [renewal] = await bills(t);
    expect(renewal).toMatchObject({ kind: 'RENEWAL', planCode: 'starter', amount: '499.0000', status: 'OPEN' });
    await tick();
    expect(await bills(t)).toHaveLength(1);
    // The date passes unpaid: past due, a week of grace, still writable.
    const periodEnd = new Date(Date.now() - 60_000);
    await setSubscription(t, 'growth', 'ACTIVE', periodEnd);
    await tick();
    const late = await sub(t);
    expect(late).toMatchObject({ status: 'PAST_DUE', access: 'FULL' });
    expect(Math.abs(days(late.graceEndsAt, inDays(7)))).toBeLessThan(0.01);
    await http().post('/v1/categories').set(bearer(t.access)).send({ name: 'x' }).expect(201);
    // Paid within grace: the period runs from the bill's start, on the new plan. The test moved the paid-until
    // date back by hand after the bill was issued, so the bill's period has not started yet: Starter waits for it
    // (a bill paid ahead keeps the plan in force until its period starts, audit 2026-10-31 #10).
    await payByPage(t, renewal!.id);
    const after = await sub(t);
    expect(after).toMatchObject({ plan: { code: 'growth' }, status: 'ACTIVE', scheduledPlan: { code: 'starter' }, graceEndsAt: null });
    expect(new Date(after.currentPeriodEnd).getTime()).toBe(new Date(renewal!.periodEnd).getTime());
    const mails = await asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ topic: string }>(`SELECT topic FROM outbox_events WHERE topic LIKE 'billing.%' ORDER BY created_at`)).rows.map((r) => r.topic));
    expect(mails).toEqual(['billing.bill_issued', 'billing.past_due', 'billing.receipt_issued']);
  });

  it('after grace the business is read-only until it pays; an ACTIVE subscription a week past its date is too', async () => {
    const t = await signup(app, 'bill-grace');
    await setSubscription(t, 'growth', 'PAST_DUE', inDays(-30), new Date(Date.now() - 60_000));
    expect((await sub(t)).access).toBe('READ_ONLY');
    await tick(); // a lapsed subscription gets no renewal bill: the owner chooses a plan
    expect(await bills(t)).toEqual([]);
    const chosen = (await choose(t, 'growth').expect(200)).body;
    const [bill] = await bills(t);
    expect(bill!.kind).toBe('START');
    await payByPage(t, chosen.billId);
    const after = await sub(t);
    expect(after.access).toBe('FULL');
    expect(days(after.currentPeriodEnd, new Date())).toBeGreaterThan(27);
    // If the hourly pass stopped, ACTIVE still ends a week past the paid-until date.
    await setSubscription(t, 'growth', 'ACTIVE', inDays(-6));
    expect((await sub(t)).access).toBe('FULL');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(-8));
    expect((await sub(t)).access).toBe('READ_ONLY');
  });

  it('stopping at the period end voids the renewal and ends CANCELED; resuming issues it again', async () => {
    const t = await signup(app, 'bill-cancel');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(3));
    await tick();
    expect((await bills(t))[0]).toMatchObject({ kind: 'RENEWAL', status: 'OPEN' });
    await http().put('/v1/subscription/cancel').set(bearer(t.access)).send({ cancel: true }).expect(200);
    expect(await sub(t)).toMatchObject({ cancelAtPeriodEnd: true });
    expect((await bills(t))[0]).toMatchObject({ status: 'VOID', voidReason: 'canceled by the owner' });
    await http().put('/v1/subscription/cancel').set(bearer(t.access)).send({ cancel: false }).expect(200);
    expect((await bills(t)).map((b) => b.status)).toEqual(['OPEN', 'VOID']);
    await http().put('/v1/subscription/cancel').set(bearer(t.access)).send({ cancel: true }).expect(200);
    await setSubscription(t, 'growth', 'ACTIVE', new Date(Date.now() - 60_000));
    await tick();
    expect(await sub(t)).toMatchObject({ status: 'CANCELED', access: 'READ_ONLY' });
    // A trial cannot "stop at the period end": it has none.
    const trial = await signup(app, 'bill-cancel-trial');
    expect((await http().put('/v1/subscription/cancel').set(bearer(trial.access)).send({ cancel: true }).expect(409)).body.error.code).toBe('NOT_ACTIVE');
  });

  it('a trial ending within three days gets its first bill once', async () => {
    const t = await signup(app, 'bill-trial-end');
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE subscriptions SET trial_ends_at = now() + interval '2 days'`));
    await tick();
    await tick();
    expect((await bills(t)).map((b) => [b.kind, b.planCode, b.status])).toEqual([['START', 'growth', 'OPEN']]);
  });
});

describe('receipts (system-generated, emailed, kept in the app)', () => {
  it('a paid bill gets one receipt, numbered in Tilvara’s series, with the VAT and both parties as they were', async () => {
    const t = await signup(app, 'bill-receipt');
    const entityId = (await http().post('/v1/legal-entities').set(bearer(t.access)).send({ registeredName: 'Sari Corp', vatStatus: 'VAT', tin: '123456789', registeredAddress: '1 Rizal St, Manila' }).expect(201)).body.id;
    expect(entityId).toBeDefined();
    const chosen = (await choose(t, 'growth').expect(200)).body;
    expect((await bills(t))[0]!.receipt).toBeNull();
    await payByPage(t, chosen.billId, 'MAYA');
    const [bill] = await bills(t);
    expect(bill!.receipt!.number).toMatch(/^R-\d{8}$/);
    const receipt = (await http().get(`/v1/subscription/receipts/${bill!.receipt!.id}`).set(bearer(t.access)).expect(200)).body;
    expect(receipt).toMatchObject({
      number: bill!.receipt!.number,
      billNumber: 'B-000001',
      amount: '1499.0000',
      vatableAmount: '1338.3900',
      vatAmount: '160.6100',
      currency: 'PHP',
      method: 'MAYA',
      seller: { registeredName: expect.any(String), vatRegistered: true },
      buyer: { registeredName: 'Sari Corp', tin: '123456789', address: '1 Rizal St, Manila' },
      description: expect.stringMatching(/^Tilvara Growth plan, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(bill B-000001\)$/),
    });
    // Mailed to the owners (outbox), worded as a receipt.
    const events = await asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ payload: { receiptId: string } }>(`SELECT payload FROM outbox_events WHERE topic = 'billing.receipt_issued'`)).rows);
    expect(events.map((e) => e.payload.receiptId)).toEqual([receipt.id]);
    const worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
    try {
      const c = await worker.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        const mail = await billingMail(c, 'billing.receipt_issued', { receiptId: receipt.id });
        expect(mail!.subject).toBe(`Tilvara receipt ${receipt.number}: PHP 1499.00 received`);
        for (const line of [`RECEIPT ${receipt.number}`, 'Received from: Sari Corp', 'VATable sales: PHP 1338.39', 'VAT (12%): PHP 160.61', 'Total: PHP 1499.00', 'Paid by maya', 'System-generated receipt']) {
          expect(mail!.text).toContain(line);
        }
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await worker.end();
    }
    // Never changed afterwards, even by the platform role.
    await expect(asOwnerInTenant(owner, t.tenantId, (o) => o.query(`UPDATE billing_receipts SET amount = 1`))).rejects.toThrow();
    // Someone else's receipt id is not found.
    const other = await signup(app, 'bill-receipt-other');
    await http().get(`/v1/subscription/receipts/${receipt.id}`).set(bearer(other.access)).expect(404);
  });

  it('a payment by bank transfer gets its receipt too; money that settled nothing gets none; numbers follow one another', async () => {
    const t = await signup(app, 'bill-receipt-ops');
    const slug = await slugOf(t);
    await choose(t, 'starter').expect(200);
    const record = (amount: string, ref: string) =>
      owner.query(`SELECT platform_billing_record_payment($1, 'B-000001', $2, 'BANK_TRANSFER', $3, now(), 'ops-test', 'Seen on the statement', 'T-12')`, [slug, amount, `${ref}-${slug}`]);
    await record('10.00', 'short');
    expect((await bills(t))[0]!.receipt).toBeNull();
    await record('499.00', 'full');
    const [bill] = await bills(t);
    const receipt = (await http().get(`/v1/subscription/receipts/${bill!.receipt!.id}`).set(bearer(t.access)).expect(200)).body;
    expect(receipt).toMatchObject({ method: 'BANK_TRANSFER', amount: '499.0000', vatAmount: '53.4600', vatableAmount: '445.5400' });
    // The next receipt, for another business, takes the next number in the one series.
    const t2 = await signup(app, 'bill-receipt-next');
    const chosen2 = (await choose(t2, 'starter').expect(200)).body;
    await payByPage(t2, chosen2.billId);
    const next = (await bills(t2))[0]!.receipt!.number;
    expect(Number(next.slice(2))).toBe(Number(receipt.number.slice(2)) + 1);
  });

  it('ops sets Tilvara’s details for receipts from now on; the runtime role cannot', async () => {
    const before = (await owner.query('SELECT * FROM platform_billing_seller()')).rows[0];
    try {
      await owner.query(`SELECT platform_set_billing_seller('Tilvara Technologies Inc.', 'Tilvara', '123-456-789-00000', 'Makati City', true, 'Test permit line', 'ops-test', 'Registration details for tests')`);
      const t = await signup(app, 'bill-seller');
      const chosen = (await choose(t, 'growth').expect(200)).body;
      await payByPage(t, chosen.billId);
      const [bill] = await bills(t);
      const receipt = (await http().get(`/v1/subscription/receipts/${bill!.receipt!.id}`).set(bearer(t.access)).expect(200)).body;
      expect(receipt.seller).toEqual({ registeredName: 'Tilvara Technologies Inc.', tradeName: 'Tilvara', tin: '123-456-789-00000', address: 'Makati City', vatRegistered: true, permitNote: 'Test permit line' });
      await expect(owner.query(`SELECT platform_set_billing_seller('X', null, 'not-a-tin', null, true, null, 'ops', 'bad tin here')`)).rejects.toThrow(/TIN/);
      await expect(appRole.query(`SELECT platform_set_billing_seller('X', null, null, null, true, null, 'me', 'take over')`)).rejects.toThrow(/permission denied/);
      await expect(appRole.query(`SELECT * FROM billing_seller`)).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query(`SELECT platform_set_billing_seller($1, $2, $3, $4, $5, $6, 'ops-test', 'Put back after the test')`, [
        before.registered_name, before.trade_name, before.tin, before.address, before.vat_registered, before.permit_note,
      ]);
    }
  });
});

describe('reminders before a bill is due', () => {
  /** Moves an open bill's dates as if it had been issued earlier (the guard keeps them fixed otherwise). */
  const backdate = async (t: SignedUp, billId: string, issuedAgo: string, dueIn: string) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      await c.query('ALTER TABLE billing_bills DISABLE TRIGGER billing_bills_guard');
      await c.query(`UPDATE billing_bills SET issued_at = now() - $2::interval, due_at = now() + $3::interval WHERE id = $1`, [billId, issuedAgo, dueIn]);
      await c.query('ALTER TABLE billing_bills ENABLE TRIGGER billing_bills_guard');
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };
  const reminders = (t: SignedUp) =>
    asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ when: string }>(`SELECT payload->>'when' AS when FROM outbox_events WHERE topic = 'billing.reminder' ORDER BY created_at`)).rows.map((r) => r.when));

  it('mails three days before and the day before the due date, once each; nothing for a bill just issued or paid', async () => {
    const t = await signup(app, 'bill-remind');
    await setSubscription(t, 'growth', 'ACTIVE', inDays(6));
    await tick();
    const [bill] = await bills(t);
    // Issued an hour ago and due in two and a half days: just mailed, so no reminder yet.
    await backdate(t, bill!.id, '1 hour', '60 hours');
    await tick();
    expect(await reminders(t)).toEqual([]);
    await backdate(t, bill!.id, '4 days', '60 hours');
    await tick();
    await tick();
    expect(await reminders(t)).toEqual(['EARLY']);
    await backdate(t, bill!.id, '6 days', '20 hours');
    await tick();
    await tick();
    expect(await reminders(t)).toEqual(['EARLY', 'LAST']);
    const worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
    try {
      const c = await worker.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        const mail = await billingMail(c, 'billing.reminder', { billId: bill!.id, when: 'LAST' });
        expect(mail!.subject).toBe(`Reminder: Tilvara bill ${bill!.number} is due tomorrow`);
        expect(mail!.text).toContain('VAT included: PHP 160.61');
        expect(mail!.text).toContain('a part payment does not settle a bill');
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await worker.end();
    }
    // Paid: no reminder, and nothing left to remind of above the pages.
    await payByPage(t, bill!.id);
    expect((await sub(t)).openBill).toBeNull();
  });
});

describe('payments recorded by ops (support billing-payment)', () => {
  it('the exact amount settles the bill; any other is kept unapplied; the same reference is recorded once', async () => {
    const t = await signup(app, 'bill-manual');
    const slug = await slugOf(t);
    const chosen = (await choose(t, 'growth').expect(200)).body;
    const [bill] = await bills(t);
    const record = (amount: string, reference: string) =>
      owner.query<{ v: string }>(`SELECT platform_billing_record_payment($1, $2, $3, 'BANK_TRANSFER', $4, now(), 'ops-test', 'Checked the bank statement', 'T-9') AS v`, [slug, bill!.number, amount, reference]).then((r) => r.rows[0]!.v);
    const refused = async (p: Promise<unknown>, message: RegExp) => expect(String(await p.catch((e: Error) => e))).toMatch(message);
    await refused(owner.query(`SELECT platform_billing_record_payment($1, $2, 1499, 'BANK_TRANSFER', 'R', now(), 'ops', 'x', 'T')`, [slug, bill!.number]), /reason and ticket/);
    await refused(owner.query(`SELECT platform_billing_record_payment($1, 'B-999999', 1499, 'BANK_TRANSFER', 'R', now(), 'ops', 'checked', 'T')`, [slug]), /no bill/);
    expect(await record('1000.00', 'BDO-1')).toBe('UNAPPLIED');
    expect((await sub(t)).status).toBe('TRIALING');
    expect(await record('1499.00', 'BDO-2')).toBe('APPLIED');
    expect(await record('1499.00', 'BDO-2')).toBe('DUPLICATE');
    expect(await record('1499.00', 'BDO-3')).toBe('UNAPPLIED'); // paid twice: kept for a refund
    expect((await sub(t)).status).toBe('ACTIVE');
    const [paid] = await bills(t);
    expect(paid!.id).toBe(chosen.billId);
    expect(paid!.payments.map((p) => [p.amount, p.applied])).toEqual([['1000.0000', false], ['1499.0000', true], ['1499.0000', false]]);
    const listed = (await owner.query<{ number: string; received: string; unapplied: string }>('SELECT number, received, unapplied FROM platform_billing_bills($1)', [slug])).rows;
    expect(listed).toEqual([{ number: bill!.number, received: '1499.0000', unapplied: '2499.0000' }]);
  });

  it('ops voids an open bill, never a paid one', async () => {
    const t = await signup(app, 'bill-void');
    const slug = await slugOf(t);
    await choose(t, 'growth').expect(200);
    await owner.query(`SELECT platform_billing_void_bill($1, 'B-000001', 'ops-test', 'Waived for the pilot', 'T-10')`, [slug]);
    expect((await bills(t))[0]).toMatchObject({ status: 'VOID', voidReason: 'voided by Tilvara support' });
    await expect(owner.query(`SELECT platform_billing_void_bill($1, 'B-000001', 'ops-test', 'Waived again', 'T-10')`, [slug])).rejects.toThrow(/only an open bill/);
  });
});

describe('the business cannot pay itself', () => {
  it('the runtime role reads its bills but writes none, and cannot run the billing steps', async () => {
    const t = await signup(app, 'bill-self');
    await choose(t, 'growth').expect(200);
    const c = await appRole.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      const { rows: [bill] } = await c.query<{ id: string }>('SELECT id FROM billing_bills');
      expect(bill).toBeDefined();
      for (const attempt of [
        `UPDATE billing_bills SET status = 'PAID', paid_at = now()`,
        `INSERT INTO billing_payments (tenant_id, bill_id, amount, currency, method, provider, reference, applied, recorded_by, received_at) VALUES ('${t.tenantId}', '${bill!.id}', 1499, 'PHP', 'CASH', 'MANUAL', 'x', true, 'me', now())`,
        `SELECT billing_settle('${bill!.id}', 'me')`,
        `SELECT billing_take_payment('${bill!.id}', 1499, 'PHP', 'CASH', 'MANUAL', 'x', now(), 'me', null)`,
        `SELECT platform_billing_tick()`,
        `SELECT platform_billing_record_payment('x', 'B-000001', 1499, 'CASH', 'x', now(), 'me', 'free money', 't')`,
        `SELECT platform_set_plan_price('growth', 0, 'me', 'free plan')`,
        `SELECT * FROM billing_provider_events`,
      ]) {
        await c.query('SAVEPOINT s');
        await expect(c.query(attempt), attempt).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    // A paid bill never changes again, even for the platform role.
    await expect(asOwnerInTenant(owner, t.tenantId, (o) => o.query(`UPDATE billing_bills SET amount = 1`))).rejects.toThrow(/only a bill's status changes|cannot change/);
  });

  it('a provider event pays only a checkout Tilvara opened, once, for the exact amount', async () => {
    const t = await signup(app, 'bill-events');
    const chosen = (await choose(t, 'growth').expect(200)).body;
    const pageId = new URL((await http().post(`/v1/subscription/bills/${chosen.billId}/checkout`).set(bearer(t.access)).expect(200)).body.url).searchParams.get('id')!;
    // Event ids and references are global: unique per run (the test database is kept between runs).
    const run = randomUUID().slice(0, 8);
    const apply = (eventId: string, checkoutId: string, ref: string, amount: string) =>
      appRole.query<{ o: string }>(`SELECT billing_apply_provider_payment('DEV', $1, 'checkout_session.payment.paid', $2, $3, $4, 'PHP', 'GCASH') AS o`, [`${run}-${eventId}`, checkoutId, `${run}-${ref}`, amount]).then((r) => r.rows[0]!.o);
    expect(await apply('evt-1', 'cs_not_ours', 'pay-1', '1499.00')).toBe('UNKNOWN_CHECKOUT');
    expect(await apply('evt-2', pageId, 'pay-2', '1.00')).toBe('UNAPPLIED');
    expect((await sub(t)).status).toBe('TRIALING');
    expect(await apply('evt-3', pageId, 'pay-3', '1499.00')).toBe('APPLIED');
    expect(await apply('evt-3', pageId, 'pay-3', '1499.00')).toBe('DUPLICATE');
    expect(await apply('evt-4', pageId, 'pay-3', '1499.00')).toBe('DUPLICATE');
    expect((await sub(t)).status).toBe('ACTIVE');
  });
});

/** A stand-in for PayMongo's checkout API: the webhook path is the real one, signature and all. */
class FakePayMongo extends BillingProvider {
  readonly code = 'PAYMONGO' as const;
  readonly opened: CheckoutRequest[] = [];
  async openCheckout(req: CheckoutRequest): Promise<OpenedCheckout> {
    this.opened.push(req);
    return { provider: 'PAYMONGO', checkoutId: `cs_${randomUUID().replace(/-/g, '')}`, url: 'https://checkout.paymongo.com/cs_test', expiresAt: new Date(Date.now() + 3_600_000) };
  }
}

describe('PayMongo webhook (signature checked over the raw body)', () => {
  const SECRET = 'whsk_test_billing_secret';
  let pm: INestApplication;
  let fake: FakePayMongo;
  const send = (body: unknown, opts: { secret?: string; t?: number; header?: string } = {}) => {
    const raw = JSON.stringify(body);
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${t}.${raw}`).digest('hex');
    return request(pm.getHttpServer()).post('/v1/billing/webhooks/paymongo').set('content-type', 'application/json')
      .set('paymongo-signature', opts.header ?? `t=${t},te=${sig},li=`).send(raw);
  };
  const paidEvent = (eventId: string, checkoutId: string, centavos: number) => ({
    data: { id: eventId, type: 'event', attributes: { type: 'checkout_session.payment.paid', livemode: false, data: {
      id: checkoutId, type: 'checkout_session',
      attributes: { payments: [{ id: `pay_${eventId}`, type: 'payment', attributes: { amount: centavos, currency: 'PHP', status: 'paid', source: { type: 'gcash' } } }] },
    } } },
  });

  beforeAll(async () => {
    fake = new FakePayMongo();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue({ ...loadServerEnv(), BILLING_PROVIDER: 'paymongo', PAYMONGO_SECRET_KEY: 'sk_test_x', PAYMONGO_WEBHOOK_SECRET: SECRET, APP_PUBLIC_URL: 'https://app.tilvara.test', SHOP_DOMAIN: 'tilvara.test' })
      .overrideProvider(BillingProvider).useValue(fake)
      .compile();
    pm = moduleRef.createNestApplication();
    configureApp(pm);
    await pm.init();
  });

  afterAll(async () => {
    await pm.close();
  });

  it('refuses a missing, wrong or stale signature; applies a good one once', async () => {
    const t = await signup(pm, 'bill-paymongo');
    const chosen = (await request(pm.getHttpServer()).put('/v1/subscription/plan').set(bearer(t.access)).send({ planCode: 'growth' }).expect(200)).body;
    const page = (await request(pm.getHttpServer()).post(`/v1/subscription/bills/${chosen.billId}/checkout`).set(bearer(t.access)).expect(200)).body;
    expect(page).toEqual({ url: 'https://checkout.paymongo.com/cs_test', provider: 'PAYMONGO' });
    expect(fake.opened[0]).toMatchObject({ number: 'B-000001', amount: '1499.0000', currency: 'PHP' });
    const [checkout] = await asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ provider_checkout_id: string }>(`SELECT provider_checkout_id FROM billing_checkouts`)).rows);
    const event = paidEvent(`evt_${randomUUID().slice(0, 8)}`, checkout!.provider_checkout_id, 149900);
    await send(event, { header: '' }).expect(401);
    await send(event, { secret: 'whsk_wrong' }).expect(401);
    await send(event, { t: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    expect((await sub(t)).status).toBe('TRIALING');
    expect((await send(event).expect(200)).body).toEqual({ received: true, outcome: 'APPLIED' });
    expect((await send(event).expect(200)).body).toEqual({ received: true, outcome: 'DUPLICATE' });
    expect((await request(pm.getHttpServer()).get('/v1/subscription').set(bearer(t.access)).expect(200)).body).toMatchObject({ status: 'ACTIVE', access: 'FULL' });
    // Events that pay nothing are acknowledged and ignored.
    expect((await send({ data: { id: 'evt_other', attributes: { type: 'payment.failed', livemode: false, data: {} } } }).expect(200)).body.outcome).toBe('IGNORED');
    // The dev page does not exist with PayMongo.
    await request(pm.getHttpServer()).get('/v1/billing/dev-checkout').query({ id: 'dev_cs_x' }).expect(404);
  });

  it('the payment page sends the owner back to the shop’s own address when it has one, else to the main admin', async () => {
    const pmHttp = () => request(pm.getHttpServer());
    const t = await signup(pm, 'billret');
    const slug = await slugOf(t);
    const open = async () => {
      const chosen = (await pmHttp().put('/v1/subscription/plan').set(bearer(t.access)).send({ planCode: 'growth' }).expect(200)).body;
      await pmHttp().post(`/v1/subscription/bills/${chosen.billId}/checkout`).set(bearer(t.access)).expect(200);
      return fake.opened.at(-1)!;
    };
    expect(await open()).toMatchObject({ successUrl: expect.stringMatching(/^https:\/\/app\.tilvara\.test\/subscription\?paid=B-\d{6}$/), cancelUrl: 'https://app.tilvara.test/subscription' });
    await pmHttp().put('/v1/business/branding').set(bearer(t.access)).send({ publicSignIn: true }).expect(200);
    await owner.query(`SELECT platform_billing_void_bill($1, 'B-000001', 'ops-test', 'Reopen for the test', 'T-11')`, [slug]);
    expect(await open()).toMatchObject({ successUrl: `https://${slug}.tilvara.test/subscription?paid=B-000002`, cancelUrl: `https://${slug}.tilvara.test/subscription` });
  });

  it('the dev app has no PayMongo webhook', async () => {
    await http().post('/v1/billing/webhooks/paymongo').send({}).expect(404);
  });
});

describe('the worker tells the owners (billing mails, as onepos_worker)', () => {
  it('a new bill mails the owner, not the cashier; a paid bill says nothing more', async () => {
    const t = await signup(app, 'bill-mail');
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const chosen = (await choose(t, 'growth').expect(200)).body;
    const worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
    const asWorker = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
      const c = await worker.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        const r = await fn(c);
        await c.query('ROLLBACK');
        return r;
      } finally {
        c.release();
      }
    };
    try {
      const contacts = await asWorker((c) => billingContacts(c));
      expect(contacts.map((x) => x.email)).toEqual([t.email]);
      expect(contacts.map((x) => x.email)).not.toContain(cashier.email);
      const mail = await asWorker((c) => billingMail(c, 'billing.bill_issued', { billId: chosen.billId }));
      expect(mail).toMatchObject({ subject: 'Tilvara bill B-000001: PHP 1499.00' });
      expect(mail!.text).toContain('The receipt is emailed once it is paid');
      expect(await asWorker((c) => billingMail(c, 'billing.past_due', {}))).toBeNull();
      await payByPage(t, chosen.billId);
      expect(await asWorker((c) => billingMail(c, 'billing.bill_issued', { billId: chosen.billId }))).toBeNull();
    } finally {
      await worker.end();
    }
  });
});
