import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, type SignedUp } from './helpers.js';

/** API keys and webhooks (session 20, SPEC §6.11, ADR-0019). */
let app: INestApplication;
let strict: INestApplication;
let owner: pg.Pool;
let runtime: pg.Pool;
const http = (a: INestApplication = app) => request(a.getHttpServer());
type Auth = { Authorization: string };

const plan = (t: SignedUp, code: string) => owner.query(`SELECT platform_set_subscription($1, $2, 'ACTIVE', null, null)`, [t.tenantId, code]);
const withKey = (key: string) => ({ Authorization: `ApiKey ${key}` });

let a: SignedUp;
let auth: Auth;
let b: SignedUp;
let branchA: string;

beforeAll(async () => {
  app = await createApp({ WEBHOOK_ALLOW_INSECURE: true });
  strict = await createApp({ WEBHOOK_ALLOW_INSECURE: false });
  owner = ownerPool();
  runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  a = await signup(app, 'intg-a');
  auth = bearer(a.access);
  b = await signup(app, 'intg-b');
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Integrations Corp', vatStatus: 'VAT' }).expect(201)).body.id;
  branchA = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id;
});

afterAll(async () => {
  await app.close();
  await strict.close();
  await owner.end();
  await runtime.end();
});

describe('API keys', () => {
  it('only on a plan with API access, only for integrations.manage; shown once, stored as a hash', async () => {
    expect((await http().post('/v1/api-keys').set(auth).send({ name: 'Accounting', scopes: ['reports.read'] }).expect(403)).body.error.code).toBe('ENTITLEMENT_REQUIRED');
    await plan(a, 'enterprise');
    const manager = bearer(await loginToken(app, (await addMember(owner, a.tenantId, 'branch_manager')).email));
    await http().post('/v1/api-keys').set(manager).send({ name: 'x', scopes: ['reports.read'] }).expect(403);
    await http().post('/v1/api-keys').set(auth).send({ name: 'x', scopes: ['members.read'] }).expect(400);

    const made = (await http().post('/v1/api-keys').set(auth).send({ name: 'Accounting', scopes: ['org.read', 'reports.read'] }).expect(201)).body;
    expect(made.key).toMatch(/^tlv_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/);
    expect(made.key.startsWith(`tlv_${made.prefix}_`)).toBe(true);
    const listed = (await http().get('/v1/api-keys').set(auth).expect(200)).body.data;
    expect(listed).toEqual([expect.objectContaining({ id: made.id, prefix: made.prefix, scopes: ['org.read', 'reports.read'], revokedAt: null })]);
    expect(JSON.stringify(listed)).not.toContain(made.key);
    // The runtime role cannot read the hash; the audit log names the key by prefix only.
    const c = await runtime.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      expect(String(await c.query('SELECT key_hash FROM api_keys').catch((e: Error) => e))).toMatch(/permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const audit = await asOwnerInTenant(owner, a.tenantId, async (x) => (await x.query(`SELECT metadata FROM audit_logs WHERE action = 'api_key.created'`)).rows);
    expect(JSON.stringify(audit)).not.toContain(made.key.slice(16));

    // ---- using it: reads within its scopes, nothing else ----
    const key = withKey(made.key);
    expect((await http().get('/v1/branches').set(key).expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual([branchA]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await http().get('/v1/reports/sales-summary').query({ branchId: branchA, from: today, to: today }).set(key).expect(200);
    expect((await http().get('/v1/members').set(key).expect(403)).body.error.code).toBe('FORBIDDEN');
    // Routes about the signed-in person (their account, their other businesses) are not the key's.
    for (const path of ['/v1/me', '/v1/auth/mfa', '/v1/auth/account/closure', '/v1/support/grants']) {
      expect((await http().get(path).set(key).expect(403)).body.error.code, path).toBe('FORBIDDEN');
    }
    expect((await http().post('/v1/branches').set(key).send({ legalEntityId: randomUUID(), code: 'X', name: 'x' }).expect(403)).body.error.code).toBe('API_KEY_READ_ONLY');
    await http().get('/v1/branches').set(withKey(made.key.replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A')))).expect(401);
    await http().get('/v1/branches').set(withKey('tlv_short_x')).expect(401);
    // B's view of the world never includes A's records, whatever key it holds.
    await plan(b, 'enterprise');
    const bKey = (await http().post('/v1/api-keys').set(bearer(b.access)).send({ name: 'B', scopes: ['org.read'] }).expect(201)).body.key;
    expect((await http().get('/v1/branches').set(withKey(bKey)).expect(200)).body.data).toEqual([]);
    expect((await http().get(`/v1/branches/${branchA}/inventory-settings`).set(withKey(bKey)).expect((r) => expect([403, 404]).toContain(r.status))).status).not.toBe(200);
    const used = (await http().get('/v1/api-keys').set(auth).expect(200)).body.data[0];
    expect(used.lastUsedAt).toBeTruthy();

    // A downgrade stops the key; revoking ends it for good.
    await plan(a, 'growth');
    expect((await http().get('/v1/branches').set(key).expect(403)).body.error.code).toBe('ENTITLEMENT_REQUIRED');
    await plan(a, 'enterprise');
    await http().post(`/v1/api-keys/${made.id}/revoke`).set(auth).expect(200);
    await http().get('/v1/branches').set(key).expect(401);
    expect(String(await asOwnerInTenant(owner, a.tenantId, (x) => x.query(`UPDATE api_keys SET revoked_at = NULL, revoked_by = NULL WHERE id = $1`, [made.id])).catch((e: Error) => e))).toMatch(/only revoked, once/);
  });

  it('a key never reads more than its maker holds business-wide (SCOPE_NOT_HELD)', async () => {
    await plan(a, 'enterprise');
    // integrations.manage business-wide, customers.read at one branch only, no reports.read at all.
    await http().post('/v1/roles').set(auth).send({ key: 'integrator', name: 'Integrator', permissions: ['integrations.manage', 'org.read'] }).expect(201);
    await http().post('/v1/roles').set(auth).send({ key: 'branch_lookup', name: 'Branch lookup', permissions: ['customers.read'] }).expect(201);
    const m = await addMember(owner, a.tenantId, 'integrator');
    await asOwnerInTenant(owner, a.tenantId, (x) =>
      x.query(`INSERT INTO membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id) SELECT $1, $2, id, 'BRANCH', $3 FROM roles WHERE tenant_id = $1 AND key = 'branch_lookup'`, [a.tenantId, m.membershipId, branchA]),
    );
    const integrator = bearer(await loginToken(app, m.email));
    const refused = (await http().post('/v1/api-keys').set(integrator).send({ name: 'Too wide', scopes: ['org.read', 'customers.read', 'reports.read'] }).expect(403)).body.error;
    expect(refused.code).toBe('SCOPE_NOT_HELD');
    expect(refused.details.scopes).toEqual(['customers.read', 'reports.read']);
    await http().post('/v1/api-keys').set(integrator).send({ name: 'Narrow', scopes: ['org.read'] }).expect(201);
  });

  it('a key given an expiry works until then and answers 401 after; an expiry in the past is refused', async () => {
    await plan(a, 'enterprise');
    const past = new Date(Date.now() - 60_000).toISOString();
    const refused = (await http().post('/v1/api-keys').set(auth).send({ name: 'Old', scopes: ['org.read'], expiresAt: past }).expect(422)).body.error;
    expect(refused.code).toBe('EXPIRY_IN_PAST');
    // A few seconds ahead on the database clock (the check is `auth_api_key`'s, on the same clock).
    const { rows } = await owner.query<{ at: Date }>(`SELECT now() + interval '3 seconds' AS at`);
    const made = (await http().post('/v1/api-keys').set(auth).send({ name: 'Short', scopes: ['org.read'], expiresAt: rows[0]!.at.toISOString() }).expect(201)).body;
    expect(made.expiresAt).toBeTruthy();
    await http().get('/v1/branches').set(withKey(made.key)).expect(200);
    const audit = await asOwnerInTenant(owner, a.tenantId, async (x) => (await x.query(`SELECT metadata FROM audit_logs WHERE action = 'api_key.created' AND resource_id = $1`, [made.id])).rows);
    expect(audit[0].metadata.expiresAt).toBe(rows[0]!.at.toISOString());
    let status = 200;
    for (let i = 0; i < 40 && status === 200; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await http().get('/v1/branches').set(withKey(made.key))).status;
    }
    expect(status).toBe(401);
    expect((await http().get('/v1/api-keys').set(auth).expect(200)).body.data.find((k: { id: string }) => k.id === made.id).revokedAt).toBeNull();
  });
});

describe('webhooks', () => {
  it('https on a public host in production settings; the secret is shown at creation and on rotation only', async () => {
    const bAuth = bearer(b.access);
    for (const [url, code] of [['http://hooks.example.ph/x', 'WEBHOOK_URL_INSECURE'], ['https://10.0.0.5/x', 'WEBHOOK_URL_PRIVATE'], ['https://localhost/x', 'WEBHOOK_URL_PRIVATE'], ['https://[::1]/x', 'WEBHOOK_URL_PRIVATE']] as const) {
      expect([url, (await http(strict).post('/v1/webhooks').set(bAuth).send({ url, topics: ['sale.completed'] }).expect(422)).body.error.code]).toEqual([url, code]);
    }
    await http(strict).post('/v1/webhooks').set(bAuth).send({ url: 'https://hooks.example.ph/x', topics: ['nope'] }).expect(400);
    const made = (await http(strict).post('/v1/webhooks').set(bAuth).send({ url: 'https://hooks.example.ph/tilvara', topics: ['sale.completed', 'stock.low'], description: 'Bookkeeping' }).expect(201)).body;
    expect(made.secret).toMatch(/^whsec_/);
    const list = (await http().get('/v1/webhooks').set(bAuth).expect(200)).body.data;
    expect(list).toEqual([expect.objectContaining({ id: made.id, topics: ['sale.completed', 'stock.low'], enabled: true, pending: 0, dead: 0 })]);
    expect(JSON.stringify(list)).not.toContain(made.secret);
    const rotated = (await http().post(`/v1/webhooks/${made.id}/rotate-secret`).set(bAuth).expect(200)).body;
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(made.secret);

    // A test ping is queued for the worker; a DEAD delivery can be sent again.
    const ping = (await http().post(`/v1/webhooks/${made.id}/ping`).set(bAuth).expect(201)).body;
    expect(ping).toMatchObject({ topic: 'webhook.ping', status: 'PENDING', maxAttempts: 1 });
    expect((await http().post(`/v1/webhook-deliveries/${ping.id}/retry`).set(bAuth).expect(409)).body.error.code).toBe('DELIVERY_NOT_DEAD');
    await asOwnerInTenant(owner, b.tenantId, (x) => x.query(`UPDATE webhook_deliveries SET status = 'DEAD', attempts = 1, last_error = 'HTTP 500' WHERE id = $1`, [ping.id]));
    expect((await http().post(`/v1/webhook-deliveries/${ping.id}/retry`).set(bAuth).expect(200)).body).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect((await http().get(`/v1/webhooks/${made.id}/deliveries`).set(bAuth).expect(200)).body.data.map((d: { id: string }) => d.id)).toEqual([ping.id]);

    const off = (await http().patch(`/v1/webhooks/${made.id}`).set(bAuth).send({ enabled: false }).expect(200)).body;
    expect(off.enabled).toBe(false);
    // Only for integrations.manage; another business sees none of it.
    const cashier = bearer(await loginToken(app, (await addMember(owner, b.tenantId, 'cashier')).email));
    await http().get('/v1/webhooks').set(cashier).expect(403);
    expect((await http().get('/v1/webhooks').set(auth).expect(200)).body.data).toEqual([]);
    await http().get(`/v1/webhooks/${made.id}/deliveries`).set(auth).expect(404);
  });
});
