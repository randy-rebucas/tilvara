import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rekeyMfaSecrets, UnreadableSecretsError } from '../../src/auth/mfa-rekey.js';
import { base32Decode, hotp, SecretBox, stepAt } from '../../src/auth/totp.js';
import { DevMailer } from '../../src/notifications/mailer.js';
import { addMember, bearer, createApp, ownerPool, PASSWORD, signup, uniq, type SignedUp } from './helpers.js';

/**
 * A person's own account (privacy pack gaps, ADR-0016 slice 8 follow-up): correcting their name and
 * sign-in email, closing the account, and the ops commands that block and unblock one.
 */
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
const code = (secret: Buffer, offset = 1) => hotp(secret, stepAt(Date.now() / 1000) + offset);

async function enroll(token: string): Promise<Buffer> {
  const started = await http().post('/v1/auth/mfa/enroll').set(bearer(token)).send({ password: PASSWORD }).expect(200);
  const secret = base32Decode(started.body.secret);
  await http().post('/v1/auth/mfa/confirm').set(bearer(token)).send({ code: code(secret, 0) }).expect(200);
  return secret;
}

/** As onepos_platform (BYPASSRLS): users, credential tables and NULL-tenant audit rows. */
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

const platformEvents = async (userId: string) =>
  asPlatform<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM audit_logs WHERE tenant_id IS NULL AND resource_id = $1::text ORDER BY occurred_at, id`,
    [userId],
  );

const mailsTo = (email: string) => mailer.sent.filter((m) => m.to === email.toLowerCase());
const linkToken = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1];

/** A member of nobody: signs up, then the business removes them (the owner stays the owner of it). */
async function memberOfNobody(): Promise<{ email: string; userId: string; access: string; tenant: SignedUp }> {
  const tenant = await signup(app, 'closing');
  const member = await addMember(owner, tenant.tenantId, 'cashier');
  await http().post(`/v1/members/${member.membershipId}/remove`).set(bearer(tenant.access)).expect(200);
  const res = await login(member.email).expect(200);
  return { email: member.email, userId: member.userId, access: res.body.tokens.accessToken, tenant };
}

describe('own name', () => {
  it('a person corrects their own name; the audit row names the field, not the values', async () => {
    const s = await signup(app, 'rename');
    const res = await http().patch('/v1/me').set(bearer(s.access)).send({ displayName: '  Maria Santos  ' }).expect(200);
    expect(res.body).toEqual({ email: s.email, displayName: 'Maria Santos' });
    expect((await http().get('/v1/me').set(bearer(s.access)).expect(200)).body.user.displayName).toBe('Maria Santos');

    const events = await platformEvents(s.userId);
    const updated = events.find((e) => e.action === 'auth.profile.updated');
    expect(updated?.metadata).toEqual({ fields: ['displayName'] });
    expect(JSON.stringify(events)).not.toContain('Maria');

    await http().patch('/v1/me').set(bearer(s.access)).send({ displayName: '   ' }).expect(400);
    await http().patch('/v1/me').send({ displayName: 'Nobody' }).expect(401);
  });
});

describe('own sign-in email', () => {
  it('checks the password and refuses the same or a taken address', async () => {
    const s = await signup(app, 'mail-checks');
    const other = await signup(app, 'mail-other');
    const r1 = await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail: `${uniq('n')}@example.ph`, password: 'not the password' }).expect(403);
    expect(r1.body.error.code).toBe('WRONG_PASSWORD');
    const r2 = await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail: s.email.toUpperCase(), password: PASSWORD }).expect(409);
    expect(r2.body.error.code).toBe('SAME_EMAIL');
    const r3 = await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail: other.email, password: PASSWORD }).expect(409);
    expect(r3.body.error.code).toBe('EMAIL_UNAVAILABLE');
    expect(mailsTo(other.email).filter((m) => m.template.startsWith('auth.email_change'))).toEqual([]);
  });

  it('changes only through the link sent to the new address, then signs out everywhere', async () => {
    const s = await signup(app, 'mail-move');
    const second = await login(s.email).expect(200); // another device
    const newEmail = `${uniq('moved')}@example.ph`;

    const asked = await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD }).expect(202);
    expect(asked.body.newEmail).toBe(newEmail);
    const confirmMail = mailsTo(newEmail).find((m) => m.template === 'auth.email_change.confirm')!;
    const notice = mailsTo(s.email).find((m) => m.template === 'auth.email_change.requested')!;
    expect(notice.text).not.toContain(newEmail); // masked: the old inbox learns the domain, not the address
    expect(notice.text).toContain(`${newEmail[0]}***@example.ph`);

    // Nothing has changed yet.
    await login(s.email).expect(200);
    await http().get('/v1/me').set(bearer(s.access)).expect(200);

    // Asking again makes the first link useless.
    await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD }).expect(202);
    const links = mailsTo(newEmail).filter((m) => m.template === 'auth.email_change.confirm');
    expect(links).toHaveLength(2);
    const stale = await http().post('/v1/auth/email-change/confirm').send({ token: linkToken(confirmMail.text) }).expect(400);
    expect(stale.body.error.code).toBe('EMAIL_CHANGE_LINK_INVALID');

    // A reset link mailed to the old address before the change must stop working after it.
    await http().post('/v1/auth/password-reset/request').send({ email: s.email }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    const resetToken = linkToken(mailsTo(s.email).find((m) => m.template === 'auth.password_reset')!.text)!;

    await http().post('/v1/auth/email-change/confirm').send({ token: linkToken(links[1]!.text) }).expect(204);
    await http().get('/v1/me').set(bearer(s.access)).expect(401);
    await http().get('/v1/me').set(bearer(second.body.tokens.accessToken)).expect(401);
    await http().post('/v1/auth/refresh').send({ refreshToken: s.refresh }).expect(401);
    expect((await login(s.email).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    const back = await login(newEmail).expect(200);
    expect(back.body.user.email).toBe(newEmail);
    await new Promise((r) => setTimeout(r, 50));
    expect(mailsTo(s.email).some((m) => m.template === 'auth.email_change.completed')).toBe(true);
    await http().post('/v1/auth/password-reset/confirm').send({ token: resetToken, password: 'a brand new long password' }).expect(400);

    // The link works once.
    await http().post('/v1/auth/email-change/confirm').send({ token: linkToken(links[1]!.text) }).expect(400);
    const actions = (await platformEvents(s.userId)).map((e) => e.action);
    expect(actions.filter((a) => a.startsWith('auth.email_change'))).toEqual([
      'auth.email_change.requested',
      'auth.email_change.requested',
      'auth.email_change.completed',
    ]);
    const sessions = await asPlatform<{ reason: string }>(`SELECT DISTINCT revoke_reason AS reason FROM user_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`, [s.userId]);
    expect(sessions.map((r) => r.reason)).toContain('EMAIL_CHANGED');
  });

  it('refuses an expired link, and an address another account took in the meantime', async () => {
    const s = await signup(app, 'mail-late');
    const newEmail = `${uniq('late')}@example.ph`;
    await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD }).expect(202);
    const token = linkToken(mailsTo(newEmail).at(-1)!.text)!;
    await asPlatform(`UPDATE email_change_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [s.userId]);
    await http().post('/v1/auth/email-change/confirm').send({ token }).expect(400);

    const raced = `${uniq('raced')}@example.ph`;
    await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail: raced, password: PASSWORD }).expect(202);
    const racedToken = linkToken(mailsTo(raced).at(-1)!.text)!;
    await http()
      .post('/v1/auth/signup')
      .send({ email: raced, password: PASSWORD, displayName: 'Someone else', businessName: 'Other', tenantSlug: uniq('raced') })
      .expect(201);
    const r = await http().post('/v1/auth/email-change/confirm').send({ token: racedToken }).expect(409);
    expect(r.body.error.code).toBe('EMAIL_UNAVAILABLE');
    expect((await http().get('/v1/me').set(bearer(s.access)).expect(200)).body.user.email).toBe(s.email);
  });

  it('with two-step sign-in on, also needs a current code', async () => {
    const s = await signup(app, 'mail-mfa');
    const secret = await enroll(s.access);
    const newEmail = `${uniq('mfa')}@example.ph`;
    const r = await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD }).expect(422);
    expect(r.body.error.code).toBe('MFA_CODE_REQUIRED');
    await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD, code: '000000' }).expect(422);
    await http().post('/v1/auth/email-change').set(bearer(s.access)).send({ newEmail, password: PASSWORD, code: code(secret) }).expect(202);
  });
});

