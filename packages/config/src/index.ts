import { z } from 'zod';

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

/** An optional secret: blank counts as unset; when set it must match the provider's key format. */
const optionalKey = (re: RegExp, message: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(re, message).optional());

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4320),
  /** Listen address. 127.0.0.1 locally; 0.0.0.0 inside a container behind the edge proxy. */
  API_HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * Internal Prometheus listener (ADR-0016 slice 3): `GET /metrics` only, on its own port so it is
   * never reachable through the public listener. 0 turns it off (integration tests).
   */
  API_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(4329),
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  JWT_ACCESS_SECRET: z.string().min(32),
  /**
   * 32 random bytes, base64, that encrypt TOTP secrets at rest (ADR-0016). Required in production;
   * elsewhere a key is derived from JWT_ACCESS_SECRET so dev and tests need no extra setting.
   */
  MFA_ENCRYPTION_KEY: optionalKey(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes, base64 (44 characters)'),
  /** Days a privileged member may work without two-step sign-in before it is required (ADR-0016). */
  MFA_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Comma-separated origins allowed by CORS (admin web; the desktop till is served from http://tauri.localhost on Windows). */
  CORS_ORIGINS: z.string().default('http://127.0.0.1:3320,http://localhost:3320,http://tauri.localhost'),
  /** Base URL of the admin web app, used in emailed links (invitations). */
  APP_PUBLIC_URL: z.url().default('http://127.0.0.1:3320'),
  /** Only 'dev' exists so far (stores mail in memory/logs). Refused in production until a real provider is added. */
  MAILER_DRIVER: z.enum(['dev']).default('dev'),
  /**
   * Non-cash payment provider. Only the deterministic dev simulator exists; PayMongo is the chosen
   * provider (user decision 2026-10-15) and is added once sandbox keys are available.
   */
  PAYMENT_PROVIDER: z.enum(['dev']).default('dev'),
  /** PayMongo credentials (ADR-0010; adapter in Phase 5 slice 6). Empty means not configured. */
  PAYMONGO_SECRET_KEY: optionalKey(/^sk_(test|live)_\w+$/, 'must be a PayMongo secret key (sk_test_… or sk_live_…)'),
  PAYMONGO_PUBLIC_KEY: optionalKey(/^pk_(test|live)_\w+$/, 'must be a PayMongo public key (pk_test_… or pk_live_…)'),
  PAYMONGO_WEBHOOK_SECRET: optionalKey(/^whsk_\w+$/, 'must be a PayMongo webhook signing secret (whsk_…)'),
  /** Provider call timeout; a timed-out authorization is reconciled, never retried blindly. */
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
  /** How long a terminal snapshot may price offline sales before they are flagged SNAPSHOT_EXPIRED (ADR-0015). */
  OFFLINE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Key prefix of the rate-limit counters in Redis (tests use a unique one per run). */
  RATE_LIMIT_PREFIX: z.string().min(1).max(64).default('onepos:rl:'),
  /**
   * Proxies in front of the API whose X-Forwarded-For may be believed (Express "trust proxy").
   * 0 = none (direct). Behind one load balancer: 1. Wrong values let clients spoof their IP and
   * dodge per-IP limits, or put every client in one bucket.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Test-only escape hatch; refused in production. */
  RATE_LIMITS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  /** The worker's own login (role onepos_worker, ADR-0016); required in production. Falls back to DATABASE_URL elsewhere. */
  WORKER_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  WORKER_ID: z.string().min(1).max(100).optional(),
  /** Internal Prometheus listener of the worker (ADR-0016 slice 3); 0 turns it off. */
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(4339),
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  MAILER_DRIVER: z.enum(['dev']).default('dev'),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const issues: string[] = [];
  if (isProd(env) && parsed.data.MAILER_DRIVER === 'dev') issues.push('MAILER_DRIVER: the dev mailer cannot be used in production');
  if (isProd(env) && !parsed.data.WORKER_DATABASE_URL) {
    issues.push('WORKER_DATABASE_URL: required in production (the worker connects as onepos_worker, not the API role)');
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
  return parsed.data;
}

const DEV_SECRET_MARKERS = ['dev-only', 'change-me', 'changeme'];

/**
 * Validate process environment at boot. Fails fast with every problem listed,
 * and refuses development placeholder secrets in production. Never echoes values.
 */
export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const issues = isProd(env) ? productionIssues(parsed.data) : nonProductionIssues(parsed.data);
  if (parsed.data.API_METRICS_PORT !== 0 && parsed.data.API_METRICS_PORT === parsed.data.API_PORT) {
    issues.push('API_METRICS_PORT: must differ from API_PORT (metrics are never served on the public listener)');
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
  return parsed.data;
}

/** Settings that are fine for development but must never reach production. */
export function productionIssues(cfg: ServerEnv): string[] {
  const issues: string[] = [];
  if (DEV_SECRET_MARKERS.some((m) => cfg.JWT_ACCESS_SECRET.toLowerCase().includes(m))) {
    issues.push('JWT_ACCESS_SECRET: development placeholder secret used in production');
  }
  if (!cfg.RATE_LIMITS_ENABLED) issues.push('RATE_LIMITS_ENABLED: cannot be disabled in production');
  if (!cfg.REDIS_URL) issues.push('REDIS_URL: required in production (rate limits shared across API replicas)');
  if (!cfg.MFA_ENCRYPTION_KEY) issues.push('MFA_ENCRYPTION_KEY: required in production (32 random bytes, base64)');
  if (cfg.MAILER_DRIVER === 'dev') {
    issues.push('MAILER_DRIVER: the dev mailer cannot be used in production (no real email provider configured yet)');
  }
  if (cfg.PAYMENT_PROVIDER === 'dev') {
    issues.push('PAYMENT_PROVIDER: the dev payment simulator cannot be used in production');
  }
  return issues;
}

/** Live PayMongo keys may only be loaded in production; dev and test use sandbox keys. */
function nonProductionIssues(cfg: ServerEnv): string[] {
  return (['PAYMONGO_SECRET_KEY', 'PAYMONGO_PUBLIC_KEY'] as const)
    .filter((k) => cfg[k]?.includes('_live_'))
    .map((k) => `${k}: live keys are only allowed in production; use the test-mode key`);
}
