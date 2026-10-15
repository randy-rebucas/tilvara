import { z } from 'zod';

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4320),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Comma-separated origins allowed by CORS (admin web, POS browser mode). */
  CORS_ORIGINS: z.string().default('http://127.0.0.1:3320,http://localhost:3320'),
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
    if (!parsed.data.RATE_LIMITS_ENABLED) {
      throw new EnvValidationError(['RATE_LIMITS_ENABLED: cannot be disabled in production']);
    }
    const secret = parsed.data.JWT_ACCESS_SECRET.toLowerCase();
    if (DEV_SECRET_MARKERS.some((m) => secret.includes(m))) {
      throw new EnvValidationError(['JWT_ACCESS_SECRET: development placeholder secret used in production']);
    }
  }
  return parsed.data;
}
