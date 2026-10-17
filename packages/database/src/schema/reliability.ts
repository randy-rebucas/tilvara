import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

/**
 * Completed idempotent operations. The row is inserted in the SAME transaction as the
 * business change, so it exists iff the change committed: a concurrent duplicate blocks on
 * the unique index and then replays the stored response.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** e.g. "POST /v1/products" */
    scope: text('scope').notNull(),
    key: uuid('key').notNull(),
    userId: uuid('user_id').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('idempotency_records_key_unique').on(t.tenantId, t.scope, t.key),
    index('idempotency_records_expiry_idx').on(t.expiresAt),
  ],
);

export const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Transactional outbox (ADR-0003). Written with the business change; processed by apps/workers. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_events_claim_idx').on(t.availableAt).where(sql`${t.status} IN ('PENDING','PROCESSING')`),
    index('outbox_events_tenant_idx').on(t.tenantId, t.createdAt),
    // Monitoring and the DEAD-letter tool (ADR-0016) without scanning delivered rows.
    index('outbox_events_dead_idx').on(t.createdAt).where(sql`${t.status} = 'DEAD'`),
    check('outbox_events_status_check', sql`${t.status} IN ('PENDING','PROCESSING','DONE','DEAD')`),
    check('outbox_events_topic_format', sql`${t.topic} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
  ],
);

/**
 * One row per running outbox worker (ADR-0016 slice 3), refreshed by `worker_heartbeat()` and read
 * only through `platform_metrics()`. Platform table: no tenant, no runtime grants.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    workerId: text('worker_id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    beatAt: timestamp('beat_at', { withTimezone: true }).notNull(),
    version: text('version'),
  },
  (t) => [check('worker_heartbeats_id_length', sql`length(${t.workerId}) BETWEEN 1 AND 100`)],
);

export const BACKUP_RUN_KINDS = ['BACKUP', 'RESTORE_DRILL'] as const;

/**
 * Every successful backup and every passed restore drill (ADR-0016 slice 4), written only by
 * `platform_record_backup()` (the backup login) and read only through `platform_metrics()`.
 * Platform table: no tenant, no runtime grants, append-only.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    kind: text('kind').$type<(typeof BACKUP_RUN_KINDS)[number]>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
    /** File name of the encrypted backup (the drill names the backup it restored). */
    backupFile: text('backup_file').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    migrations: integer('migrations').notNull(),
    /** Counts and timings only (tables, rows, RTO phases); never tenant data. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('backup_runs_kind_finished_idx').on(t.kind, t.finishedAt),
    check('backup_runs_kind_check', sql`${t.kind} IN ('BACKUP','RESTORE_DRILL')`),
    check('backup_runs_file_length', sql`length(${t.backupFile}) BETWEEN 1 AND 200`),
    check('backup_runs_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('backup_runs_order', sql`${t.finishedAt} >= ${t.startedAt}`),
  ],
);
