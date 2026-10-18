import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm';
import { NodePgDatabase, NodePgDriver } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/*
 * `drizzle(client, { schema })` walks every table of the schema to build its relational config, on
 * each call. Called per transaction it was the API's main CPU cost under load (ADR-0016 slice 5:
 * ~46% of the API's CPU in drizzle, mostly this). The config and the dialect are immutable, so they
 * are built once here and every transaction gets a cheap database object over its own client. This
 * mirrors drizzle-orm/node-postgres `construct()` (0.45), without logger or cache, which we do not use.
 */
const dialect = new PgDialect();
const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
const relational = { fullSchema: schema, schema: tablesConfig.tables, tableNamesMap: tablesConfig.tableNamesMap };

/** A drizzle database bound to one pool client (the transaction's). */
export function bindDatabase(client: PoolClient): Database {
  const session = new NodePgDriver(client, dialect).createSession(relational);
  const db = new NodePgDatabase(dialect, session, relational as never) as unknown as Database & { $client: PoolClient };
  db.$client = client;
  return db;
}

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
      db: bindDatabase(client),
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

/**
 * Several queries on one transaction, one after another. A transaction is one connection, and a
 * connection runs one query at a time: `Promise.all` over its queries only queues them inside pg,
 * which pg 8 deprecates and pg 9 refuses. Pass thunks (raw `client.query` starts at once when called);
 * the result keeps each query's type, like `Promise.all`.
 */
export async function inSequence<T extends readonly (() => unknown)[]>(
  ...steps: T
): Promise<{ -readonly [K in keyof T]: T[K] extends () => infer R ? Awaited<R> : never }> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as never;
}

/** `Promise.all(items.map(fn))` for queries on one transaction: one item at a time, results in order. */
export async function mapInSequence<I, R>(items: readonly I[], fn: (item: I) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}
