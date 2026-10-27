import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, stepAt } from '../../src/auth/totp.js';
import { DevMailer } from '../../src/notifications/mailer.js';
import { addMember, asOwnerInTenant, bearer, createApp, ownerPool, PASSWORD, signup, type SignedUp } from './helpers.js';

/** ADR-0016 slice 1: two-step sign-in for privileged members, password reset, auth audit events. */
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

const login = (email: string, password = PASSWORD) => http().post('/v1/auth/login').send({ email, password });
/** A code for the next time step: the current one may already be spent by an earlier call. */
const code = (secret: Buffer, offset = 1) => hotp(secret, stepAt(Date.now() / 1000) + offset);

async function enroll(token: string): Promise<{ secret: Buffer; recoveryCodes: string[] }> {
  const started = await http().post('/v1/auth/mfa/enroll').set(bearer(token)).send({ password: PASSWORD }).expect(200);
  const secret = base32Decode(started.body.secret);
  const confirmed = await http().post('/v1/auth/mfa/confirm').set(bearer(token)).send({ code: code(secret, 0) }).expect(200);
  return { secret, recoveryCodes: confirmed.body.recoveryCodes };
}

/** Run as onepos_platform (BYPASSRLS): users, MFA tables and NULL-tenant audit rows are invisible otherwise. */
async function asPlatform<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE onepos_platform');
    const { rows } = await c.query<T>(sql, params);
    await c.query('COMMIT');
    return rows;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Platform-level audit rows have no tenant: only a BYPASSRLS role sees them. */
async function platformEvents(userId: string): Promise<string[]> {
  const rows = await asPlatform<{ action: string }>(
    `SELECT action FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1 ORDER BY occurred_at, id`,
    [userId],
  );
  return rows.map((r) => r.action);
}

