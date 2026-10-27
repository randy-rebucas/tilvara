import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, type SignedUp } from './helpers.js';

/**
 * Second tenant audit (2026-10-27, migration 0126): what the database refuses even when the API would
 * pass it something wrong, and the session and API-key rules found with it.
 */
let app: INestApplication;
let owner: pg.Pool;
let runtime: pg.Pool;
let a: SignedUp;
let b: SignedUp;
const http = () => request(app.getHttpServer());
const code = (res: request.Response) => res.body.error?.code as string | undefined;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  a = await signup(app, 'audit2-a');
  b = await signup(app, 'audit2-b');
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await runtime.end();
});

/** As the API's role, in business `tenantId`, signed in as `userId`; always rolled back. */
async function asApp<T>(tenantId: string | null, userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await runtime.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenantId ?? '', userId ?? '']);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const failure = (p: Promise<unknown>) => p.then(() => null, (e: { constraint?: string; code?: string }) => ({ code: e.code, constraint: e.constraint }));

describe('the database refuses another business’s row or person', () => {
  it('a stock movement for another business is refused by the costing trigger before it touches anything', async () => {
    const refused = await asApp(a.tenantId, a.userId, (c) => failure(c.query('INSERT INTO stock_movements (tenant_id) VALUES ($1)', [b.tenantId])));
    expect(refused).toEqual({ code: '42501', constraint: 'row_tenant_mismatch' });
    // Without a business in context the runtime role is refused too (migrations run as the migrator).
    expect(await asApp(null, a.userId, (c) => failure(c.query('INSERT INTO stock_movements (tenant_id) VALUES ($1)', [b.tenantId])))).toEqual({
      code: '42501',
      constraint: 'row_tenant_mismatch',
    });
  });

  it('a data export starts as a request: no status or file of the API’s choosing', async () => {
    const forged = await asApp(a.tenantId, a.userId, (c) =>
      failure(
        c.query(`INSERT INTO data_exports (tenant_id, requested_by, status, file_key, expires_at) VALUES ($1, $2, 'READY', $3, now() + interval '1 day')`, [
          a.tenantId,
          a.userId,
          `exports/${b.tenantId}/${randomUUID()}.zip`,
        ]),
      ),
    );
    expect(forged).toEqual({ code: '23514', constraint: 'data_exports_request' });
  });

  it('person functions answer the API only for the signed-in person', async () => {
    const mine = await asApp(null, a.userId, async (c) => (await c.query('SELECT tenant_id FROM auth_list_memberships($1)', [a.userId])).rows);
    expect(mine).toEqual([{ tenant_id: a.tenantId }]);
    expect(await asApp(null, a.userId, (c) => failure(c.query('SELECT * FROM auth_list_memberships($1)', [b.userId])))).toEqual({
      code: '42501',
      constraint: 'acting_user_mismatch',
    });
    expect(await asApp(null, a.userId, (c) => failure(c.query('SELECT * FROM auth_account_closure_blockers($1)', [b.userId])))).toEqual({
      code: '42501',
      constraint: 'acting_user_mismatch',
    });
    // An MFA reset in A's name, signed in as someone else, is refused before any check of A's rights.
    const m = await addMember(owner, a.tenantId, 'cashier');
    expect(await asApp(a.tenantId, m.userId, (c) => failure(c.query(`SELECT auth_mfa_admin_reset($1, $2, 'lost phone', NULL)`, [m.userId, a.userId])))).toEqual({
      code: '42501',
      constraint: 'acting_user_mismatch',
    });
    // The API cannot read when anyone signed in last.
    expect(await asApp(a.tenantId, a.userId, (c) => failure(c.query('SELECT last_login_at FROM users WHERE id = $1', [a.userId])))).toMatchObject({ code: '42501' });
  });
});

describe('sessions and keys', () => {
  it('a refresh for a business the person left is refused without ending their session', async () => {
    const t = await signup(app, 'audit2-left');
    await asOwnerInTenant(owner, a.tenantId, (c) => c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)', [a.tenantId, t.userId]));
    await asOwnerInTenant(owner, a.tenantId, (c) => c.query(`UPDATE tenant_memberships SET status = 'REMOVED' WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, t.userId]));
    expect(code(await http().post('/v1/auth/refresh').send({ refreshToken: t.refresh, tenantId: a.tenantId }).expect(403))).toBe('NOT_A_MEMBER');
    // The same refresh token still works for the business they are in.
    const r = (await http().post('/v1/auth/refresh').send({ refreshToken: t.refresh, tenantId: t.tenantId }).expect(200)).body;
    expect(r.activeTenantId).toBe(t.tenantId);
  });

  it('an API key stops working while the person who made it is not an active member', async () => {
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [b.tenantId]);
    const admin = await addMember(owner, b.tenantId, 'admin');
    const adminAuth = bearer(await loginToken(app, admin.email));
    const made = (await http().post('/v1/api-keys').set(adminAuth).send({ name: 'Books', scopes: ['org.read'] }).expect(201)).body;
    const key = { Authorization: `ApiKey ${made.key}` };
    await http().get('/v1/branches').set(key).expect(200);
    const ownerAuth = bearer(b.access);
    await http().post(`/v1/members/${admin.membershipId}/suspend`).set(ownerAuth).expect(200);
    await http().get('/v1/branches').set(key).expect(401);
    await http().post(`/v1/members/${admin.membershipId}/reactivate`).set(ownerAuth).expect(200);
    await http().get('/v1/branches').set(key).expect(200);
  });
});
