import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimitStore } from '../../src/infrastructure/rate-limit.store.js';
import { createApp, PASSWORD, signup } from './helpers.js';

/**
 * ADR-0016 slice 2: shared rate limits. Two API instances on one Redis count together; a dead
 * Redis falls back to per-instance counting (still limited, sign-in still works); account and
 * terminal keys. Needs the compose Redis (TEST_REDIS_URL, from REDIS_URL in .env).
 */
const REDIS = process.env.TEST_REDIS_URL;
const limited = (prefix: string, redis: string | undefined = REDIS) =>
  createApp({ RATE_LIMITS_ENABLED: true, REDIS_URL: redis, RATE_LIMIT_PREFIX: `test:${prefix}:` });

describe.skipIf(!REDIS)('rate limits shared through Redis', () => {
  let a: INestApplication;
  let b: INestApplication;

  beforeAll(async () => {
    const prefix = randomUUID();
    [a, b] = await Promise.all([limited(prefix), limited(prefix)]);
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  it('uses Redis and answers its ping', async () => {
    const store = a.get(RateLimitStore);
    expect(store.backend).toBe('redis');
    expect(await store.ping()).toBe(true);
  });

  it('two replicas share one signup allowance (5 per 10 min per IP)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const app = i % 2 === 0 ? a : b;
      statuses.push((await request(app.getHttpServer()).post('/v1/auth/signup').send({})).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    const refused = await request(b.getHttpServer()).post('/v1/auth/signup').send({});
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(500);
    expect(a.get(RateLimitStore).fallbacks + b.get(RateLimitStore).fallbacks).toBe(0);
  });

  it('password reset mails are capped per account across addresses and replicas', async () => {
    const email = `limit-${randomUUID().slice(0, 8)}@example.ph`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const app = i % 2 === 0 ? a : b;
      // A different upper/lower-case spelling is still the same account.
      const res = await request(app.getHttpServer()).post('/v1/auth/password-reset/request').send({ email: i === 3 ? email.toUpperCase() : email });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('login is capped per account (10 per 10 min) as well as per IP', async () => {
    const prefix = randomUUID();
    const c = await limited(prefix);
    try {
      const email = `acct-${randomUUID().slice(0, 8)}@example.ph`;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await request(c.getHttpServer()).post('/v1/auth/login').send({ email, password: 'whatever12345' })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      // Another account from the same address is not affected by that account's cap.
      const other = await request(c.getHttpServer()).post('/v1/auth/login').send({ email: `x${email}`, password: 'whatever12345' });
      expect(other.status).toBe(401);
    } finally {
      await c.close();
    }
  });

  it('sync is capped per terminal, and made-up terminal ids share the per-IP cap', async () => {
    const prefix = randomUUID();
    const c = await limited(prefix);
    try {
      const store = c.get(RateLimitStore);
      // Arrange counters directly: 600 hits for one terminal, 2,999 from this IP.
      const terminal = randomUUID();
      for (let i = 0; i < 600; i++) await store.hit(`terminal:term:${terminal}`, 60_000);
      const own = await request(c.getHttpServer()).get('/v1/terminal/snapshot').set('x-terminal-id', terminal);
      expect(own.status).toBe(429);
      // A fresh (forged) terminal id is not limited by that terminal's counter…
      const forged = await request(c.getHttpServer()).get('/v1/terminal/snapshot').set('x-terminal-id', randomUUID());
      expect(forged.status).toBe(401);
      // …but every request also counts against the address. Fill the per-IP counter for each form
      // Express may report for a loopback client.
      for (const addr of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
        for (let i = 0; i < 3000; i += 500) await Promise.all(Array.from({ length: 500 }, () => store.hit(`terminal-ip:ip:${addr}`, 60_000)));
      }
      const flooded = await request(c.getHttpServer()).get('/v1/terminal/snapshot').set('x-terminal-id', randomUUID());
      expect(flooded.status).toBe(429);
    } finally {
      await c.close();
    }
  });
});

describe('rate limits when Redis is down', () => {
  it('fall back to counting in the instance: still limited, and sign-in still works', async () => {
    // Nothing listens on port 1: every Redis call fails fast.
    const app = await limited(randomUUID(), 'redis://127.0.0.1:1/0');
    try {
      const store = app.get(RateLimitStore);
      expect(store.backend).toBe('redis');
      expect(await store.ping()).toBe(false);
      const s = await signup(app, 'nored');
      const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: s.email, password: PASSWORD });
      expect(login.status).toBe(200);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(app.getHttpServer()).post('/v1/auth/signup').send({})).status);
      // One signup already used the allowance above: 4 more pass, the 6th in the window is refused.
      expect(statuses).toEqual([400, 400, 400, 400, 429]);
      expect(store.fallbacks).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
