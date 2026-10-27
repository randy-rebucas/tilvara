import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

/** An optional secret: blank counts as unset; when set it must match the provider's key format. */
const optionalKey = (re: RegExp, message: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(re, message).optional());

/**
 * Private file storage for data exports (ADR-0016 slice 6). Only 'dev' (a local folder) exists until
 * the hosting decision (D1) brings object storage; production refuses it. API and worker must point
 * at the same place.
 */
const fileStorage = {
  FILE_STORAGE_DRIVER: z.enum(['dev']).default('dev'),
  FILE_STORAGE_DIR: z.string().min(1).default(join(tmpdir(), 'onepos-files')),
};

/**
 * Bearer token a Prometheus scrape must send to `/metrics` (API and worker). Optional on loopback;
 * production requires it once METRICS_HOST listens beyond this machine (a container, a private network).
 */
const metricsToken = {
  METRICS_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32, 'must be at least 32 characters').optional()),
};
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Outbound webhooks (session 20, ADR-0019), for the API (shows a new endpoint's secret) and the worker
 * (signs each delivery). The signing secret of an endpoint is HMAC(WEBHOOK_SIGNING_KEY, id:salt), so
 * both must have the same key. WEBHOOK_ALLOW_INSECURE lets an endpoint use http or a private address
 * (development and tests only; production refuses it).
 */
const webhooks = {
  WEBHOOK_SIGNING_KEY: z.string().min(32, 'must be at least 32 characters').default('dev-only-webhook-signing-key-change-me-0000'),
  WEBHOOK_ALLOW_INSECURE: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
};
const webhookIssues = (cfg: { WEBHOOK_SIGNING_KEY: string; WEBHOOK_ALLOW_INSECURE: boolean }): string[] => [
  ...(DEV_SECRET_MARKERS.some((m) => cfg.WEBHOOK_SIGNING_KEY.toLowerCase().includes(m)) ? ['WEBHOOK_SIGNING_KEY: development placeholder used in production'] : []),
  ...(cfg.WEBHOOK_ALLOW_INSECURE ? ['WEBHOOK_ALLOW_INSECURE: webhooks to http or private addresses cannot be allowed in production'] : []),
];
const metricsTokenIssue = (cfg: { METRICS_HOST: string; METRICS_TOKEN?: string | undefined }, port: number): string[] =>
  port !== 0 && !cfg.METRICS_TOKEN && !LOOPBACK_HOSTS.has(cfg.METRICS_HOST)
    ? [`METRICS_TOKEN: required in production when METRICS_HOST (${cfg.METRICS_HOST}) is not a loopback address`]
    : [];

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
  ...metricsToken,
  JWT_ACCESS_SECRET: z.string().min(32),
  /**
   * 32 random bytes, base64, that encrypt TOTP secrets at rest (ADR-0016). Required in production;
   * elsewhere a key is derived from JWT_ACCESS_SECRET so dev and tests need no extra setting.
   */
  MFA_ENCRYPTION_KEY: optionalKey(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes, base64 (44 characters)'),
  /**
   * Only while rotating MFA_ENCRYPTION_KEY: the key it replaces. Secrets sealed with it still open,
   * and `pnpm --filter @1pos/api mfa-rekey` re-seals them all with the current key; then remove it.
   */
  MFA_ENCRYPTION_KEY_PREVIOUS: optionalKey(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes, base64 (44 characters)'),
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
  /**
   * Who takes the businesses' subscription payments (ADR-0027). 'dev' is a simulator: its checkout
   * page, served by this API at API_PUBLIC_URL, pays the bill on a click; refused in production.
   * 'paymongo' needs PAYMONGO_SECRET_KEY and PAYMONGO_WEBHOOK_SECRET.
   */
  BILLING_PROVIDER: z.enum(['dev', 'paymongo']).default('dev'),
  /**
   * The shops' own addresses, `<slug>.<SHOP_DOMAIN>` (same value as the admin's ONEPOS_SHOP_DOMAIN; session 40).
   * Set, a business whose own sign-in page is on comes back from the payment page to its own address
   * (scheme and port as APP_PUBLIC_URL); unset, to APP_PUBLIC_URL.
   */
  SHOP_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]*$/, 'must be a domain name such as tilvara.ph')
    .transform((v) => v.replace(/^\.+|\.+$/g, '') || undefined)
    .optional(),
  /** This API's address as a browser reaches it (the dev billing checkout page). */
  API_PUBLIC_URL: z.url().default('http://127.0.0.1:4320'),
  /** Provider call timeout; a timed-out authorization is reconciled, never retried blindly. */
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
  /** How long a terminal snapshot may price offline sales before they are flagged SNAPSHOT_EXPIRED (ADR-0015). */
  OFFLINE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * A sync batch answers within this time (ADR-0016 slice 5): envelopes not reached are left
   * unanswered and the till sends them again, so a busy server never runs past the till's 15 s
   * timeout (which would make it resend the whole batch while the first copy is still recording).
   */
  SYNC_BATCH_BUDGET_MS: z.coerce.number().int().min(0).max(60_000).default(8_000),
  /** Key prefix of the rate-limit counters in Redis (tests use a unique one per run). */
  RATE_LIMIT_PREFIX: z.string().min(1).max(64).default('onepos:rl:'),
  /**
   * How long a rate-limit check waits for Redis before counting in this process instead (fail fast: a
   * request never waits for Redis). Tests that assert on shared counting raise it, so a busy machine
   * does not turn a slow answer into a fallback.
   */
  RATE_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(300),
  /**
   * Proxies in front of the API whose X-Forwarded-For may be believed (Express "trust proxy").
   * 0 = none (direct). Behind one load balancer: 1. Wrong values let clients spoof their IP and
   * dodge per-IP limits, or put every client in one bucket.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Shared with the admin web (session 40): the admin calls the API from its own server, so it sends the
   * visitor's address in `x-onepos-client-ip` with this secret in `x-onepos-bff`; only then is that
   * address used for per-IP limits. Unset = the header is ignored. Same value as the admin's `ONEPOS_BFF_SECRET`.
   */
  BFF_SHARED_SECRET: z.string().min(32).optional(),
  /** Test-only escape hatch; refused in production. */
  RATE_LIMITS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ...fileStorage,
  /** How long a data-export download link works (signed by the API). */
  DATA_EXPORT_LINK_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  ...webhooks,
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
  ...metricsToken,
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  MAILER_DRIVER: z.enum(['dev']).default('dev'),
  ...fileStorage,
  /** Days a finished data export stays downloadable before the worker deletes the file. */
  DATA_EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  ...webhooks,
  /** One webhook POST may take this long before it counts as failed and is retried. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  /**
   * Same values as the API's (ADR-0027): the worker closes a voided or settled bill's open PayMongo pages
   * (`billing.checkout_expired`, audit 45 #3). 'dev' needs nothing (the simulator's page asks the database).
   */
  BILLING_PROVIDER: z.enum(['dev', 'paymongo']).default('dev'),
  PAYMONGO_SECRET_KEY: optionalKey(/^sk_(test|live)_\w+$/, 'must be a PayMongo secret key (sk_test_… or sk_live_…)'),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const issues: string[] = [];
  if (isProd(env) && parsed.data.MAILER_DRIVER === 'dev') issues.push('MAILER_DRIVER: the dev mailer cannot be used in production');
  if (isProd(env) && parsed.data.FILE_STORAGE_DRIVER === 'dev') issues.push(DEV_STORAGE_ISSUE);
  if (isProd(env) && !parsed.data.WORKER_DATABASE_URL) {
    issues.push('WORKER_DATABASE_URL: required in production (the worker connects as onepos_worker, not the API role)');
  }
  if (isProd(env)) issues.push(...metricsTokenIssue(parsed.data, parsed.data.WORKER_METRICS_PORT), ...webhookIssues(parsed.data));
  if (parsed.data.BILLING_PROVIDER === 'paymongo' && !parsed.data.PAYMONGO_SECRET_KEY) {
    issues.push('BILLING_PROVIDER: paymongo needs PAYMONGO_SECRET_KEY (the worker closes stale payment pages)');
  }
  if (isProd(env) && parsed.data.BILLING_PROVIDER === 'dev') {
    issues.push('BILLING_PROVIDER: the dev billing simulator cannot be used in production (set paymongo, as on the API)');
  }
  if (!isProd(env) && parsed.data.PAYMONGO_SECRET_KEY?.includes('_live_')) {
    issues.push('PAYMONGO_SECRET_KEY: live keys are only allowed in production; use the test-mode key');
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
  return parsed.data;
}

const DEV_STORAGE_ISSUE = 'FILE_STORAGE_DRIVER: the dev file storage (a local folder) cannot be used in production (object storage waits for D1)';

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
  if (parsed.data.MFA_ENCRYPTION_KEY_PREVIOUS && !parsed.data.MFA_ENCRYPTION_KEY) {
    issues.push('MFA_ENCRYPTION_KEY_PREVIOUS: set only while rotating, together with the new MFA_ENCRYPTION_KEY');
  }
  if (parsed.data.MFA_ENCRYPTION_KEY_PREVIOUS && parsed.data.MFA_ENCRYPTION_KEY_PREVIOUS === parsed.data.MFA_ENCRYPTION_KEY) {
    issues.push('MFA_ENCRYPTION_KEY_PREVIOUS: must differ from MFA_ENCRYPTION_KEY');
  }
  if (parsed.data.BILLING_PROVIDER === 'paymongo' && (!parsed.data.PAYMONGO_SECRET_KEY || !parsed.data.PAYMONGO_WEBHOOK_SECRET)) {
    issues.push('BILLING_PROVIDER: paymongo needs PAYMONGO_SECRET_KEY and PAYMONGO_WEBHOOK_SECRET');
  }
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
  if (cfg.BILLING_PROVIDER === 'dev') {
    issues.push('BILLING_PROVIDER: the dev billing simulator cannot be used in production (set paymongo)');
  }
  // A test key in production takes no real money while every bill would look paid (audit 45 #16).
  if (cfg.BILLING_PROVIDER === 'paymongo' && !cfg.PAYMONGO_SECRET_KEY?.startsWith('sk_live_')) {
    issues.push('PAYMONGO_SECRET_KEY: production needs the live secret key (sk_live_…), not a test key');
  }
  if (cfg.FILE_STORAGE_DRIVER === 'dev') issues.push(DEV_STORAGE_ISSUE);
  if (!cfg.BFF_SHARED_SECRET || DEV_SECRET_MARKERS.some((m) => cfg.BFF_SHARED_SECRET!.toLowerCase().includes(m))) {
    issues.push('BFF_SHARED_SECRET: required in production (32+ random characters, shared with the admin web), or every admin visitor shares one per-IP limit');
  }
  issues.push(...metricsTokenIssue(cfg, cfg.API_METRICS_PORT), ...webhookIssues(cfg));
  return issues;
}

/** Live PayMongo keys may only be loaded in production; dev and test use sandbox keys. */
function nonProductionIssues(cfg: ServerEnv): string[] {
  return (['PAYMONGO_SECRET_KEY', 'PAYMONGO_PUBLIC_KEY'] as const)
    .filter((k) => cfg[k]?.includes('_live_'))
    .map((k) => `${k}: live keys are only allowed in production; use the test-mode key`);
}
