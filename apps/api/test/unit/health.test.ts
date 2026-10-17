import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp } from '../../src/bootstrap.js';
import { HealthController } from '../../src/health/health.controller.js';
import { DatabasePool } from '../../src/infrastructure/database.provider.js';
import { MonitoringService, type SchemaState } from '../../src/infrastructure/monitoring.service.js';
import { RateLimitStore } from '../../src/infrastructure/rate-limit.store.js';

interface Deps {
  dbUp?: boolean;
  schema?: SchemaState;
  redis?: 'up' | 'down' | 'disabled';
}

async function buildApp({ dbUp = true, schema = 'up', redis = 'disabled' }: Deps = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DatabasePool, useValue: { ping: async () => dbUp } },
      { provide: MonitoringService, useValue: { schemaState: async () => schema } },
      { provide: RateLimitStore, useValue: { backend: redis === 'disabled' ? 'memory' : 'redis', ping: async () => redis === 'up' } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
});

describe('health endpoints', () => {
  it('reports liveness and mints a correlation id', async () => {
    app = await buildApp();
    const res = await request(app.getHttpServer()).get('/v1/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed client correlation id and rejects malformed ones', async () => {
    app = await buildApp();
    const ok = await request(app.getHttpServer()).get('/v1/health/live').set('X-Correlation-Id', 'pos-term-01:abc123');
    expect(ok.headers['x-correlation-id']).toBe('pos-term-01:abc123');
    const bad = await request(app.getHttpServer()).get('/v1/health/live').set('X-Correlation-Id', '<script>');
    expect(bad.headers['x-correlation-id']).not.toBe('<script>');
  });

  it('is ready with the database up and the schema at head', async () => {
    app = await buildApp({ redis: 'up' });
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', migrations: 'up', redis: 'up' } });
  });

  it('returns 503 with the standard error envelope when the database is down', async () => {
    app = await buildApp({ dbUp: false });
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(503);
    expect(res.body.error.code).toBe('NOT_READY');
    expect(res.body.error.details.checks).toEqual({ database: 'down', migrations: 'unknown', redis: 'disabled' });
    expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('is not ready while the database lacks this build\'s migrations', async () => {
    app = await buildApp({ schema: 'behind' });
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(503);
    expect(res.body.error.details.checks.migrations).toBe('behind');
  });

  it('stays ready but degraded when Redis is down (limits fall back per instance)', async () => {
    app = await buildApp({ redis: 'down' });
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'degraded', checks: { database: 'up', migrations: 'up', redis: 'down' } });
  });

  it('returns 404 in the standard envelope for unknown routes', async () => {
    app = await buildApp();
    const res = await request(app.getHttpServer()).get('/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
