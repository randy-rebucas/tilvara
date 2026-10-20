import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

// ------------------------------------------------------------------ customers (SPEC §6.9, ADR-0018)

/**
 * A business's customer: who they are and how to reach them, only as far as the business needs it
 * (privacy pack: processing register §8). Business-wide, like suppliers. Corrections overwrite the
 * profile (audited by field name, never by value); anonymising blanks every personal field for good
 * while the customer's sales and store credit stay linked to the row.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The business's own customer number or card number, optional. */
    code: text('code'),
    displayName: text('display_name').notNull(),
    phone: text('phone'),
    email: text('email'),
    /** For a business buyer who asks for it on the receipt. */
    tin: text('tin'),
    address: text('address'),
    notes: text('notes'),
    /** Marketing consent, separate from what a purchase needs (SPEC §6.9); its history is in customer_consent_events. */
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
  },
  (t) => [
    unique('customers_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('customers_code_active_unique').on(t.tenantId, sql`lower(${t.code})`).where(sql`${t.archivedAt} IS NULL AND ${t.code} IS NOT NULL`),
    index('customers_name_idx').on(t.tenantId, sql`lower(${t.displayName})`),
    index('customers_phone_idx').on(t.tenantId, t.phone),
    check('customers_name_check', sql`length(trim(${t.displayName})) BETWEEN 1 AND 200`),
    check('customers_consent_check', sql`(${t.marketingConsent}) = (${t.marketingConsentAt} IS NOT NULL)`),
    check(
      'customers_anonymised_check',
      sql`${t.anonymisedAt} IS NULL OR (${t.phone} IS NULL AND ${t.email} IS NULL AND ${t.tin} IS NULL AND ${t.address} IS NULL AND ${t.notes} IS NULL AND ${t.code} IS NULL AND NOT ${t.marketingConsent} AND ${t.archivedAt} IS NOT NULL)`,
    ),
  ],
);

/** Every change of marketing consent, who recorded it and how it was given (append-only). */
export const customerConsentEvents = pgTable(
  'customer_consent_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    purpose: text('purpose').notNull().default('MARKETING'),
    granted: boolean('granted').notNull(),
    /** COUNTER (asked at the till), ADMIN (back office), REQUEST (the customer asked, e.g. to stop). */
    source: text('source').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_consent_events_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('customer_consent_events_customer_idx').on(t.tenantId, t.customerId, t.recordedAt),
    check('customer_consent_events_purpose_check', sql`${t.purpose} IN ('MARKETING')`),
    check('customer_consent_events_source_check', sql`${t.source} IN ('COUNTER','ADMIN','REQUEST')`),
  ],
);
