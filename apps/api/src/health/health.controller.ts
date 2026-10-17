import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { MonitoringService, type SchemaState } from '../infrastructure/monitoring.service.js';
import { RateLimitStore } from '../infrastructure/rate-limit.store.js';
import { Public } from '../auth/auth-context.js';

interface ReadyChecks {
  database: 'up' | 'down';
  migrations: SchemaState;
  redis: 'up' | 'down' | 'disabled';
}

@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabasePool) private readonly db: DatabasePool,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
    @Inject(RateLimitStore) private readonly rateLimits: RateLimitStore,
  ) {}

  /** Liveness: process is up. Never touches dependencies. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: 503 (so load balancers drain) when the database is unreachable or does not have the
   * migrations this build needs. Redis is reported but does not fail readiness: without it rate
   * limits count per instance (ADR-0016 slice 2), and draining every replica would turn a Redis
   * outage into a full one. Its alert (OneposRedisDown) covers it.
   */
  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded'; checks: ReadyChecks }> {
    const redisCheck = async (): Promise<ReadyChecks['redis']> =>
      this.rateLimits.backend !== 'redis' ? 'disabled' : (await this.rateLimits.ping()) ? 'up' : 'down';
    const [dbUp, redis] = await Promise.all([this.db.ping(), redisCheck()]);
    const checks: ReadyChecks = { database: dbUp ? 'up' : 'down', migrations: dbUp ? await this.monitoring.schemaState() : 'unknown', redis };
    if (!dbUp) throw new AppError('NOT_READY', 'Database unreachable', HttpStatus.SERVICE_UNAVAILABLE, { checks });
    if (checks.migrations !== 'up') {
      throw new AppError('NOT_READY', 'The database does not have the migrations this build needs', HttpStatus.SERVICE_UNAVAILABLE, { checks });
    }
    return { status: redis === 'down' ? 'degraded' : 'ok', checks };
  }
}
