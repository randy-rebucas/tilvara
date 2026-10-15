import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadServerEnv, productionIssues } from '../src/index.js';

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

  it('accepts a real secret with otherwise production-safe settings', () => {
    const env = loadServerEnv({ ...base, JWT_ACCESS_SECRET: 'x'.repeat(48) });
    expect(productionIssues(env)).toEqual([
      'MAILER_DRIVER: the dev mailer cannot be used in production (no real email provider configured yet)',
      'PAYMENT_PROVIDER: the dev payment simulator cannot be used in production',
    ]);
  });
});
