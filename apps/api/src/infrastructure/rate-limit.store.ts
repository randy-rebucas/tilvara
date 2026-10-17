import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { Redis } from 'ioredis';
import { ENV } from './env.provider.js';

export interface Hit {
  count: number;
  resetInMs: number;
}

/** Fixed-window counter: one hit on `key`, the window starting at its first hit. */
export interface RateLimitCounter {
  hit(key: string, windowMs: number): Promise<Hit>;
}

/** Per-process counters: dev, tests, and the fallback when Redis cannot be reached. */
export class MemoryRateLimitCounter implements RateLimitCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number): Promise<Hit> {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    return { count: entry.count, resetInMs: entry.resetAt - now };
  }
}

// INCR and the window's expiry in one atomic step; a key that somehow lost its TTL gets one again.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

/**
 * The limiter's counters (ADR-0016 slice 2). With REDIS_URL they live in Redis, so every API
 * replica counts together. If Redis cannot answer within the command timeout the hit is counted
 * in this process instead: limits still apply per instance, and sign-in never fails because
 * Redis is down. Fallbacks are counted for monitoring and logged at most once a minute.
 */
@Injectable()
export class RateLimitStore implements RateLimitCounter, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('RateLimit');
  private readonly memory = new MemoryRateLimitCounter();
  private readonly redis: Redis | null;
  private readonly prefix: string;
  private lastWarnAt = 0;
  /** Hits counted in memory because Redis failed (monitoring, slice 3). */
  fallbacks = 0;

  constructor(@Inject(ENV) env: ServerEnv) {
    this.prefix = env.RATE_LIMIT_PREFIX;
    this.redis = env.REDIS_URL
      ? new Redis(env.REDIS_URL, {
          // Fail fast instead of queueing: a request must not wait for Redis to come back.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: 2_000,
          commandTimeout: 300,
          retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
        })
      : null;
    // Without a listener ioredis reports connection errors as unhandled events.
    this.redis?.on('error', (e: Error) => this.warn(e));
  }

  /**
   * Wait (at most the connect timeout) for the first connection, so the first requests after boot
   * are counted in Redis rather than split between this process and Redis. Never fails boot.
   */
  async onModuleInit(): Promise<void> {
    const redis = this.redis;
    if (!redis || redis.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, 2_500);
      redis.once('ready', done);
    });
  }

  get backend(): 'redis' | 'memory' {
    return this.redis ? 'redis' : 'memory';
  }

  async hit(key: string, windowMs: number): Promise<Hit> {
    if (!this.redis) return this.memory.hit(key, windowMs);
    try {
      const [count, ttl] = (await this.redis.eval(HIT_SCRIPT, 1, this.prefix + key, String(windowMs))) as [number, number];
      return { count, resetInMs: ttl };
    } catch (e) {
      this.fallbacks++;
      this.warn(e as Error);
      return this.memory.hit(key, windowMs);
    }
  }

  async ping(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  private warn(e: Error): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    this.logger.warn({ msg: 'rate limiter: Redis unavailable, counting in this process', error: e.name, message: e.message.slice(0, 200) });
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis?.disconnect();
  }
}
