import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevMailer } from '../../src/notifications/mailer.js';
import { addMember, bearer, createApp, loginToken, ownerPool, PASSWORD, signup, uniq, type SignedUp } from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;
let mailer: DevMailer;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  mailer = app.get(DevMailer);
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

interface Biz {
  t: SignedUp;
  auth: { Authorization: string };
  role: Record<string, string>;
  branchId: string;
  branch2Id: string;
}

async function biz(prefix: string): Promise<Biz> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const roles = (await http().get('/v1/roles').set(auth).expect(200)).body.data as { id: string; key: string }[];
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const b1 = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const b2 = await http()
    .post('/v1/branches')
    .set(auth)
    .send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' })
    .expect(201);
  return { t, auth, role: Object.fromEntries(roles.map((r) => [r.key, r.id])), branchId: b1.body.id, branch2Id: b2.body.id };
}

function tokenFromMail(email: string): string {
  const mail = mailer.lastTo(email);
  if (!mail) throw new Error(`no mail to ${email}`);
  return /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
}

async function invite(b: Biz, roles: unknown[], email = `${uniq('invitee')}@example.ph`) {
  const res = await http().post('/v1/invitations').set(b.auth).send({ email, roles });
  return { res, email };
}

describe('invitations', () => {
  let b: Biz;
  beforeAll(async () => {
    b = await biz('team');
  });

  it('invites a new person who sets a password, joins with the invited role and is signed in', async () => {
    const { res, email } = await invite(b, [{ roleId: b.role.cashier, scopeType: 'BRANCH', scopeId: b.branchId }]);
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body.status).toBe('PENDING');

    const token = tokenFromMail(email);
    const accepted = await http().post('/v1/invitations/accept').send({ token, displayName: 'Maria', password: PASSWORD }).expect(201);
    expect(accepted.body.activeTenantId).toBe(b.t.tenantId);
    const me = await http().get('/v1/me').set(bearer(accepted.body.tokens.accessToken)).expect(200);
    expect(me.body.activeTenant.grants.every((g: { scopeType: string; scopeId: string }) => g.scopeType === 'BRANCH' && g.scopeId === b.branchId)).toBe(true);

    // One-time: the same token cannot be used again.
    const again = await http().post('/v1/invitations/accept').send({ token, displayName: 'X', password: PASSWORD }).expect(404);
    expect(again.body.error.code).toBe('INVITATION_INVALID');
    const list = await http().get('/v1/invitations').set(b.auth).expect(200);
    expect(list.body.data.find((i: { email: string }) => i.email === email).status).toBe('ACCEPTED');
  });

  it('lets an existing user accept while signed in, only for their own email', async () => {
    const other = await signup(app, 'existing');
    const { res } = await invite(b, [{ roleId: b.role.accountant, scopeType: 'TENANT', scopeId: null }], other.email);
    expect(res.status).toBe(201);
    const token = tokenFromMail(other.email);

    await http().post('/v1/invitations/accept').send({ token, displayName: 'Dup', password: PASSWORD }).expect(409);
    const stranger = await signup(app, 'stranger');
    const mismatch = await http().post('/v1/invitations/accept-existing').set(bearer(stranger.access)).send({ token }).expect(403);
    expect(mismatch.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const ok = await http().post('/v1/invitations/accept-existing').set(bearer(other.access)).send({ token }).expect(200);
    expect(ok.body.tenantId).toBe(b.t.tenantId);
    const me = await http().get('/v1/me').set(bearer(other.access)).expect(200);
    expect(me.body.memberships.map((m: { tenantId: string }) => m.tenantId)).toContain(b.t.tenantId);
  });

  it('refuses duplicate pending invitations and invitations for existing members', async () => {
    const { email } = await invite(b, [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }]);
    const dup = await invite(b, [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }], email);
    expect([dup.res.status, dup.res.body.error.code]).toEqual([409, 'INVITATION_PENDING']);
    const self = await invite(b, [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }], b.t.email);
    expect([self.res.status, self.res.body.error.code]).toEqual([409, 'ALREADY_MEMBER']);
  });

  it('revoked and expired invitations cannot be accepted', async () => {
    const { res, email } = await invite(b, [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }]);
    const token = tokenFromMail(email);
    await http().post(`/v1/invitations/${res.body.id}/revoke`).set(b.auth).expect(200);
    await http().post('/v1/invitations/accept').send({ token, displayName: 'X', password: PASSWORD }).expect(404);

    const exp = await invite(b, [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }]);
    const expToken = tokenFromMail(exp.email);
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [b.t.tenantId]);
      await c.query(`UPDATE member_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exp.res.body.id]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await http().post('/v1/invitations/accept').send({ token: expToken, displayName: 'X', password: PASSWORD }).expect(404);
    const list = await http().get('/v1/invitations').set(b.auth).expect(200);
    expect(list.body.data.find((i: { id: string }) => i.id === exp.res.body.id).status).toBe('EXPIRED');
  });

  it('a garbage token reveals nothing', async () => {
    const res = await http().post('/v1/invitations/accept').send({ token: 'x'.repeat(43), displayName: 'X', password: PASSWORD }).expect(404);
    expect(res.body.error.code).toBe('INVITATION_INVALID');
  });
});

describe('privilege escalation is impossible', () => {
  let b: Biz;
  let branchAdmin: string;
  let tenantAdmin: string;

  beforeAll(async () => {
    b = await biz('escalate');
    branchAdmin = await loginToken(app, (await addMember(owner, b.t.tenantId, 'admin', { type: 'BRANCH', id: b.branchId })).email);
    tenantAdmin = await loginToken(app, (await addMember(owner, b.t.tenantId, 'admin')).email);
  });

  it('a branch admin can invite within their branch only', async () => {
    const ok = await http()
      .post('/v1/invitations')
      .set(bearer(branchAdmin))
      .send({ email: `${uniq('c')}@example.ph`, roles: [{ roleId: b.role.cashier, scopeType: 'BRANCH', scopeId: b.branchId }] });
    expect(ok.status).toBe(201);
    const sibling = await http()
      .post('/v1/invitations')
      .set(bearer(branchAdmin))
      .send({ email: `${uniq('c')}@example.ph`, roles: [{ roleId: b.role.cashier, scopeType: 'BRANCH', scopeId: b.branch2Id }] });
    expect(sibling.status).toBe(403);
    const tenantWide = await http()
      .post('/v1/invitations')
      .set(bearer(branchAdmin))
      .send({ email: `${uniq('c')}@example.ph`, roles: [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }] });
    expect(tenantWide.status).toBe(403);
  });

  it('an admin cannot mint an owner (owner holds subscription.manage, admin does not)', async () => {
    const res = await http()
      .post('/v1/invitations')
      .set(bearer(tenantAdmin))
      .send({ email: `${uniq('o')}@example.ph`, roles: [{ roleId: b.role.owner, scopeType: 'TENANT', scopeId: null }] });
    expect([res.status, res.body.error.code]).toEqual([403, 'PRIVILEGE_ESCALATION']);
  });

  it('an admin cannot create a custom role with permissions they lack, nor edit system roles', async () => {
    const bad = await http()
      .post('/v1/roles')
      .set(bearer(tenantAdmin))
      .send({ key: 'billing_clerk', name: 'Billing', permissions: ['subscription.manage'] });
    expect([bad.status, bad.body.error.code]).toEqual([403, 'PRIVILEGE_ESCALATION']);
    const sys = await http().patch(`/v1/roles/${b.role.cashier}`).set(b.auth).send({ name: 'Renamed' });
    expect([sys.status, sys.body.error.code]).toEqual([409, 'SYSTEM_ROLE_READONLY']);
  });

  it('an admin cannot suspend or demote the owner', async () => {
    const members = (await http().get('/v1/members').set(b.auth).expect(200)).body.data as { membershipId: string; user: { id: string } }[];
    const ownerMembership = members.find((m) => m.user.id === b.t.userId)!.membershipId;
    expect((await http().post(`/v1/members/${ownerMembership}/suspend`).set(bearer(tenantAdmin))).status).toBe(403);
    const demote = await http()
      .put(`/v1/members/${ownerMembership}/roles`)
      .set(bearer(tenantAdmin))
      .send({ roles: [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }] });
    expect([demote.status, demote.body.error.code]).toEqual([403, 'PRIVILEGE_ESCALATION']);
  });

  it('a cashier cannot invite anyone', async () => {
    const cashier = await loginToken(app, (await addMember(owner, b.t.tenantId, 'cashier')).email);
    const res = await http()
      .post('/v1/invitations')
      .set(bearer(cashier))
      .send({ email: `${uniq('c')}@example.ph`, roles: [{ roleId: b.role.cashier, scopeType: 'TENANT', scopeId: null }] });
    expect(res.status).toBe(403);
  });
});

describe('member lifecycle & custom roles', () => {
  let b: Biz;
  beforeAll(async () => {
    b = await biz('lifecycle');
  });

  it('changes roles, suspends, reactivates and removes a member with immediate effect', async () => {
    const m = await addMember(owner, b.t.tenantId, 'cashier');
    const token = await loginToken(app, m.email);
    await http().get('/v1/roles').set(bearer(token)).expect(403);

    await http()
      .put(`/v1/members/${m.membershipId}/roles`)
      .set(b.auth)
      .send({ roles: [{ roleId: b.role.admin, scopeType: 'TENANT', scopeId: null }] })
      .expect(200);
    await http().get('/v1/roles').set(bearer(token)).expect(200);

    await http().post(`/v1/members/${m.membershipId}/suspend`).set(b.auth).expect(200);
    expect((await http().get('/v1/roles').set(bearer(token)).expect(403)).body.error.code).toBe('TENANT_ACCESS_REVOKED');
    expect((await http().post(`/v1/members/${m.membershipId}/suspend`).set(b.auth).expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    await http().post(`/v1/members/${m.membershipId}/reactivate`).set(b.auth).expect(200);
    await http().get('/v1/roles').set(bearer(token)).expect(200);
    await http().post(`/v1/members/${m.membershipId}/remove`).set(b.auth).expect(200);
    await http().get('/v1/roles').set(bearer(token)).expect(403);
  });

  it('never lets the business lose its last active owner', async () => {
    const members = (await http().get('/v1/members').set(b.auth).expect(200)).body.data as { membershipId: string; user: { id: string } }[];
    const mine = members.find((x) => x.user.id === b.t.userId)!.membershipId;
    const demote = await http()
      .put(`/v1/members/${mine}/roles`)
      .set(b.auth)
      .send({ roles: [{ roleId: b.role.admin, scopeType: 'TENANT', scopeId: null }] });
    expect([demote.status, demote.body.error.code]).toEqual([409, 'LAST_OWNER']);
    expect((await http().post(`/v1/members/${mine}/remove`).set(b.auth)).body.error.code).toBe('LAST_OWNER');
    // With a second owner it is allowed.
    await addMember(owner, b.t.tenantId, 'owner');
    await http().put(`/v1/members/${mine}/roles`).set(b.auth).send({ roles: [{ roleId: b.role.admin, scopeType: 'TENANT', scopeId: null }] }).expect(200);
  });

  it('creates, edits and archives a custom role', async () => {
    const o = await biz('customrole');
    const created = await http()
      .post('/v1/roles')
      .set(o.auth)
      .send({ key: 'Stock_Clerk', name: 'Stock clerk', permissions: ['inventory.read', 'catalog.read', 'inventory.read'] })
      .expect(201);
    expect(created.body.key).toBe('stock_clerk');
    expect(created.body.permissions).toEqual(['catalog.read', 'inventory.read']);
    await http().post('/v1/roles').set(o.auth).send({ key: 'stock_clerk', name: 'Dup', permissions: ['catalog.read'] }).expect(409);
    await http().patch(`/v1/roles/${created.body.id}`).set(o.auth).send({ permissions: ['catalog.read'] }).expect(200);

    const m = await addMember(owner, o.t.tenantId, 'stock_clerk');
    const token = await loginToken(app, m.email);
    const me = await http().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body.activeTenant.permissions).toEqual(['catalog.read']);

    expect((await http().post(`/v1/roles/${created.body.id}/archive`).set(o.auth).expect(409)).body.error.code).toBe('ROLE_IN_USE');
    await http().post(`/v1/members/${m.membershipId}/remove`).set(o.auth).expect(200);
    await http().post(`/v1/roles/${created.body.id}/archive`).set(o.auth).expect(200);
  });
});

describe('audit log', () => {
  it('shows the business its own events, newest first, filtered by action, person and day; audit.read only', async () => {
    const o = await biz('auditlog');
    const created = (await http().post('/v1/roles').set(o.auth).send({ key: 'clerk', name: 'Clerk', permissions: ['catalog.read'] }).expect(201)).body;
    await http().patch(`/v1/roles/${created.id}`).set(o.auth).send({ name: 'Counter clerk' }).expect(200);
    const all = (await http().get('/v1/audit-logs').set(o.auth).expect(200)).body;
    const actions = all.data.map((r: { action: string }) => r.action);
    expect(actions.slice(0, 2)).toEqual(['role.updated', 'role.created']); // newest first
    expect(all.data[0]).toMatchObject({ actorUserId: o.t.userId, actorName: expect.any(String), resourceType: 'role', resourceId: created.id });
    expect(all.data.every((r: { tenantId: string | null }) => r.tenantId === o.t.tenantId)).toBe(true); // never platform rows

    const roleOnly = (await http().get('/v1/audit-logs').query({ action: 'role.' }).set(o.auth).expect(200)).body.data;
    expect(roleOnly.map((r: { action: string }) => r.action).sort()).toEqual(['role.created', 'role.updated']);
    const byRecord = (await http().get('/v1/audit-logs').query({ resourceType: 'role', resourceId: created.id }).set(o.auth).expect(200)).body.data;
    expect(byRecord).toHaveLength(2);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    expect((await http().get('/v1/audit-logs').query({ from: today, to: today, action: 'role.' }).set(o.auth).expect(200)).body.data).toHaveLength(2);
    expect((await http().get('/v1/audit-logs').query({ from: '2020-01-01', to: '2020-01-31' }).set(o.auth).expect(200)).body.data).toEqual([]);
    const page = (await http().get('/v1/audit-logs').query({ limit: 1 }).set(o.auth).expect(200)).body;
    const next = (await http().get('/v1/audit-logs').query({ limit: 1, cursor: page.nextCursor }).set(o.auth).expect(200)).body;
    expect([page.data[0].action, next.data[0].action]).toEqual(['role.updated', 'role.created']);
    await http().get('/v1/audit-logs').query({ from: '2026-02-01', to: '2026-01-01' }).set(o.auth).expect(400);

    const cashier = bearer(await loginToken(app, (await addMember(owner, o.t.tenantId, 'cashier')).email));
    expect((await http().get('/v1/audit-logs').set(cashier).expect(403)).body.error.code).toBe('FORBIDDEN');
    const acct = bearer(await loginToken(app, (await addMember(owner, o.t.tenantId, 'accountant')).email));
    await http().get('/v1/audit-logs').set(acct).expect(200); // accountants hold audit.read
  });
});

describe('cross-tenant isolation (team)', () => {
  it("cannot invite with, assign, or act on another tenant's roles, members or invitations", async () => {
    const a = await biz('team-a');
    const b = await biz('team-b');
    const aMember = await addMember(owner, a.t.tenantId, 'cashier');
    const { res: aInvite } = await invite(a, [{ roleId: a.role.cashier, scopeType: 'TENANT', scopeId: null }]);

    const attempts = [
      http().post('/v1/invitations').set(b.auth).send({ email: `${uniq('x')}@example.ph`, roles: [{ roleId: a.role.owner, scopeType: 'TENANT', scopeId: null }] }),
      http().post('/v1/invitations').set(b.auth).send({ email: `${uniq('x')}@example.ph`, roles: [{ roleId: b.role.cashier, scopeType: 'BRANCH', scopeId: a.branchId }] }),
      http().put(`/v1/members/${aMember.membershipId}/roles`).set(b.auth).send({ roles: [{ roleId: b.role.owner, scopeType: 'TENANT', scopeId: null }] }),
      http().post(`/v1/members/${aMember.membershipId}/remove`).set(b.auth),
      http().post(`/v1/invitations/${aInvite.body.id}/revoke`).set(b.auth),
      http().patch(`/v1/roles/${a.role.cashier}`).set(b.auth).send({ name: 'pwned' }),
      http().post(`/v1/roles/${a.role.cashier}/archive`).set(b.auth),
    ];
    for (const res of await Promise.all(attempts)) {
      expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    }
    const list = await http().get('/v1/invitations').set(b.auth).expect(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(aInvite.body.id);
  });
});
