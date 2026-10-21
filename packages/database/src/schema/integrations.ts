import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

// ------------------------------------------------------------------ integrations (session 20, SPEC §6.11, ADR-0019)

/**
 * A business's key for reading its own data from another system (reporting, accounting). Read-only
 * and scoped to a few `*.read` permissions; shown once, stored as a SHA-256 hash the runtime role
 * cannot read (`auth_api_key()` checks it). Revoked for good.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** The public part of the key (`tlv_<prefix>_…`), unique across businesses, to find the row. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    unique('api_keys_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('api_keys_prefix_unique').on(t.prefix),
    check('api_keys_name_check', sql`length(trim(${t.name})) BETWEEN 1 AND 100`),
    check('api_keys_scopes_check', sql`cardinality(${t.scopes}) > 0 AND ${t.scopes} <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read','lodging.read','laundry.read','appointments.read']::text[]`),
    check('api_keys_revoked_check', sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`),
  ],
);

/**
 * Where to send the business's events (SPEC §6.11). Thin events: ids only; the receiver reads the
 * details with an API key. Signed with HMAC-SHA256 under a secret derived from the server's
 * WEBHOOK_SIGNING_KEY and `signing_salt`, so no secret is stored; rotating changes the salt.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    url: text('url').notNull(),
    description: text('description'),
    topics: text('topics').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    signingSalt: text('signing_salt').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('webhook_endpoints_tenant_id_id_unique').on(t.tenantId, t.id),
    check('webhook_endpoints_url_check', sql`${t.url} ~ '^https?://' AND length(${t.url}) <= 500`),
    check('webhook_endpoints_topics_check', sql`cardinality(${t.topics}) > 0`),
  ],
);

export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'DELIVERING', 'DELIVERED', 'DEAD'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * One event for one endpoint: at least once, retried with backoff, DEAD after `max_attempts` (a
 * manager may send it again). Written and claimed only through the `webhook_*` functions (the worker),
 * plus the test ping and the retry the API makes for a manager.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    /** The outbox event it carries; null for a test ping. */
    eventId: uuid('event_id'),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('webhook_deliveries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.endpointId], foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id] }),
    uniqueIndex('webhook_deliveries_event_once').on(t.endpointId, t.eventId).where(sql`${t.eventId} IS NOT NULL`),
    index('webhook_deliveries_due_idx').on(t.availableAt).where(sql`${t.status} IN ('PENDING','DELIVERING')`),
    index('webhook_deliveries_endpoint_idx').on(t.tenantId, t.endpointId, t.createdAt.desc()),
    check('webhook_deliveries_status_check', sql`${t.status} IN ('PENDING','DELIVERING','DELIVERED','DEAD')`),
  ],
);
