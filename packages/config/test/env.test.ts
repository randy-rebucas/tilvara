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
    expect([env.API_METRICS_PORT, env.METRICS_HOST]).toEqual([4329, '127.0.0.1']);
  });

  it('never serves metrics on the public listener', () => {
    expect(() => loadServerEnv({ ...base, API_PORT: '4320', API_METRICS_PORT: '4320' })).toThrow(/API_METRICS_PORT: must differ/);
    expect(loadServerEnv({ ...base, API_METRICS_PORT: '0' }).API_METRICS_PORT).toBe(0);
  });

  it('requires a metrics token in production once metrics listen beyond loopback (API and worker)', () => {
    const prod = { ...base, JWT_ACCESS_SECRET: 'x'.repeat(48) };
    const issue = /METRICS_TOKEN: required in production when METRICS_HOST \(0\.0\.0\.0\) is not a loopback address/;
    expect(productionIssues(loadServerEnv(prod)).join('\n')).not.toMatch(/METRICS_TOKEN/);
    expect(productionIssues(loadServerEnv({ ...prod, METRICS_HOST: '0.0.0.0' })).join('\n')).toMatch(issue);
    expect(productionIssues(loadServerEnv({ ...prod, METRICS_HOST: '0.0.0.0', API_METRICS_PORT: '0' })).join('\n')).not.toMatch(/METRICS_TOKEN/);
    expect(productionIssues(loadServerEnv({ ...prod, METRICS_HOST: '0.0.0.0', METRICS_TOKEN: 't'.repeat(32) })).join('\n')).not.toMatch(/METRICS_TOKEN/);
    expect(loadServerEnv({ ...base, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(() => loadServerEnv({ ...base, METRICS_TOKEN: 'short-token' })).toThrow(/METRICS_TOKEN: must be at least 32 characters/);
    const worker = { NODE_ENV: 'production', DATABASE_URL: base.DATABASE_URL, WORKER_DATABASE_URL: base.DATABASE_URL, METRICS_HOST: '0.0.0.0' } as NodeJS.ProcessEnv;
    expect(() => loadWorkerEnv(worker)).toThrow(issue);
    expect(() => loadWorkerEnv({ ...worker, METRICS_TOKEN: 't'.repeat(32) })).not.toThrow(/METRICS_TOKEN/);
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
      WEBHOOK_SIGNING_KEY: 'w'.repeat(40),
    });
    expect(productionIssues(env)).toEqual([
      'MAILER_DRIVER: the dev mailer cannot be used in production (no real email provider configured yet)',
      'PAYMENT_PROVIDER: the dev payment simulator cannot be used in production',
      'FILE_STORAGE_DRIVER: the dev file storage (a local folder) cannot be used in production (object storage waits for D1)',
    ]);
  });

  it('webhooks (session 20): a real signing key in production, and never http or private addresses there', () => {
    const dev = loadServerEnv(base);
    expect(dev.WEBHOOK_ALLOW_INSECURE).toBe(false);
    expect(productionIssues(dev)).toContain('WEBHOOK_SIGNING_KEY: development placeholder used in production');
    expect(productionIssues(loadServerEnv({ ...base, WEBHOOK_ALLOW_INSECURE: 'true' }))).toContain('WEBHOOK_ALLOW_INSECURE: webhooks to http or private addresses cannot be allowed in production');
    expect(() => loadServerEnv({ ...base, WEBHOOK_SIGNING_KEY: 'short' })).toThrow(/WEBHOOK_SIGNING_KEY/);
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', DATABASE_URL: base.DATABASE_URL, WORKER_DATABASE_URL: base.DATABASE_URL })).toThrow(/WEBHOOK_SIGNING_KEY: development placeholder/);
  });

  it('data exports (ADR-0016 slice 6): links last 10 minutes by default; the worker refuses dev storage in production', () => {
    const env = loadServerEnv(base);
    expect([env.FILE_STORAGE_DRIVER, env.DATA_EXPORT_LINK_SECONDS]).toEqual(['dev', 600]);
    expect(() => loadServerEnv({ ...base, DATA_EXPORT_LINK_SECONDS: '5' })).toThrow(/DATA_EXPORT_LINK_SECONDS/);
    const worker = loadWorkerEnv({ DATABASE_URL: base.DATABASE_URL });
    expect([worker.FILE_STORAGE_DIR, worker.DATA_EXPORT_RETENTION_DAYS]).toEqual([env.FILE_STORAGE_DIR, 7]);
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', DATABASE_URL: base.DATABASE_URL, WORKER_DATABASE_URL: base.DATABASE_URL, MAILER_DRIVER: 'dev' })).toThrow(
      /FILE_STORAGE_DRIVER: the dev file storage/,
    );
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

  it('accepts a previous MFA key only during a rotation: beside a different current key', () => {
    const current = Buffer.alloc(32, 1).toString('base64');
    const previous = Buffer.alloc(32, 2).toString('base64');
    expect(loadServerEnv({ ...base, MFA_ENCRYPTION_KEY: current, MFA_ENCRYPTION_KEY_PREVIOUS: previous }).MFA_ENCRYPTION_KEY_PREVIOUS).toBe(previous);
    expect(() => loadServerEnv({ ...base, MFA_ENCRYPTION_KEY_PREVIOUS: previous })).toThrow(/set only while rotating/);
    expect(() => loadServerEnv({ ...base, MFA_ENCRYPTION_KEY: current, MFA_ENCRYPTION_KEY_PREVIOUS: current })).toThrow(/must differ/);
    expect(loadServerEnv({ ...base, MFA_ENCRYPTION_KEY_PREVIOUS: '' }).MFA_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });
});
