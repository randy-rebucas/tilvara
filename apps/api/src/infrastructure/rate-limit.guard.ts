import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { ServerEnv } from '@1pos/config';
import { createHash } from 'node:crypto';
import { AppError } from './http-error.filter.js';
import { ENV } from './env.provider.js';
import { RateLimitStore } from './rate-limit.store.js';
import { clientIp } from './client-ip.js';

export const RATE_LIMIT = 'onepos:rateLimit';

/** What a rule counts by: the client address, the account named in the body, or the terminal. */
export type RateLimitKey = 'ip' | 'account' | 'terminal';

export interface RateLimitRule {
  /** Bucket name, e.g. 'auth'. */
  bucket: string;
  limit: number;
  windowSeconds: number;
  /** Default 'ip'. 'account' uses the body's email (hashed); 'terminal' the X-Terminal-Id header. */
  by?: RateLimitKey;
}

/** One or more rules; a request must pass every one of them. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT, rules);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every request made with an API key (ADR-0019), whatever route: per key, and per address for all keys
 * together (made-up keys each count alone, but share their address's cap). Info finding of audit 47.
 */
export const API_KEY_RULES: readonly RateLimitRule[] = [
  { bucket: 'api-key', limit: 120, windowSeconds: 60 },
  { bucket: 'api-key-ip', limit: 600, windowSeconds: 60 },
];
const API_KEY_PREFIX = /^tlv_([a-z0-9]{10})_/;

/**
 * Fixed-window limiter (ADR-0016 slice 2). Counters live in Redis when REDIS_URL is set (shared by
 * all replicas) and fall back to this process otherwise. A rule whose key is missing from the
 * request (no email, no terminal id) counts by IP instead, so it can never be skipped. Durable
 * per-account lockout is separate and lives in the DB (auth_record_login_result).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(RateLimitStore) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.env.RATE_LIMITS_ENABLED) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const routeRules = this.reflector.getAllAndOverride<RateLimitRule[]>(RATE_LIMIT, [context.getHandler(), context.getClass()]) ?? [];
    const apiKey = req.header('authorization')?.startsWith('ApiKey ') === true;
    const rules = apiKey ? [...API_KEY_RULES, ...routeRules] : routeRules;
    for (const rule of rules) {
      const key = rule.bucket === 'api-key' ? apiKeyBucket(req) : keyOf(rule, req);
      const { count, resetInMs } = await this.store.hit(`${rule.bucket}:${key}`, rule.windowSeconds * 1000);
      if (count > rule.limit) {
        const retryAfter = Math.max(1, Math.ceil(resetInMs / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        throw new AppError('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: retryAfter });
      }
    }
    return true;
  }
}

/**
 * An API key's counter: its public prefix (what the admin shows) and a hash of the whole key, so a
 * made-up key with a real prefix cannot use up that key's allowance. Never the key itself, and not the
 * hash the database keeps either.
 */
export function apiKeyBucket(req: Pick<Request, 'ip' | 'body' | 'header'>): string {
  const key = (req.header('authorization') ?? '').slice(7).trim();
  const prefix = API_KEY_PREFIX.exec(key)?.[1] ?? 'none';
  return `key:${prefix}:${createHash('sha256').update(`rate-limit\n${key}`).digest('hex').slice(0, 32)}`;
}

/** The counter key for a rule. Emails are hashed so Redis never holds personal data. */
export function keyOf(rule: RateLimitRule, req: Pick<Request, 'ip' | 'body' | 'header'>): string {
  const ip = `ip:${clientIp(req) ?? 'unknown'}`;
  if (rule.by === 'account') {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string' || email.trim() === '') return ip;
    return `acct:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
  }
  if (rule.by === 'terminal') {
    // Counted per terminal id *and* credential (hashed): knowing another business's terminal id is not
    // enough to use up its allowance; made-up credentials share the per-IP cap.
    const id = req.header('x-terminal-id');
    if (!id || !UUID.test(id)) return ip;
    return `term:${createHash('sha256').update(`${id.toLowerCase()}\n${req.header('authorization') ?? ''}`).digest('hex').slice(0, 32)}`;
  }
  return ip;
}
