import type { INestApplication } from '@nestjs/common';
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

/** Simulates the (future) billing integration changing a subscription. */
async function setSubscription(t: SignedUp, plan: string, status: string, graceEndsAt: Date | null = null) {
  await owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [t.tenantId, plan, status, null, graceEndsAt]);
}

async function withEntity(t: SignedUp) {
  return (await http().post('/v1/legal-entities').set(bearer(t.access)).send({ registeredName: 'X Corp', vatStatus: 'VAT' }).expect(201)).body.id as string;
}

describe('subscription lifecycle', () => {
  it('starts every new business on a 14-day Growth trial with full access', async () => {
    const t = await signup(app, 'trial');
    const res = await http().get('/v1/subscription').set(bearer(t.access)).expect(200);
    expect(res.body).toMatchObject({ plan: { code: 'growth', features: ['multi_entity', 'advanced_reports'], extensions: expect.any(Array) }, status: 'TRIALING', access: 'FULL', usage: { maxUsers: 1, maxBranches: 0 } });
    // The trial ends 14 days after sign-up on the database clock, which may run a little ahead of this host's (Docker VM).
    const days = (new Date(res.body.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14 + 60 / 86_400);
  });

  it('becomes read-only (not deleted) when the trial lapses', async () => {
    const t = await signup(app, 'lapsed');
    const entityId = await withEntity(t);
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 second'`));
    const write = await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'B' }).expect(402);
    expect(write.body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    // Records stay readable.
    expect((await http().get('/v1/legal-entities').set(bearer(t.access)).expect(200)).body.data).toHaveLength(1);
    expect((await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body.access).toBe('READ_ONLY');
  });

  it('keeps full access while past due within grace, read-only after it, and after cancellation', async () => {
    const t = await signup(app, 'pastdue');
    const entityId = await withEntity(t);
    await setSubscription(t, 'growth', 'PAST_DUE', new Date(Date.now() + 86_400_000));
    await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'B' }).expect(201);
    // A minute back, not a second: the check uses the database clock, which may differ from this host's by about a second.
    await setSubscription(t, 'growth', 'PAST_DUE', new Date(Date.now() - 60_000));
    await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B2', name: 'B', birBranchCode: '00002' }).expect(402);
    await setSubscription(t, 'growth', 'CANCELED');
    await http().post('/v1/categories').set(bearer(t.access)).send({ name: 'x' }).expect(402);
    await setSubscription(t, 'growth', 'ACTIVE');
    await http().post('/v1/categories').set(bearer(t.access)).send({ name: 'x' }).expect(201);
  });

  it('tenants cannot change their own subscription', async () => {
    const t = await signup(app, 'selfupgrade');
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(appPool.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId])).rejects.toThrow(
        /permission denied/,
      );
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        await expect(c.query(`UPDATE subscriptions SET plan_code = 'enterprise'`)).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await appPool.end();
    }
  });

  it('subscription details are for owners/admins only', async () => {
    const t = await signup(app, 'subperm');
    const cashier = await loginToken(app, (await addMember(owner, t.tenantId, 'cashier')).email);
    await http().get('/v1/subscription').set(bearer(cashier)).expect(403);
    const admin = await loginToken(app, (await addMember(owner, t.tenantId, 'admin')).email);
    await http().get('/v1/subscription').set(bearer(admin)).expect(200);
  });

  it('every member learns from /me whether the business may make changes', async () => {
    const t = await signup(app, 'meaccess');
    const cashier = await loginToken(app, (await addMember(owner, t.tenantId, 'cashier')).email);
    expect((await http().get('/v1/me').set(bearer(cashier)).expect(200)).body.activeTenant.access).toBe('FULL');
    await setSubscription(t, 'growth', 'CANCELED');
    expect((await http().get('/v1/me').set(bearer(cashier)).expect(200)).body.activeTenant).toMatchObject({ access: 'READ_ONLY', status: 'ACTIVE' });
  });
});

