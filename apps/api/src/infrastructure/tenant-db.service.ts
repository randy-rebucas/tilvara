import { Inject, Injectable } from '@nestjs/common';
import { Database, transaction, Tx, TxOptions, withTenant } from '@1pos/database';
import type { PoolClient } from 'pg';
import type { AuthContext } from '../auth/auth-context.js';
import { tenantOf } from '../auth/auth-context.js';
import { DatabasePool } from './database.provider.js';

/** The only way request handlers touch tenant data: context always comes from the verified session. */
@Injectable()
export class TenantDb {
  constructor(@Inject(DatabasePool) private readonly database: DatabasePool) {}

  run<T>(auth: AuthContext, fn: (db: Database, client: PoolClient) => Promise<T>, options: Omit<TxOptions, 'userId' | 'correlationId'> = {}): Promise<T> {
    return withTenant(this.database.pool, tenantOf(auth).tenantId, fn, {
      ...options,
      userId: auth.userId,
      correlationId: auth.correlationId,
    });
  }

  /** Transaction without tenant context (auth flows that call SECURITY DEFINER functions). */
  tx<T>(fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    return transaction(this.database.pool, fn, options);
  }
}
