import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, stepAt } from '../../src/auth/totp.js';
import { API_KEY_RULES } from '../../src/infrastructure/rate-limit.guard.js';
import { addMember, bearer, createApp, ownerPool, PASSWORD, signup, uniq } from './helpers.js';

/**
 * Audit 2026-10-31 (session 46): the team routes behind the two-step gate (#2), API keys and webhook
 * secrets never stored for replay (#3), turning two-step sign-in off from a token with no business
 * (#16), wrong codes on re-authentication count towards the lock (#17), and a rate limit per API key.
 */
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

const login = (email: string) => http().post('/v1/auth/login').send({ email, password: PASSWORD });
/** A code for a later time step: the current one may already be spent. */
const code = (secret: Buffer, offset = 1) => hotp(secret, stepAt(Date.now() / 1000) + offset);

async function enroll(token: string): Promise<Buffer> {
  const started = await http().post('/v1/auth/mfa/enroll').set(bearer(token)).send({ password: PASSWORD }).expect(200);
  const secret = base32Decode(started.body.secret);
  await http().post('/v1/auth/mfa/confirm').set(bearer(token)).send({ code: code(secret, 0) }).expect(200);
  return secret;
}

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

describe('team routes pass the two-step gate (#2)', () => {
  it('an owner past the grace period without two-step sign-in can neither reset a member nor list who has it', async () => {
    const t = await signup(app, 'a46-gate');
    const acct = await addMember(owner, t.tenantId, 'accountant');
    await http().get('/v1/members/mfa').set(bearer(t.access)).expect(200);
    await asPlatform(`UPDATE users SET privileged_since = now() - interval '8 days' WHERE id = $1`, [t.userId]);

    const listed = await http().get('/v1/members/mfa').set(bearer(t.access)).expect(403);
    expect(listed.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { enrolled: false } });
    const reset = await http().post(`/v1/members/${acct.membershipId}/reset-mfa`).set(bearer(t.access)).send({ reason: 'Lost phone' }).expect(403);
    expect(reset.body.error.code).toBe('MFA_REQUIRED');
  });

  it('a token with no business is asked to choose one', async () => {
    const t = await signup(app, 'a46-notenant');
    const refreshed = (await http().post('/v1/auth/refresh').send({ refreshToken: t.refresh }).expect(200)).body;
    expect(refreshed.activeTenantId).toBeNull();
    const res = await http().get('/v1/members/mfa').set(bearer(refreshed.tokens.accessToken)).expect(403);
    expect(res.body.error.code).toBe('TENANT_REQUIRED');
  });
});

describe('secrets are not kept for replay (#3)', () => {
  it('creating an API key or a webhook with an Idempotency-Key stores no answer', async () => {
    const t = await signup(app, 'a46-idem');
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId]);
    const idem = crypto.randomUUID();
    const body = { name: uniq('k'), scopes: ['org.read'] };
    const made = await http().post('/v1/api-keys').set(bearer(t.access)).set('Idempotency-Key', idem).send(body).expect(201);
    expect(made.body.key).toMatch(/^tlv_/);
    // Not replayed: the same request makes a second key (the admin form sends no key any more).
    const again = await http().post('/v1/api-keys').set(bearer(t.access)).set('Idempotency-Key', idem).send(body).expect(201);
    expect(again.body.key).not.toBe(made.body.key);
    const hook = await http().post('/v1/webhooks').set(bearer(t.access)).set('Idempotency-Key', crypto.randomUUID())
      .send({ url: 'https://hooks.example.com/tilvara', topics: ['sale.completed'] });
    expect([201, 422]).toContain(hook.status);

    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      const { rows } = await c.query<{ body: string }>(`SELECT coalesce(response_body::text, '') AS body FROM idempotency_records WHERE tenant_id = $1`, [t.tenantId]);
      await c.query('COMMIT');
      expect(rows.filter((r) => r.body.includes('tlv_') || r.body.includes('"secret"'))).toEqual([]);
    } finally {
      c.release();
    }
  });
});

