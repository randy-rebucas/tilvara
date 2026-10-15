import type { INestApplication } from '@nestjs/common';
import { createLogger } from '@1pos/observability';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApp, PASSWORD, signup } from './helpers.js';

let app: INestApplication;
const raw: string[] = [];
const lines = () => raw.map((l) => JSON.parse(l) as Record<string, unknown>);
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const destination = new Writable({
    write(chunk, _enc, cb) {
      raw.push(String(chunk));
      cb();
    },
  });
  app = await createApp({}, createLogger({ service: 'api', level: 'debug', destination }));
});

afterAll(async () => {
  await app.close();
});

/** 'finish' fires after supertest resolves; wait for the line to land. */
async function accessLine(correlationId: string | undefined) {
  for (let i = 0; i < 50; i++) {
    const hit = lines().find((l) => l.msg === 'request completed' && l.correlation_id === correlationId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no access log for ${correlationId}`);
}

describe('structured request logging', () => {
  it('logs route pattern, status and verified tenant/user ids — never query strings or credentials', async () => {
    const t = await signup(app, 'logs');
    const res = await http().get('/v1/products').query({ q: 'juan-dela-cruz-search' }).set(bearer(t.access)).expect(200);
    const line = await accessLine(res.headers['x-correlation-id']);
    expect(line).toMatchObject({
      service: 'api',
      level: 'info',
      method: 'GET',
      route: '/v1/products',
      status: 200,
      tenant_id: t.tenantId,
      user_id: t.userId,
    });
    expect(typeof line.duration_ms).toBe('number');

    const all = raw.join('\n');
    for (const secret of ['juan-dela-cruz-search', t.access, t.refresh, PASSWORD]) expect(all).not.toContain(secret);
  });

  it('uses a well-formed client correlation id and leaves identity out when unauthenticated', async () => {
    const res = await http().get('/v1/me').set('X-Correlation-Id', 'client-corr-0001').expect(401);
    expect(res.headers['x-correlation-id']).toBe('client-corr-0001');
    const line = await accessLine('client-corr-0001');
    expect(line).toMatchObject({ route: '/v1/me', status: 401 });
    expect(line).not.toHaveProperty('user_id');
    expect(line).not.toHaveProperty('tenant_id');
  });

  it('logs unmatched paths without a route pattern', async () => {
    const res = await http().get('/v1/definitely-not-a-route').expect(404);
    const line = await accessLine(res.headers['x-correlation-id']);
    expect(line).toMatchObject({ path: '/v1/definitely-not-a-route', status: 404 });
    expect(line).not.toHaveProperty('route');
  });

  it('a token for one tenant never tags log lines with another tenant', async () => {
    const [a, b] = await Promise.all([signup(app, 'log-a'), signup(app, 'log-b')]);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => http().get('/v1/me').set(bearer(i % 2 ? b.access : a.access)).expect(200)),
    );
    for (const [i, res] of responses.entries()) {
      const line = await accessLine(res.headers['x-correlation-id']);
      expect(line.tenant_id).toBe(i % 2 ? b.tenantId : a.tenantId);
    }
  });
});
