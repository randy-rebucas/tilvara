import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadServerEnv, loadWorkerEnv, productionIssues } from '../src/index.js';

describe('loadWorkerEnv', () => {
  it('requires the worker its own database login in production', () => {
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://a:b@db/onepos' } as NodeJS.ProcessEnv)).toThrow(/WORKER_DATABASE_URL/);
    const dev = loadWorkerEnv({ DATABASE_URL: 'postgres://a:b@db/onepos', WORKER_DATABASE_URL: '' } as NodeJS.ProcessEnv);
    expect(dev.WORKER_DATABASE_URL).toBeUndefined();
  });
});

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:55460/onepos',
  JWT_ACCESS_SECRET: 'dev-only-change-me-dev-only-change-me',
} as NodeJS.ProcessEnv;

describe('loadServerEnv', () => {
  it('applies defaults', () => {
    const env = loadServerEnv(base);
    expect(env.API_PORT).toBe(4320);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it('lists every invalid variable without echoing secrets', () => {
    try {
      loadServerEnv({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'short-secret-value' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('JWT_ACCESS_SECRET');
      expect(msg).not.toContain('short-secret-value');
    }
  });

  it('refuses placeholder secrets in production', () => {
    expect(() => loadServerEnv({ ...base, NODE_ENV: 'production' })).toThrow(/placeholder/);
  });

  it('refuses disabled rate limits in production', () => {
    expect(() =>
      loadServerEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(48), RATE_LIMITS_ENABLED: 'false' }),
    ).toThrow(/RATE_LIMITS_ENABLED/);
  });

  it('refuses the dev mailer in production (no real provider exists yet)', () => {
    expect(() => loadServerEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(48) })).toThrow(/MAILER_DRIVER/);
  });

  it('treats blank PayMongo keys as unset and checks the format of set ones without echoing them', () => {
    const env = loadServerEnv({ ...base, PAYMONGO_SECRET_KEY: '', PAYMONGO_PUBLIC_KEY: '', PAYMONGO_WEBHOOK_SECRET: '' });
    expect(env.PAYMONGO_SECRET_KEY).toBeUndefined();
    const ok = loadServerEnv({ ...base, PAYMONGO_SECRET_KEY: 'sk_test_abc123', PAYMONGO_WEBHOOK_SECRET: 'whsk_abc123' });
    expect(ok.PAYMONGO_SECRET_KEY).toBe('sk_test_abc123');
    try {
      loadServerEnv({ ...base, PAYMONGO_SECRET_KEY: 'pk_test_swapped', PAYMONGO_WEBHOOK_SECRET: 'nope' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PAYMONGO_SECRET_KEY');
      expect(msg).toContain('PAYMONGO_WEBHOOK_SECRET');
      expect(msg).not.toContain('pk_test_swapped');
    }
  });

  it('refuses live PayMongo keys outside production', () => {
    expect(() => loadServerEnv({ ...base, PAYMONGO_SECRET_KEY: 'sk_live_abc123' })).toThrow(/live keys are only allowed in production/);
  });

  it('accepts a real secret with otherwise production-safe settings', () => {
    const env = loadServerEnv({
      ...base,
      JWT_ACCESS_SECRET: 'x'.repeat(48),
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      REDIS_URL: 'redis://cache.internal:6379/0',
    });
    expect(productionIssues(env)).toEqual([
      'MAILER_DRIVER: the dev mailer cannot be used in production (no real email provider configured yet)',
      'PAYMENT_PROVIDER: the dev payment simulator cannot be used in production',
    ]);
  });

  it('requires Redis for shared rate limits in production', () => {
    const env = loadServerEnv({ ...base, JWT_ACCESS_SECRET: 'x'.repeat(48) });
    expect(productionIssues(env)).toContain('REDIS_URL: required in production (rate limits shared across API replicas)');
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it('requires an MFA encryption key in production and checks its format without echoing it', () => {
    const env = loadServerEnv({ ...base, JWT_ACCESS_SECRET: 'x'.repeat(48) });
    expect(productionIssues(env)).toContain('MFA_ENCRYPTION_KEY: required in production (32 random bytes, base64)');
    try {
      loadServerEnv({ ...base, MFA_ENCRYPTION_KEY: 'too-short-key' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('MFA_ENCRYPTION_KEY');
      expect((e as Error).message).not.toContain('too-short-key');
    }
  });
});