describe('closing one’s own account', () => {
  it('is refused while the person still belongs to a business, naming it', async () => {
    const s = await signup(app, 'owner-stays');
    const status = await http().get('/v1/auth/account/closure').set(bearer(s.access)).expect(200);
    expect(status.body).toEqual({ canClose: false, businesses: [expect.stringMatching(/^Biz owner-stays-/)], staff: false });
    const r = await http().post('/v1/auth/account/close').set(bearer(s.access)).send({ password: PASSWORD }).expect(409);
    expect(r.body.error).toMatchObject({ code: 'ACCOUNT_CLOSURE_BLOCKED', details: { businesses: status.body.businesses, staff: false } });
    await http().get('/v1/me').set(bearer(s.access)).expect(200);
  });

  it('is refused for active 1POS support staff', async () => {
    const p = await memberOfNobody();
    await asPlatform(`INSERT INTO platform_staff (user_id, status, added_by, added_reason) VALUES ($1, 'ACTIVE', 'test', 'closure test')`, [p.userId]);
    const status = await http().get('/v1/auth/account/closure').set(bearer(p.access)).expect(200);
    expect(status.body).toEqual({ canClose: false, businesses: [], staff: true });
    await http().post('/v1/auth/account/close').set(bearer(p.access)).send({ password: PASSWORD }).expect(409);
  });

  it('blocks the account at once and removes what it no longer needs', async () => {
    const p = await memberOfNobody();
    const secret = await enroll(p.access);
    expect((await http().get('/v1/auth/account/closure').set(bearer(p.access)).expect(200)).body).toEqual({ canClose: true, businesses: [], staff: false });

    await http().post('/v1/auth/account/close').set(bearer(p.access)).send({ password: 'wrong password!' }).expect(403);
    expect((await http().post('/v1/auth/account/close').set(bearer(p.access)).send({ password: PASSWORD }).expect(422)).body.error.code).toBe('MFA_CODE_REQUIRED');
    await http().post('/v1/auth/account/close').set(bearer(p.access)).send({ password: PASSWORD, code: code(secret) }).expect(204);

    await http().get('/v1/me').set(bearer(p.access)).expect(401);
    expect((await login(p.email).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    const before = mailer.sent.length;
    await http().post('/v1/auth/password-reset/request').send({ email: p.email }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(mailer.sent.length).toBe(before);

    const [user] = await asPlatform<{ status: string; closed: boolean }>(`SELECT status, closed_at IS NOT NULL AS closed FROM users WHERE id = $1`, [p.userId]);
    expect(user).toEqual({ status: 'DISABLED', closed: true });
    const left = await asPlatform<{ factors: number; codes: number; open: number }>(
      `SELECT (SELECT count(*)::int FROM user_mfa_factors WHERE user_id = $1) AS factors,
              (SELECT count(*)::int FROM user_mfa_recovery_codes WHERE user_id = $1) AS codes,
              (SELECT count(*)::int FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL) AS open`,
      [p.userId],
    );
    expect(left).toEqual([{ factors: 0, codes: 0, open: 0 }]);
    expect((await platformEvents(p.userId)).map((e) => e.action)).toContain('auth.account.closed');

    // The address stays taken until the account is anonymised (retention schedule).
    const again = await http()
      .post('/v1/auth/signup')
      .send({ email: p.email, password: PASSWORD, displayName: 'Again', businessName: 'Again', tenantSlug: uniq('again') })
      .expect(409);
    expect(again.body.error.code).toBe('EMAIL_UNAVAILABLE');
  });

  it('the database refuses a closure that skips the checks', async () => {
    const s = await signup(app, 'db-guard');
    await expect(asPlatform('SELECT auth_account_close($1, NULL)', [s.userId])).rejects.toMatchObject({ constraint: 'account_closure_blocked' });
  });
});

describe('rotating MFA_ENCRYPTION_KEY (mfa-rekey)', () => {
  const jwt = () => process.env.JWT_ACCESS_SECRET!;
  const oldKey = Buffer.alloc(32, 11).toString('base64');
  const newKey = Buffer.alloc(32, 12).toString('base64');
  const ops = { actor: 'ops-test', reason: 'scheduled key rotation', ticket: 'CHG-1' };

  it('re-seals with the new key, all or nothing, and two-step sign-in keeps working on the new key alone', async () => {
    const before = await createApp({ MFA_ENCRYPTION_KEY: oldKey });
    let userId: string;
    let email: string;
    let secret: Buffer;
    try {
      const s = await signup(before, 'rekey');
      userId = s.userId;
      email = s.email;
      const started = await request(before.getHttpServer()).post('/v1/auth/mfa/enroll').set(bearer(s.access)).send({ password: PASSWORD }).expect(200);
      secret = base32Decode(started.body.secret);
      await request(before.getHttpServer()).post('/v1/auth/mfa/confirm').set(bearer(s.access)).send({ code: code(secret, 0) }).expect(200);
    } finally {
      await before.close();
    }
    const sealed = async () => (await asPlatform<{ s: string }>('SELECT secret_ciphertext AS s FROM user_mfa_factors WHERE user_id = $1', [userId]))[0]!.s;
    const original = await sealed();

    const c = await owner.connect();
    try {
      // A wrong "previous" key: the run refuses and changes nothing.
      const wrong = new SecretBox(newKey, jwt(), Buffer.alloc(32, 13).toString('base64'));
      await expect(rekeyMfaSecrets(c, wrong, { ...ops, userIds: [userId] })).rejects.toBeInstanceOf(UnreadableSecretsError);
      expect(await sealed()).toBe(original);

      const rotating = new SecretBox(newKey, jwt(), oldKey);
      expect(await rekeyMfaSecrets(c, rotating, { ...ops, userIds: [userId], check: true })).toEqual({ total: 1, resealed: 1, alreadyCurrent: 0 });
      expect(await sealed()).toBe(original);
      expect(await rekeyMfaSecrets(c, rotating, { ...ops, userIds: [userId] })).toEqual({ total: 1, resealed: 1, alreadyCurrent: 0 });
      expect(await sealed()).not.toBe(original);
      expect(await rekeyMfaSecrets(c, rotating, { ...ops, userIds: [userId] })).toEqual({ total: 1, resealed: 0, alreadyCurrent: 1 });
      await expect(rekeyMfaSecrets(c, rotating, { ...ops, reason: '', userIds: [userId] })).rejects.toThrow(/reason/);
    } finally {
      c.release();
    }
    const audit = await asPlatform<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE tenant_id IS NULL AND action = 'platform.mfa.rekeyed' AND metadata->>'ticket' = 'CHG-1' ORDER BY occurred_at DESC, id DESC LIMIT 2`,
    );
    expect(audit.map((a) => a.metadata.resealed)).toEqual([0, 1]);

    // The old key is retired: the API runs with the new key only, and the person still signs in with their app.
    const after = await createApp({ MFA_ENCRYPTION_KEY: newKey });
    try {
      const login = await request(after.getHttpServer()).post('/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
      expect(login.body.mfaRequired).toBe(true);
      await request(after.getHttpServer()).post('/v1/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: code(secret, 1) }).expect(200);
    } finally {
      await after.close();
    }
  });
});

describe('ops: disabling and enabling an account (support CLI functions)', () => {
  it('disable ends every session at its next request and is audited with the ticket; enable lets the person back', async () => {
    const s = await signup(app, 'ops-disable');
    const id = (await owner.query<{ v: string }>('SELECT platform_account_disable($1, $2, $3, $4) AS v', [s.email.toUpperCase(), 'ops-test', 'security incident drill', 'INC-1'])).rows[0]!.v;
    expect(id).toBe(s.userId);
    await http().get('/v1/me').set(bearer(s.access)).expect(401);
    await login(s.email).expect(401);
    // Disabling twice changes nothing more.
    expect((await owner.query('SELECT platform_account_disable($1, $2, $3, $4) AS v', [s.email, 'ops-test', 'again please', 'INC-1'])).rows[0].v).toBeNull();

    expect((await owner.query('SELECT platform_account_enable($1, $2, $3, $4) AS v', [s.email, 'ops-test', 'owner verified by call-back', 'INC-1'])).rows[0].v).toBe(s.userId);
    await http().get('/v1/me').set(bearer(s.access)).expect(401); // old sessions stay ended
    await login(s.email).expect(200);

    const events = (await platformEvents(s.userId)).filter((e) => e.action.startsWith('platform.user'));
    expect(events).toEqual([
      { action: 'platform.user.disabled', metadata: { actor: 'ops-test', reason: 'security incident drill', ticket: 'INC-1' } },
      { action: 'platform.user.enabled', metadata: { actor: 'ops-test', reason: 'owner verified by call-back', ticket: 'INC-1', wasClosed: false } },
    ]);
  });

  it('enable reopens a closed account; both need a reason and a ticket; the runtime role may call neither', async () => {
    const p = await memberOfNobody();
    await http().post('/v1/auth/account/close').set(bearer(p.access)).send({ password: PASSWORD }).expect(204);
    await expect(owner.query('SELECT platform_account_enable($1, $2, $3, $4)', [p.email, 'ops-test', 'why', ''])).rejects.toMatchObject({ code: '22023' });
    await owner.query('SELECT platform_account_enable($1, $2, $3, $4)', [p.email, 'ops-test', 'person asked to come back', 'DSR-7']);
    await login(p.email).expect(200);
    const [user] = await asPlatform<{ closed: boolean }>(`SELECT closed_at IS NOT NULL AS closed FROM users WHERE id = $1`, [p.userId]);
    expect(user!.closed).toBe(false);
    expect((await platformEvents(p.userId)).at(-1)!.metadata).toMatchObject({ wasClosed: true, ticket: 'DSR-7' });

    const runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      for (const fn of ['platform_account_disable', 'platform_account_enable']) {
        await expect(runtime.query(`SELECT ${fn}($1, 'x', 'reason text', 't')`, [p.email])).rejects.toMatchObject({ code: '42501' });
      }
      await expect(runtime.query('SELECT * FROM email_change_tokens')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.end();
    }
  });
});
