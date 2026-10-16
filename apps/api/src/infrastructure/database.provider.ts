import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import pg from 'pg';
import { ENV } from './env.provider.js';

/** Runtime pool (role onepos_app, RLS enforced). Use `withTenant()` for tenant data. */
@Injectable()
export class DatabasePool implements OnApplicationShutdown {
  readonly pool: pg.Pool;
  private readonly logger = new Logger('DatabasePool');

  constructor(@Inject(ENV) env: ServerEnv) {
    this.pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    // An idle client whose server connection dies (DB restart, failover, admin kill) is emitted
    // here; without a listener Node treats it as an unhandled 'error' and the API process exits.
    // The pool already discards that client and opens a new one on the next request.
    this.pool.on('error', (err: Error & { code?: string }) => {
      this.logger.warn({ msg: 'idle database connection lost', code: err.code, message: err.message.slice(0, 200) });
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
