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

export interface TxOptions {
  isolation?: IsolationLevel;
  /** Propagated to `app.correlation_id` for triggers/audit. */
  correlationId?: string;
  /** Propagated to `app.user_id` (RLS on users, audit). Must come from the verified session. */
  userId?: string;
}

/** @deprecated alias kept for readability at call sites */
export type TenantTxOptions = TxOptions;

export interface Tx {
  db: Database;
  client: PoolClient;
  /** Switch the RLS tenant for the rest of this transaction (e.g. right after provisioning). */
  setTenant(tenantId: string): Promise<void>;
  setUser(userId: string): Promise<void>;
}

function assertUuid(id: string): void {
  if (!UUID.test(id)) throw new InvalidTenantContextError();
}

/**
 * Run `fn` in a transaction. Context settings are transaction-local
 * (`set_config(..., true)`), so they vanish at COMMIT/ROLLBACK and a pooled
 * connection can never leak one request's identity into the next (ADR-0004).
 */
export async function transaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  if (options.userId) assertUuid(options.userId);
  const client = await pool.connect();
  // pg-pool only watches idle clients. While checked out, a dropped connection (DB restart,
  // admin kill) is emitted as 'error' on the client — unhandled, that exits the process. The
  // running query rejects on its own; here we just mark the client so it is destroyed, not reused.
  let broken: Error | undefined;
  const onError = (e: Error) => {
    broken = e;
  };
  client.on('error', onError);
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`);
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.correlation_id', $2, true)`,
      [options.userId ?? '', options.correlationId ?? ''],
    );
    const tx: Tx = {
      db: drizzle(client, { schema }),
      client,
      async setTenant(tenantId) {
        assertUuid(tenantId);
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      },
      async setUser(userId) {
        assertUuid(userId);
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      },
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/**
 * Run `fn` inside a transaction whose Row-Level Security context is `tenantId`.
 * `tenantId` must come from the server-side session, never from request input.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Database, client: PoolClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  assertUuid(tenantId);
  return transaction(
    pool,
    async (tx) => {
      await tx.setTenant(tenantId);
      return fn(tx.db, tx.client);
    },
    options,
  );
}