async function tenantEvents(tenantId: string, userId: string): Promise<string[]> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await c.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE actor_user_id = $1 ORDER BY occurred_at, id`,
      [userId],
    );
    await c.query('COMMIT');
    return rows.map((r) => r.action);
  } finally {
    c.release();
  }
}

const backdatePrivilege = (userId: string, days: number) =>
  asPlatform(`UPDATE users SET privileged_since = now() - make_interval(days => $2) WHERE id = $1`, [userId, days]);

describe('two-step sign-in (TOTP)', () => {
  let s: SignedUp;
  let secret: Buffer;
  let recoveryCodes: string[];

  beforeAll(async () => {
    s = await signup(app, 'mfa');
  });

  it('a new owner is privileged: required, not yet on, due after the grace period', async () => {
    const me = await http().get('/v1/me').set(bearer(s.access)).expect(200);
    expect(me.body.mfa).toMatchObject({ enabled: false, sessionVerified: false, required: true });
    const due = new Date(me.body.mfa.dueAt).getTime();
    expect(due - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(due - Date.now()).toBeLessThan(7.1 * 86_400_000);
    // Within the grace period every route still works.
    await http().get('/v1/roles').set(bearer(s.access)).expect(200);
  });

  it('enrolment needs the password; a wrong code does not turn it on', async () => {
    const wrong = await http().post('/v1/auth/mfa/enroll').set(bearer(s.access)).send({ password: 'not my password' }).expect(403);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    await http().post('/v1/auth/mfa/confirm').set(bearer(s.access)).send({ code: '123456' }).expect(409);

    const started = await http().post('/v1/auth/mfa/enroll').set(bearer(s.access)).send({ password: PASSWORD }).expect(200);
    expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Tilvara%3A/);
    secret = base32Decode(started.body.secret);
    const bad = await http().post('/v1/auth/mfa/confirm').set(bearer(s.access)).send({ code: code(secret, 5) }).expect(422);
    expect(bad.body.error.code).toBe('INVALID_MFA_CODE');
    expect((await http().get('/v1/auth/mfa').set(bearer(s.access)).expect(200)).body.enabled).toBe(false);

    const ok = await http().post('/v1/auth/mfa/confirm').set(bearer(s.access)).send({ code: code(secret, 0) }).expect(200);
    recoveryCodes = ok.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    const status = await http().get('/v1/auth/mfa').set(bearer(s.access)).expect(200);
    expect(status.body).toMatchObject({ enabled: true, sessionVerified: true, required: true, dueAt: null, recoveryCodesLeft: 10 });
    await http().post('/v1/auth/mfa/enroll').set(bearer(s.access)).send({ password: PASSWORD }).expect(409);
  });

  it('the secret is stored encrypted and the runtime role cannot read MFA tables', async () => {
    const rows = await asPlatform<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM user_mfa_factors WHERE user_id = $1', [s.userId]);
    expect(rows[0]!.secret_ciphertext).toMatch(/^v1\./);
    expect(rows[0]!.secret_ciphertext).not.toContain(secret.toString('base64url'));
    const grants = await owner.query(
      `SELECT table_name FROM information_schema.table_privileges
        WHERE grantee = 'onepos_app' AND table_name IN ('user_mfa_factors', 'user_mfa_recovery_codes', 'password_reset_tokens')`,
    );
    expect(grants.rows).toEqual([]);
  });

  it('sign-in then asks for a code; the challenge is not an access token; each code works once', async () => {
    const first = await login(s.email).expect(200);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.tokens).toBeUndefined();
    const challenge = first.body.challengeToken as string;
    await http().get('/v1/me').set(bearer(challenge)).expect(401);
    await http().post('/v1/auth/mfa/verify').send({ challengeToken: s.access, code: code(secret) }).expect(401);

    const c = code(secret);
    const verified = await http().post('/v1/auth/mfa/verify').send({ challengeToken: challenge, code: c }).expect(200);
    expect(verified.body.activeTenantId).toBe(s.tenantId);
    const me = await http().get('/v1/me').set(bearer(verified.body.tokens.accessToken)).expect(200);
    expect(me.body.mfa.sessionVerified).toBe(true);

    // The same code again (another sign-in within the same 30 s) is refused: replay.
    const again = await login(s.email).expect(200);
    const replay = await http().post('/v1/auth/mfa/verify').send({ challengeToken: again.body.challengeToken, code: c }).expect(401);
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');

    // Refresh keeps the session verified.
    const refreshed = await http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: verified.body.tokens.refreshToken, tenantId: s.tenantId })
      .expect(200);
    await http().get('/v1/roles').set(bearer(refreshed.body.tokens.accessToken)).expect(200);
  });

  it('a recovery code signs in once', async () => {
    const rc = recoveryCodes[0]!;
    const ch = (await login(s.email).expect(200)).body.challengeToken;
    await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch, recoveryCode: rc.toUpperCase() }).expect(200);
    const ch2 = (await login(s.email).expect(200)).body.challengeToken;
    await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch2, recoveryCode: rc }).expect(401);
    const status = await http().get('/v1/auth/mfa').set(bearer(s.access)).expect(200);
    expect(status.body.recoveryCodesLeft).toBe(9);
  });

  it('a privileged member makes new recovery codes with the password and a current code; the old ones stop working', async () => {
    const t = await signup(app, 'mfaregen');
    const { secret: sec, recoveryCodes: old } = await enroll(t.access);
    const regen = (body: object) => http().post('/v1/auth/mfa/recovery-codes').set(bearer(t.access)).send(body);

    expect((await regen({ password: 'not my password', code: code(sec) }).expect(403)).body.error.code).toBe('WRONG_PASSWORD');
    expect((await regen({ password: PASSWORD, code: code(sec, 7) }).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    await regen({ password: PASSWORD, code: old[0] }).expect(400); // a recovery code cannot mint new ones

    const c = code(sec);
    const fresh = (await regen({ password: PASSWORD, code: c }).expect(200)).body.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((r) => old.includes(r))).toBe(false);
    // The code is spent: the same one again is refused, and nothing changes.
    expect((await regen({ password: PASSWORD, code: c }).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await http().get('/v1/auth/mfa').set(bearer(t.access)).expect(200)).body.recoveryCodesLeft).toBe(10);

    const ch = (await login(t.email).expect(200)).body.challengeToken;
    await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch, recoveryCode: old[1] }).expect(401);
    const ch2 = (await login(t.email).expect(200)).body.challengeToken;
    await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch2, recoveryCode: fresh[0] }).expect(200);
    expect(await platformEvents(t.userId)).toEqual(expect.arrayContaining(['auth.mfa.enabled', 'auth.mfa.recovery_codes_regenerated']));
    // Only codes are replaced: two-step sign-in stays on.
    expect((await http().get('/v1/auth/mfa').set(bearer(t.access)).expect(200)).body).toMatchObject({ enabled: true, recoveryCodesLeft: 9 });
  });

  it('an owner resets a member who lost their phone: factor gone, sessions ended, audited; never oneself; a cashier cannot', async () => {
    const t = await signup(app, 'mfareset');
    await enroll(t.access);
    const acct = await addMember(owner, t.tenantId, 'accountant');
    const acctToken = (await login(acct.email).expect(200)).body.tokens;
    await enroll(acctToken.accessToken);
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const cashierToken = (await login(cashier.email).expect(200)).body.tokens.accessToken;
    const reset = (who: string, membershipId: string, reason = 'Lost phone and codes') =>
      http().post(`/v1/members/${membershipId}/reset-mfa`).set(bearer(who)).send({ reason });

    const listed = (await http().get('/v1/members/mfa').set(bearer(t.access)).expect(200)).body.data as { userId: string; enrolled: boolean }[];
    expect(listed.find((x) => x.userId === acct.userId)?.enrolled).toBe(true);
    expect(listed.find((x) => x.userId === cashier.userId)?.enrolled).toBe(false);

    expect((await reset(cashierToken, acct.membershipId).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await reset(t.access, acct.membershipId, '').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    const own = (await http().get('/v1/members').set(bearer(t.access))).body.data.find((m: { user: { id: string } }) => m.user.id === t.userId).membershipId;
    expect((await reset(t.access, own).expect(409)).body.error.code).toBe('MFA_RESET_SELF');
    expect((await reset(t.access, cashier.membershipId).expect(409)).body.error.code).toBe('MFA_NOT_ENABLED');

    await reset(t.access, acct.membershipId).expect(200);
    // The accountant's old session is over; they sign in with the password alone and set up again.
    await http().post('/v1/auth/refresh').send({ refreshToken: acctToken.refreshToken, tenantId: t.tenantId }).expect(401);
    const fresh = (await login(acct.email).expect(200)).body;
    expect(fresh.tokens).toBeDefined();
    expect((await http().get('/v1/auth/mfa').set(bearer(fresh.tokens.accessToken)).expect(200)).body).toMatchObject({ enabled: false, required: true });
    // Platform row: the owner reset the accountant (actor = owner, resource = the accountant).
    const [row] = await asPlatform<{ actor: string; reason: string }>(
      `SELECT actor_user_id AS actor, metadata->>'reason' AS reason FROM audit_logs WHERE tenant_id IS NULL AND action = 'auth.mfa.reset' AND resource_id = $1`, [acct.userId],
    );
    expect(row).toEqual({ actor: t.userId, reason: 'Lost phone and codes' });
    expect(await tenantEvents(t.tenantId, t.userId)).toContain('member.mfa_reset');
  });

  it('a member who is also in another business is not reset by this business (session 40): support does it', async () => {
    const t = await signup(app, 'mfaother');
    await enroll(t.access);
    const acct = await addMember(owner, t.tenantId, 'accountant');
    const acctToken = (await login(acct.email).expect(200)).body.tokens;
    await enroll(acctToken.accessToken);
    // The same person is also on another business's team.
    const other = await signup(app, 'mfaother-b');
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [other.tenantId]);
      await c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)', [other.tenantId, acct.userId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const refused = await http().post(`/v1/members/${acct.membershipId}/reset-mfa`).set(bearer(t.access)).send({ reason: 'Lost phone' }).expect(409);
    expect(refused.body.error.code).toBe('MFA_RESET_OTHER_BUSINESS');
    // Nothing happened to the account: the factor is still on and the session still refreshes.
    expect((await http().get('/v1/auth/mfa').set(bearer(acctToken.accessToken)).expect(200)).body.enabled).toBe(true);
    await http().post('/v1/auth/refresh').send({ refreshToken: acctToken.refreshToken, tenantId: t.tenantId }).expect(200);
  });

  it('support resets an owner who lost phone and codes, only with ops credentials, a reason and a ticket', async () => {
    const t = await signup(app, 'mfasupport');
    await enroll(t.access);
    await expect(owner.query(`SELECT auth_mfa_support_reset($1, 'ops@1pos', 'Lost phone', '')`, [t.email])).rejects.toThrow(/required/);
    const { rows } = await owner.query<{ v: string | null }>(`SELECT auth_mfa_support_reset($1, 'ops@1pos', 'Lost phone, ID checked on a call', 'TCK-1042') AS v`, [t.email]);
    expect(rows[0]!.v).toBe(t.userId);
    expect((await login(t.email).expect(200)).body.tokens).toBeDefined(); // no code asked any more
    const [audit] = await asPlatform<{ metadata: { ticket: string; actor: string } }>(
      `SELECT metadata FROM audit_logs WHERE tenant_id IS NULL AND action = 'auth.mfa.support_reset' AND resource_id = $1`, [t.userId],
    );
    expect(audit!.metadata).toMatchObject({ ticket: 'TCK-1042', actor: 'ops@1pos' });
  });

  it('wrong codes count towards the lock, and a correct password does not reset the count', async () => {
    const t = await signup(app, 'mfalock');
    const { secret: sec } = await enroll(t.access);
    for (let i = 0; i < 5; i++) {
      const ch = (await login(t.email).expect(200)).body.challengeToken;
      await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch, code: code(sec, 9) }).expect(401);
    }
    // Locked now: the password is refused, and so is a right code on an earlier challenge.
    await login(t.email).expect(429);
    expect(await platformEvents(t.userId)).toEqual(expect.arrayContaining(['auth.mfa.enabled', 'auth.lockout']));
  });

  it('a session that started before enrolment must sign in again on business routes', async () => {
    const t = await signup(app, 'mfaold');
    const older = (await login(t.email).expect(200)).body.tokens.accessToken;
    await enroll(t.access);
    await http().get('/v1/roles').set(bearer(t.access)).expect(200);
    const blocked = await http().get('/v1/roles').set(bearer(older)).expect(403);
    expect(blocked.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { enrolled: true } });
    // Account routes stay open so the person can sign out or see why.
    await http().get('/v1/me').set(bearer(older)).expect(200);
  });

  it('cannot be turned off while the role requires it; a cashier may turn it off', async () => {
    const off = await http().post('/v1/auth/mfa/disable').set(bearer(s.access)).send({ password: PASSWORD, code: code(secret) }).expect(409);
    expect(off.body.error.code).toBe('MFA_REQUIRED_FOR_ROLE');

    const cashier = await addMember(owner, s.tenantId, 'cashier');
    const token = (await login(cashier.email).expect(200)).body.tokens.accessToken;
    const me = await http().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body.mfa).toMatchObject({ required: false, dueAt: null });
    const { secret: cs } = await enroll(token);
    await http().post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: PASSWORD, code: code(cs, 7) }).expect(422);
    await http().post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: PASSWORD, code: code(cs) }).expect(204);
    expect((await login(cashier.email).expect(200)).body.tokens).toBeDefined();
    expect(await platformEvents(cashier.userId)).toEqual(expect.arrayContaining(['auth.mfa.enabled', 'auth.mfa.disabled']));
  });
});

describe('grace period', () => {
  it('after the grace period a privileged member without MFA can only set it up', async () => {
    const t = await signup(app, 'grace');
    await http().get('/v1/roles').set(bearer(t.access)).expect(200);
    await backdatePrivilege(t.userId, 8);
    const blocked = await http().get('/v1/roles').set(bearer(t.access)).expect(403);
    expect(blocked.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { enrolled: false } });
    const me = await http().get('/v1/me').set(bearer(t.access)).expect(200);
    expect(new Date(me.body.mfa.dueAt).getTime()).toBeLessThan(Date.now());

    await enroll(t.access);
    await http().get('/v1/roles').set(bearer(t.access)).expect(200);
  });

  it('never blocks members without privileged permissions', async () => {
    const t = await signup(app, 'grace2');
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    await backdatePrivilege(cashier.userId, 30);
    const token = (await login(cashier.email).expect(200)).body.tokens.accessToken;
    await http().get('/v1/pos/workstations').set(bearer(token)).expect(200);
  });

  it('the built-in accountant role is privileged; the branch manager of a shop is not', async () => {
    const t = await signup(app, 'grace3');
    for (const [role, required] of [['accountant', true], ['branch_manager', false], ['inventory_officer', false], ['admin', true]] as const) {
      const m = await addMember(owner, t.tenantId, role);
      const token = (await login(m.email).expect(200)).body.tokens.accessToken;
      const me = await http().get('/v1/me').set(bearer(token)).expect(200);
      expect([role, me.body.mfa.required]).toEqual([role, required]);
    }
  });

});

describe('password reset', () => {
  it('answers the same for unknown emails and sends nothing', async () => {
    const before = mailer.sent.length;
    const res = await http().post('/v1/auth/password-reset/request').send({ email: 'nobody-here@example.ph' }).expect(202);
    expect(res.body).toEqual({ accepted: true });
    expect(mailer.sent.length).toBe(before);
  });

  it('resets once with the newest link, unlocks and signs out every session', async () => {
    const t = await signup(app, 'reset');
    for (let i = 0; i < 5; i++) await login(t.email, 'wrong password!!').expect(401);
    await login(t.email).expect(429);

    await http().post('/v1/auth/password-reset/request').send({ email: t.email.toUpperCase() }).expect(202);
    const firstToken = /token=([\w-]+)/.exec(mailer.lastTo(t.email)!.text)![1]!;
    await http().post('/v1/auth/password-reset/request').send({ email: t.email }).expect(202);
    const mail = mailer.lastTo(t.email)!;
    expect(mail.template).toBe('auth.password_reset');
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    expect(token).not.toBe(firstToken);

    const newPassword = 'a brand new passphrase';
    const stale = await http().post('/v1/auth/password-reset/confirm').send({ token: firstToken, password: newPassword }).expect(400);
    expect(stale.body.error.code).toBe('RESET_LINK_INVALID');
    await http().post('/v1/auth/password-reset/confirm').send({ token, password: 'short' }).expect(400);
    await http().post('/v1/auth/password-reset/confirm').send({ token, password: newPassword }).expect(204);
    await http().post('/v1/auth/password-reset/confirm').send({ token, password: newPassword }).expect(400);

    await http().get('/v1/me').set(bearer(t.access)).expect(401);
    await login(t.email).expect(401);
    await login(t.email, newPassword).expect(200);
    expect(await platformEvents(t.userId)).toEqual(
      expect.arrayContaining(['auth.lockout', 'auth.password_reset.requested', 'auth.password_reset.completed']),
    );
  });

  it('does not bypass two-step sign-in', async () => {
    const t = await signup(app, 'resetmfa');
    await enroll(t.access);
    await http().post('/v1/auth/password-reset/request').send({ email: t.email }).expect(202);
    const token = /token=([\w-]+)/.exec(mailer.lastTo(t.email)!.text)![1]!;
    await http().post('/v1/auth/password-reset/confirm').send({ token, password: 'another long passphrase' }).expect(204);
    const res = await login(t.email, 'another long passphrase').expect(200);
    expect(res.body.mfaRequired).toBe(true);
  });
});

describe('auth audit events', () => {
  it('records sign-out and switching business in the tenant, refresh reuse at platform level', async () => {
    const a = await signup(app, 'auda');
    const b = await signup(app, 'audb');
    await asOwnerInTenant(owner, b.tenantId, (c) =>
      c.query('INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)', [b.tenantId, a.userId]),
    );

    await http().post('/v1/auth/switch-tenant').set(bearer(a.access)).send({ tenantId: b.tenantId }).expect(200);
    expect(await tenantEvents(b.tenantId, a.userId)).toContain('auth.switch_tenant');

    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: a.refresh }).expect(200);
    await http().post('/v1/auth/refresh').send({ refreshToken: a.refresh }).expect(401);
    expect(await platformEvents(a.userId)).toContain('auth.refresh_reuse');
    expect(r1.status).toBe(200);

    const fresh = (await login(b.email).expect(200)).body.tokens.accessToken;
    await http().post('/v1/auth/logout').set(bearer(fresh)).expect(204);
    expect(await tenantEvents(b.tenantId, b.userId)).toEqual(expect.arrayContaining(['auth.login', 'auth.logout']));
    // Tenant A sees none of B's events.
    expect(await tenantEvents(a.tenantId, b.userId)).toEqual([]);
  });
});

describe('response headers', () => {
  it('every answer carries HSTS, a no-content CSP and nosniff', async () => {
    const res = await http().get('/v1/health/live').expect(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
