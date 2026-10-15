import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { Public } from '../auth/auth-context.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DatabasePool) private readonly db: DatabasePool) {}

  /** Liveness: process is up. Never touches dependencies. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. 503 when not ready so load balancers drain. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'up'> }> {
    const dbUp = await this.db.ping();
    if (!dbUp) {
      throw new AppError('NOT_READY', 'Database unreachable', HttpStatus.SERVICE_UNAVAILABLE, {
        checks: { database: 'down' },
      });
    }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