describe('turning two-step sign-in off (#16)', () => {
  it('is refused from a token with no business while the person is privileged anywhere', async () => {
    const t = await signup(app, 'a46-off');
    const secret = await enroll(t.access);
    // A verified session, then a refresh that names no business.
    const ch = (await login(t.email).expect(200)).body.challengeToken;
    const verified = (await http().post('/v1/auth/mfa/verify').send({ challengeToken: ch, code: code(secret) }).expect(200)).body;
    const bare = (await http().post('/v1/auth/refresh').send({ refreshToken: verified.tokens.refreshToken }).expect(200)).body;
    const token = bare.tokens.accessToken as string;
    // With no business on the token, the token's own check says "not required": the old hole.
    expect(bare.activeTenantId).toBeNull();
    expect((await http().get('/v1/auth/mfa').set(bearer(token)).expect(200)).body.required).toBe(false);
    // Refused before the password and the code are looked at.
    const off = await http().post('/v1/auth/mfa/disable').set(bearer(token)).send({ password: PASSWORD, code: code(secret, 9) }).expect(409);
    expect(off.body.error.code).toBe('MFA_REQUIRED_FOR_ROLE');
    expect((await http().get('/v1/auth/mfa').set(bearer(t.access)).expect(200)).body.enabled).toBe(true);
  });

  it('a member who may turn it off loses the two-step mark on their sessions (migration 0136)', async () => {
    const t = await signup(app, 'a46-off2');
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const first = (await login(cashier.email).expect(200)).body.tokens;
    const secret = await enroll(first.accessToken); // confirming marks this session as verified
    expect((await http().get('/v1/auth/mfa').set(bearer(first.accessToken)).expect(200)).body.sessionVerified).toBe(true);
    const marked = () => asPlatform<{ n: number }>(`SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND mfa_verified_at IS NOT NULL`, [cashier.userId]);
    expect((await marked())[0]!.n).toBeGreaterThan(0);

    await http().post('/v1/auth/mfa/disable').set(bearer(first.accessToken)).send({ password: PASSWORD, code: code(secret) }).expect(204);
    expect((await http().get('/v1/auth/mfa').set(bearer(first.accessToken)).expect(200)).body).toMatchObject({ enabled: false, sessionVerified: false });
    expect((await marked())[0]!.n).toBe(0);
  });
});

describe('wrong codes on re-authentication count towards the lock (#17)', () => {
  it('five wrong codes across turning off, email change, closing and new recovery codes lock the account', async () => {
    const t = await signup(app, 'a46-lock');
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const token = (await login(cashier.email).expect(200)).body.tokens.accessToken as string;
    const secret = await enroll(token);
    const wrong = code(secret, 9);
    const as = (path: string, body: object) => http().post(path).set(bearer(token)).send({ password: PASSWORD, code: wrong, ...body });

    expect((await as('/v1/auth/mfa/disable', {}).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await as('/v1/auth/mfa/disable', {}).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await as('/v1/auth/email-change', { newEmail: `${uniq('new')}@example.ph` }).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await as('/v1/auth/account/close', {}).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await as('/v1/auth/mfa/recovery-codes', {}).expect(422)).body.error.code).toBe('INVALID_MFA_CODE');

    const [u] = await asPlatform<{ n: number; locked: boolean }>(`SELECT failed_login_count AS n, locked_until > now() AS locked FROM users WHERE id = $1`, [cashier.userId]);
    expect(u).toEqual({ n: 5, locked: true });
    // Locked: even the right code is not looked at, and sign-in is refused.
    const locked = await http().post('/v1/auth/mfa/recovery-codes').set(bearer(token)).send({ password: PASSWORD, code: code(secret, 2) }).expect(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await login(cashier.email).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('API keys are rate limited per key', () => {
  it(`allows ${API_KEY_RULES[0]!.limit} requests a minute per key; another key and a made-up one with the same prefix are not affected`, async () => {
    const t = await signup(app, 'a46-rl');
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId]);
    const newKey = async () =>
      (await http().post('/v1/api-keys').set(bearer(t.access)).send({ name: uniq('k'), scopes: ['org.read'] }).expect(201)).body.key as string;
    const [a, b] = [await newKey(), await newKey()];
    const limited = await createApp({ RATE_LIMITS_ENABLED: true, REDIS_URL: undefined });
    try {
      const get = (key: string) => request(limited.getHttpServer()).get('/v1/legal-entities').set({ Authorization: `ApiKey ${key}` });
      const limit = API_KEY_RULES[0]!.limit;
      // A made-up key with a's prefix counts on its own (and is refused as unknown).
      const fake = a.slice(0, 15) + 'x'.repeat(a.length - 15);
      for (let i = 0; i < 5; i++) await get(fake).expect(401);
      for (let i = 0; i < limit; i += 20) {
        const batch = await Promise.all(Array.from({ length: Math.min(20, limit - i) }, () => get(a)));
        expect(batch.map((r) => r.status).filter((s) => s !== 200)).toEqual([]);
      }
      const refused = await get(a).expect(429);
      expect(refused.body.error.code).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      await get(b).expect(200);
    } finally {
      await limited.close();
    }
  });
});
