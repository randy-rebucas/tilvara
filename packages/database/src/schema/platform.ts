import { sql } from 'drizzle-orm';
import { char, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const TENANT_STATUSES = ['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/**
 * What the business does: it decides which features its people see. RETAIL hides restaurant
 * service (and the server refuses its writes); RESTAURANT hides selling by weight; HYBRID shows all.
 */
export const BUSINESS_TYPES = ['RETAIL', 'RESTAURANT', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').$type<TenantStatus>().notNull().default('PROVISIONING'),
    defaultCurrency: char('default_currency', { length: 3 }).notNull().default('PHP'),
    timezone: text('timezone').notNull().default('Asia/Manila'),
    businessType: text('business_type').$type<BusinessType>().notNull().default('HYBRID'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tenants_status_check', sql`${t.status} IN ('PROVISIONING','ACTIVE','SUSPENDED','OFFBOARDING','CLOSED')`),
    check('tenants_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('tenants_business_type_check', sql`${t.businessType} IN ('RETAIL','RESTAURANT','HYBRID')`),
  ],
);

export const AUDIT_ACTOR_TYPES = ['USER', 'SYSTEM', 'SUPPORT', 'TERMINAL'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Append-only (enforced by trigger). tenant_id NULL only for platform-level events. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    actorType: text('actor_type').$type<AuditActorType>().notNull(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    correlationId: text('correlation_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('audit_logs_actor_type_check', sql`${t.actorType} IN ('USER','SYSTEM','SUPPORT','TERMINAL')`),
    index('audit_logs_tenant_time_idx').on(t.tenantId, t.occurredAt.desc()),
    index('audit_logs_resource_idx').on(t.tenantId, t.resourceType, t.resourceId),
  ],
);