describe('ops changes a subscription (support subscription-set, migration 0127)', () => {
  const slugOf = (t: SignedUp) => asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [t.tenantId])).rows[0]!.slug);
  const change = (slug: string, plan: string, status: string, dates: { trial?: Date; paid?: Date; grace?: Date } = {}, reason = 'Paid by bank transfer') =>
    owner.query('SELECT platform_change_subscription($1, $2, $3, $4, $5, $6, $7, $8, $9)', [slug, plan, status, dates.trial ?? null, dates.paid ?? null, dates.grace ?? null, 'ops-test', reason, 'T-1']);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

  it('refuses what makes no sense, and needs a reason and a ticket', async () => {
    const t = await signup(app, 'subops');
    const slug = await slugOf(t);
    const refused = async (p: Promise<unknown>, message: RegExp) => expect(String(await p.catch((e: Error) => e))).toMatch(message);
    await refused(change(slug, 'growth', 'ACTIVE', { paid: inDays(30) }, 'x'), /reason and ticket are required/);
    await refused(change('no-such-shop', 'growth', 'ACTIVE', { paid: inDays(30) }), /no business with the address/);
    await refused(change(slug, 'platinum', 'ACTIVE', { paid: inDays(30) }), /no active plan/);
    await refused(change(slug, 'growth', 'ACTIVE'), /paid until/);
    await refused(change(slug, 'growth', 'ACTIVE', { paid: inDays(-1) }), /paid until/);
    await refused(change(slug, 'growth', 'PAST_DUE'), /grace/);
    await refused(change(slug, 'growth', 'TRIALING', { trial: inDays(-1) }), /trial needs its end/);
    await refused(change(slug, 'growth', 'PAUSED'), /status must be/);
    // The runtime role cannot call it at all.
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(appPool.query(`SELECT platform_change_subscription($1, 'enterprise', 'ACTIVE', null, now() + interval '1 day', null, 'me', 'free upgrade', 'x')`, [slug])).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
    expect((await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body).toMatchObject({ plan: { code: 'growth' }, status: 'TRIALING' });
  });

  it('changes the plan and status, and writes it in the business’s own audit log', async () => {
    const t = await signup(app, 'subops2');
    const slug = await slugOf(t);
    await change(slug, 'growth', 'CANCELED', {}, 'Owner asked to leave');
    expect((await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body).toMatchObject({ status: 'CANCELED', access: 'READ_ONLY' });
    const paid = inDays(30);
    await change(slug, 'starter', 'ACTIVE', { paid });
    const sub = (await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body;
    expect(sub).toMatchObject({ plan: { code: 'starter' }, status: 'ACTIVE', access: 'FULL', graceEndsAt: null });
    expect(new Date(sub.currentPeriodEnd).getTime()).toBe(paid.getTime());
    await change(slug, 'growth', 'TRIALING', { trial: inDays(7) }, 'Trial extended for the pilot');
    expect((await http().get('/v1/subscription').set(bearer(t.access)).expect(200)).body).toMatchObject({ status: 'TRIALING', access: 'FULL' });

    const log = (await http().get('/v1/audit-logs?action=subscription').set(bearer(t.access)).expect(200)).body.data as { action: string; actorType: string; metadata: Record<string, unknown> }[];
    expect(log.map((r) => [r.action, r.actorType, r.metadata.fromStatus, r.metadata.status, r.metadata.plan, r.metadata.reason, r.metadata.ticket])).toEqual([
      ['subscription.changed', 'SYSTEM', 'ACTIVE', 'TRIALING', 'growth', 'Trial extended for the pilot', 'T-1'],
      ['subscription.changed', 'SYSTEM', 'CANCELED', 'ACTIVE', 'starter', 'Paid by bank transfer', 'T-1'],
      ['subscription.changed', 'SYSTEM', 'TRIALING', 'CANCELED', 'growth', 'Owner asked to leave', 'T-1'],
    ]);
  });
});

describe('plan limits', () => {
  it('caps branches on Starter and frees the seat when a branch is archived', async () => {
    const t = await signup(app, 'cap');
    const entityId = await withEntity(t);
    await setSubscription(t, 'starter', 'ACTIVE');
    const b1 = await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'B' }).expect(201);
    const over = await http()
      .post('/v1/branches')
      .set(bearer(t.access))
      .send({ legalEntityId: entityId, code: 'B2', name: 'B', birBranchCode: '00002' })
      .expect(403);
    expect(over.body.error).toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED', details: { limit: 'maxBranches', max: 1, used: 1 } });
    await http().post(`/v1/branches/${b1.body.id}/archive`).set(bearer(t.access)).expect(200);
    await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B2', name: 'B', birBranchCode: '00002' }).expect(201);
  });

  it('cannot be raced: parallel creations never exceed the cap', async () => {
    const t = await signup(app, 'race');
    const entityId = await withEntity(t);
    const branch = await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'B' }).expect(201);
    await setSubscription(t, 'starter', 'ACTIVE'); // maxRegisters = 2
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        http().post('/v1/registers').set(bearer(t.access)).send({ branchId: branch.body.id, code: `R${i}`, name: `R${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 403)).toHaveLength(4);
  });

  it('counts members plus pending invitations against the user cap', async () => {
    const t = await signup(app, 'seats');
    await setSubscription(t, 'starter', 'ACTIVE'); // maxUsers = 5 (owner + 4)
    const roles = (await http().get('/v1/roles').set(bearer(t.access)).expect(200)).body.data as { id: string; key: string }[];
    const cashier = roles.find((r) => r.key === 'cashier')!.id;
    const send = () =>
      http()
        .post('/v1/invitations')
        .set(bearer(t.access))
        .send({ email: `${uniq('seat')}@example.ph`, roles: [{ roleId: cashier, scopeType: 'TENANT', scopeId: null }] });
    for (let i = 0; i < 4; i++) expect((await send()).status).toBe(201);
    const fifth = await send();
    expect([fifth.status, fifth.body.error.code]).toEqual([403, 'ENTITLEMENT_LIMIT_REACHED']);
  });
});

describe('plan features (session 21 decision)', () => {
  it('analysis reports need advanced_reports (Growth, Enterprise); the everyday and statutory reports stay on Starter', async () => {
    const t = await signup(app, 'advrep');
    const entityId = await withEntity(t);
    const branchId = (await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entityId, code: 'B1', name: 'B' }).expect(201)).body.id as string;
    const day = new Date().toISOString().slice(0, 10);
    const range = `branchId=${branchId}&from=${day}&to=${day}`;
    const analysis = [`by-category?${range}`, `by-branch?from=${day}&to=${day}`, `discounts?${range}`, `purchases-by-supplier?${range}`];
    // Payment exceptions are a safety tool, on every plan (audit 2026-10-27 #39).
    const everyday = [`sales-summary?${range}`, `by-product?${range}`, `tax-summary?${range}`, `statutory-book?${range}`, `refund-watch?${range}`, `payment-exceptions?branchId=${branchId}`];
    await setSubscription(t, 'starter', 'ACTIVE');
    for (const path of analysis) {
      const res = await http().get(`/v1/reports/${path}`).set(bearer(t.access));
      expect([path, res.status, res.body.error?.code, res.body.error?.details?.feature]).toEqual([path, 403, 'ENTITLEMENT_REQUIRED', 'advanced_reports']);
    }
    for (const path of everyday) expect([path, (await http().get(`/v1/reports/${path}`).set(bearer(t.access))).status]).toEqual([path, 200]);
    await setSubscription(t, 'growth', 'ACTIVE');
    for (const path of analysis) expect([path, (await http().get(`/v1/reports/${path}`).set(bearer(t.access))).status]).toEqual([path, 200]);
  });

  it('a second legal entity needs multi_entity, even on a plan whose entity limit would allow it', async () => {
    const t = await signup(app, 'multient');
    await withEntity(t);
    // A plan with room for three entities but without the feature (the seeded Starter stops at its limit first).
    const code = uniq('noentities').toLowerCase();
    await owner.query(`INSERT INTO plans (code, name, monthly_price, currency, limits, features, active)
                       VALUES ($1, 'Test', '0', 'PHP', '{"maxLegalEntities":3,"maxBranches":3,"maxRegisters":3,"maxUsers":3}', '[]', false)`, [code]);
    await setSubscription(t, code, 'ACTIVE');
    const second = { registeredName: 'Y Corp', vatStatus: 'NON_VAT' };
    expect((await http().post('/v1/legal-entities').set(bearer(t.access)).send(second).expect(403)).body.error).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', details: { feature: 'multi_entity' } });
    await setSubscription(t, 'growth', 'ACTIVE');
    await http().post('/v1/legal-entities').set(bearer(t.access)).send(second).expect(201);
  });
});
