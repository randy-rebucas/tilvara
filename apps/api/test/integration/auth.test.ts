import type { INestApplication } from '@nestjs/common';
import { PERMISSIONS } from '@1pos/validation';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember as addMemberWith, bearer, createApp, ownerPool, PASSWORD, signup, uniq, type SignedUp } from './helpers.js';

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

const addMember = (tenantId: string, roleKey: string, scope?: Parameters<typeof addMemberWith>[3]) =>
  addMemberWith(owner, tenantId, roleKey, scope);

function login(email: string, extra: Record<string, unknown> = {}) {
  return http().post('/v1/auth/login').send({ email, password: PASSWORD, ...extra });
}

describe('permission catalog', () => {
  it('database seed matches the shared PERMISSIONS constant', async () => {
    const { rows } = await owner.query<{ code: string }>('SELECT code FROM permissions ORDER BY code');
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].sort());
  });
});

describe('signup / onboarding', () => {
  it('creates user, tenant, system roles and an owner membership in one step', async () => {
    const s = await signup(app);
    expect(s.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    const me = await http().get('/v1/me').set(bearer(s.access)).expect(200);
    expect(me.body.activeTenant.tenantId).toBe(s.tenantId);
    expect(me.body.activeTenant.permissions).toHaveLength(PERMISSIONS.length);
    expect(me.body.memberships).toHaveLength(1);

    const roles = await http().get('/v1/roles').set(bearer(s.access)).expect(200);
    expect(roles.body.data.map((r: { key: string }) => r.key).sort()).toEqual(
      ['accountant', 'admin', 'branch_manager', 'cashier', 'inventory_officer', 'kitchen_crew', 'owner', 'purchasing_officer', 'restaurant_manager', 'senior_cashier'],
    );
    const byKey = new Map((roles.body.data as { key: string; permissions: string[]; isSystem: boolean }[]).map((r) => [r.key, r]));
    expect(byKey.get('kitchen_crew')).toMatchObject({ isSystem: true, permissions: ['kitchen.operate'] });
    expect(byKey.get('restaurant_manager')!.permissions).toEqual([...byKey.get('branch_manager')!.permissions, 'restaurant.manage'].sort());
  });

  it('rejects a duplicate email (409) and a duplicate slug without leaving an orphan user', async () => {
    const s = await signup(app);
    const dupEmail = await http()
      .post('/v1/auth/signup')
      .send({ email: s.email.toUpperCase(), password: PASSWORD, displayName: 'X', businessName: 'X', tenantSlug: uniq('x') })
      .expect(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_UNAVAILABLE');

    const takenSlug = (await http().get('/v1/me').set(bearer(s.access))).body.memberships[0].tenantSlug;
    const freshEmail = `${uniq('orphan')}@example.ph`;
    const dupSlug = await http()
      .post('/v1/auth/signup')
      .send({ email: freshEmail, password: PASSWORD, displayName: 'Y', businessName: 'Y', tenantSlug: takenSlug })
      .expect(409);
    expect(dupSlug.body.error.code).toBe('SLUG_UNAVAILABLE');
    // Transaction rolled back: the user was not created.
    expect((await login(freshEmail)).status).toBe(401);
  });

  it('validates input and returns field issues', async () => {
    const res = await http().post('/v1/auth/signup').send({ email: 'nope', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues.length).toBeGreaterThan(2);
  });
});

describe('login', () => {
  it('auto-selects the only tenant', async () => {
    const s = await signup(app);
    const res = await login(s.email).expect(200);
    expect(res.body.activeTenantId).toBe(s.tenantId);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    const s = await signup(app);
    const wrong = await http().post('/v1/auth/login').send({ email: s.email, password: 'wrong password!!' }).expect(401);
    const unknown = await http().post('/v1/auth/login').send({ email: `${uniq('ghost')}@example.ph`, password: 'whatever12345' }).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after 5 consecutive failures, even for the right password', async () => {
    const s = await signup(app);
    for (let i = 0; i < 5; i++) {
      await http().post('/v1/auth/login').send({ email: s.email, password: 'wrong password!!' }).expect(401);
    }
    const locked = await login(s.email).expect(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('refuses to activate a tenant the user does not belong to', async () => {
    const a = await signup(app, 'alpha');
    const b = await signup(app, 'bravo');
    const res = await login(a.email, { tenantId: b.tenantId }).expect(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const s = await signup(app);
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refresh, tenantId: s.tenantId }).expect(200);
    expect(r1.body.tokens.refreshToken).not.toBe(s.refresh);
    expect(r1.body.activeTenantId).toBe(s.tenantId);

    // Replaying the old token = theft signal.
    const replay = await http().post('/v1/auth/refresh').send({ refreshToken: s.refresh }).expect(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    // ...which kills the legitimate successor token and the access tokens of that session.
    await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.tokens.refreshToken }).expect(401);
    await http().get('/v1/me').set(bearer(r1.body.tokens.accessToken)).expect(401);
  });

  it('lets exactly one of two concurrent refreshes win', async () => {
    const s = await signup(app);
    const results = await Promise.all([
      http().post('/v1/auth/refresh').send({ refreshToken: s.refresh }),
      http().post('/v1/auth/refresh').send({ refreshToken: s.refresh }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('logout invalidates the access token immediately', async () => {
    const s = await signup(app);
    await http().get('/v1/me').set(bearer(s.access)).expect(200);
    await http().post('/v1/auth/logout').set(bearer(s.access)).expect(204);
    await http().get('/v1/me').set(bearer(s.access)).expect(401);
    await http().post('/v1/auth/refresh').send({ refreshToken: s.refresh }).expect(401);
  });

  it('rejects missing, malformed and forged bearer tokens', async () => {
    await http().get('/v1/me').expect(401);
    await http().get('/v1/me').set({ Authorization: 'Bearer nope' }).expect(401);
    const s = await signup(app);
    const [h, , sig] = s.access.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: s.userId, sid: 'x', tid: s.tenantId, typ: 'access' })).toString('base64url');
    await http().get('/v1/me').set(bearer(`${h}.${forged}.${sig}`)).expect(401);
  });
});

describe('authorization & tenant isolation', () => {
  let a: SignedUp;
  let b: SignedUp;

  beforeAll(async () => {
    a = await signup(app, 'alpha');
    b = await signup(app, 'bravo');
  });

  it('cannot switch into, refresh into, or log into another tenant', async () => {
    expect((await http().post('/v1/auth/switch-tenant').set(bearer(a.access)).send({ tenantId: b.tenantId })).status).toBe(403);
    expect((await http().post('/v1/auth/refresh').send({ refreshToken: a.refresh, tenantId: b.tenantId })).status).toBe(403);
  });

  it('lists only its own members and roles', async () => {
    const members = await http().get('/v1/members').set(bearer(a.access)).expect(200);
    expect(members.body.data).toHaveLength(1);
    expect(members.body.data[0].user.id).toBe(a.userId);
    const roles = await http().get('/v1/roles').set(bearer(a.access)).expect(200);
    const roleIdsA = roles.body.data.map((r: { id: string }) => r.id);
    const rolesB = await http().get('/v1/roles').set(bearer(b.access)).expect(200);
    expect(rolesB.body.data.some((r: { id: string }) => roleIdsA.includes(r.id))).toBe(false);
  });

  it('enforces role permissions (cashier cannot read roles or members)', async () => {
    const cashier = await addMember(a.tenantId, 'cashier');
    const res = await login(cashier.email).expect(200);
    const token = res.body.tokens.accessToken;
    const me = await http().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body.activeTenant.permissions).toContain('sales.create');
    expect(me.body.activeTenant.permissions).not.toContain('roles.read');
    const denied = await http().get('/v1/roles').set(bearer(token)).expect(403);
    expect(denied.body.error.details.missing).toEqual(['roles.read']);
    await http().get('/v1/members').set(bearer(token)).expect(403);
  });

  it('branch-scoped roles do not grant tenant-wide permissions', async () => {
    const le = await http()
      .post('/v1/legal-entities')
      .set(bearer(a.access))
      .send({ registeredName: 'Alpha Corp', vatStatus: 'VAT' })
      .expect(201);
    const branch = await http()
      .post('/v1/branches')
      .set(bearer(a.access))
      .send({ legalEntityId: le.body.id, code: 'MAIN', name: 'Main' })
      .expect(201);
    const mgr = await addMember(a.tenantId, 'branch_manager', { type: 'BRANCH', id: branch.body.id });
    const token = (await login(mgr.email).expect(200)).body.tokens.accessToken;
    const me = await http().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body.activeTenant.grants.every((g: { scopeType: string }) => g.scopeType === 'BRANCH')).toBe(true);
    // members.read is in the branch manager template, but only at branch scope → tenant-wide list is denied.
    await http().get('/v1/members').set(bearer(token)).expect(403);
  });

  it('a removed member loses access on the very next request', async () => {
    const member = await addMember(a.tenantId, 'admin');
    const token = (await login(member.email).expect(200)).body.tokens.accessToken;
    await http().get('/v1/roles').set(bearer(token)).expect(200);
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      await c.query(`UPDATE tenant_memberships SET status = 'REMOVED' WHERE id = $1`, [member.membershipId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const res = await http().get('/v1/roles').set(bearer(token)).expect(403);
    expect(res.body.error.code).toBe('TENANT_ACCESS_REVOKED');
  });

  it('routes needing a tenant refuse tokens without one', async () => {
    const solo = await signup(app, 'solo');
    const second = await signup(app, 'second');
    // Make solo a member of a 2nd tenant so login no longer auto-selects.
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [second.tenantId]);
      await c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)', [second.tenantId, solo.userId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const res = await login(solo.email).expect(200);
    expect(res.body.activeTenantId).toBeNull();
    expect(res.body.memberships).toHaveLength(2);
    const denied = await http().get('/v1/roles').set(bearer(res.body.tokens.accessToken)).expect(403);
    expect(denied.body.error.code).toBe('TENANT_REQUIRED');
    const switched = await http()
      .post('/v1/auth/switch-tenant')
      .set(bearer(res.body.tokens.accessToken))
      .send({ tenantId: solo.tenantId })
      .expect(200);
    await http().get('/v1/roles').set(bearer(switched.body.accessToken)).expect(200);
  });

  it('records onboarding and login in the tenant audit log only', async () => {
    // FORCE RLS applies to the schema owner too: read within tenant A's context.
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      const { rows } = await c.query<{ tenant_id: string; action: string }>(
        `SELECT tenant_id, action FROM audit_logs WHERE tenant_id IN ($1, $2)`,
        [a.tenantId, b.tenantId],
      );
      await c.query('COMMIT');
      expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['tenant.created', 'tenant.onboarded', 'auth.login']));
    } finally {
      c.release();
    }
  });
});

describe('rate limiting', () => {
  it('throttles signup attempts per IP', async () => {
    const limited = await createApp({ RATE_LIMITS_ENABLED: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await request(limited.getHttpServer()).post('/v1/auth/signup').send({});
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
      expect(statuses[5]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
