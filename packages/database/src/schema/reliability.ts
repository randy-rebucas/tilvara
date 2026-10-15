import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
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
    check('outbox_events_status_check', sql`${t.status} IN ('PENDING','PROCESSING','DONE','DEAD')`),
    check('outbox_events_topic_format', sql`${t.topic} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
  ],
);
