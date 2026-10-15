import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import pg from 'pg';
import { ENV } from './env.provider.js';

/** Runtime pool (role onepos_app, RLS enforced). Use `withTenant()` for tenant data. */
@Injectable()
export class DatabasePool implements OnApplicationShutdown {
  readonly pool: pg.Pool;

  constructor(@Inject(ENV) env: ServerEnv) {
    this.pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
