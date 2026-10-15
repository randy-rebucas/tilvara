import { z } from 'zod';

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4320),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Comma-separated origins allowed by CORS (admin web, POS browser mode). */
  CORS_ORIGINS: z.string().default('http://127.0.0.1:3320,http://localhost:3320'),
  /** Base URL of the admin web app, used in emailed links (invitations). */
  APP_PUBLIC_URL: z.url().default('http://127.0.0.1:3320'),
  /** Only 'dev' exists so far (stores mail in memory/logs). Refused in production until a real provider is added. */
  MAILER_DRIVER: z.enum(['dev']).default('dev'),
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
  WORKER_ID: z.string().min(1).max(100).optional(),
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
  if (isProd(env) && parsed.data.MAILER_DRIVER === 'dev') {
    throw new EnvValidationError(['MAILER_DRIVER: the dev mailer cannot be used in production']);
  }
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
  if (isProd(env)) {
    const issues = productionIssues(parsed.data);
    if (issues.length > 0) throw new EnvValidationError(issues);
  }
  return parsed.data;
}

/** Settings that are fine for development but must never reach production. */
export function productionIssues(cfg: ServerEnv): string[] {
  const issues: string[] = [];
  if (DEV_SECRET_MARKERS.some((m) => cfg.JWT_ACCESS_SECRET.toLowerCase().includes(m))) {
    issues.push('JWT_ACCESS_SECRET: development placeholder secret used in production');
  }
  if (!cfg.RATE_LIMITS_ENABLED) issues.push('RATE_LIMITS_ENABLED: cannot be disabled in production');
  if (cfg.MAILER_DRIVER === 'dev') {
    issues.push('MAILER_DRIVER: the dev mailer cannot be used in production (no real email provider configured yet)');
  }
  return issues;
}
