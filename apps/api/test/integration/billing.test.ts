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
    expect(res.body).toMatchObject({ plan: { code: 'growth' }, status: 'TRIALING', access: 'FULL', usage: { maxUsers: 1, maxBranches: 0 } });
    const days = (new Date(res.body.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
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
    await setSubscription(t, 'growth', 'PAST_DUE', new Date(Date.now() - 1000));
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
