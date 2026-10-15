import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantContextError extends Error {
  constructor() {
    super('Tenant context must be a UUID resolved from the authenticated session');
    this.name = 'InvalidTenantContextError';
  }
}

export interface TenantTxOptions {
  isolation?: IsolationLevel;
  /** Propagated to `app.correlation_id` for triggers/audit. */
  correlationId?: string;
  /** Propagated to `app.user_id` for triggers/audit. */
  userId?: string;
}

/**
 * Run `fn` inside a transaction whose Row-Level Security context is `tenantId`.
 *
 * The context is set with `set_config(..., is_local => true)`, so it is discarded at
 * COMMIT/ROLLBACK: a pooled connection can never carry one request's tenant into the
 * next (ADR-0004). `tenantId` must come from the server-side session, never from input.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Database, client: PoolClient) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new InvalidTenantContextError();
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`);
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.correlation_id', $3, true)`,
      [tenantId, options.userId ?? '', options.correlationId ?? ''],
    );
    const result = await fn(drizzle(client, { schema }), client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
