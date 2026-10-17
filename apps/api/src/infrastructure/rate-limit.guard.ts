import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { ServerEnv } from '@1pos/config';
import { createHash } from 'node:crypto';
import { AppError } from './http-error.filter.js';
import { ENV } from './env.provider.js';
import { RateLimitStore } from './rate-limit.store.js';

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
    const rules = this.reflector.getAllAndOverride<RateLimitRule[]>(RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (!rules?.length) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    for (const rule of rules) {
      const { count, resetInMs } = await this.store.hit(`${rule.bucket}:${keyOf(rule, req)}`, rule.windowSeconds * 1000);
      if (count > rule.limit) {
        const retryAfter = Math.max(1, Math.ceil(resetInMs / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        throw new AppError('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: retryAfter });
      }
    }
    return true;
  }
}

/** The counter key for a rule. Emails are hashed so Redis never holds personal data. */
export function keyOf(rule: RateLimitRule, req: Pick<Request, 'ip' | 'body' | 'header'>): string {
  const ip = `ip:${req.ip ?? 'unknown'}`;
  if (rule.by === 'account') {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string' || email.trim() === '') return ip;
    return `acct:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
  }
  if (rule.by === 'terminal') {
    const id = req.header('x-terminal-id');
    return id && UUID.test(id) ? `term:${id.toLowerCase()}` : ip;
  }
  return ip;
}
