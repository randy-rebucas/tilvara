import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ServerEnv } from '@1pos/config';
import { AppError } from './http-error.filter.js';
import { ENV } from './env.provider.js';

export const RATE_LIMIT = 'onepos:rateLimit';
export interface RateLimitRule {
  /** Bucket name, e.g. 'auth'. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT, rule);

/**
 * Fixed-window per-IP limiter. In-memory, so per instance only — sufficient for a single
 * dev/pilot instance; replace the store with Redis before running multiple API replicas
 * (tracked in BACKLOG). Durable per-account lockout lives in the DB (auth_record_login_result).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.env.RATE_LIMITS_ENABLED) return true;
    const rule = this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (!rule) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = `${rule.bucket}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rule.windowSeconds * 1000 };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (this.hits.size > 50_000) this.evict(now);
    if (entry.count > rule.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      throw new AppError('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: retryAfter });
    }
    return true;
  }

  private evict(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
