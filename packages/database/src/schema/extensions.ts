import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantMemberships } from './identity.js';
import { tenants } from './platform.js';

/**
 * Extensions (ADR-0026): industry modules built on the retail base, switched on per business.
 * Global catalog, platform-maintained: an extension's migration inserts its row (with its
 * permission rows and the plans that allow it, `plans.extensions`). Read-only to tenants.
 */
export const extensions = pgTable(
  'extensions',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** False: withdrawn from the catalog; nobody may switch it on, and where it is on it stops being usable. */
    active: boolean('active').notNull().default(true),
  },
  (t) => [check('extensions_code_format', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,39}$'`)],
);

/**
 * Which extensions a business has switched on (one row per extension it ever switched on). Usable =
 * enabled, active in the catalog and allowed by the current plan (`app_extension_usable`). Switching
 * off keeps the extension's records; the history is in the audit log.
 */
export const tenantExtensions = pgTable(
  'tenant_extensions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    extensionCode: text('extension_code')
      .notNull()
      .references(() => extensions.code),
    enabled: boolean('enabled').notNull(),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tenant_extensions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('tenant_extensions_code_unique').on(t.tenantId, t.extensionCode),
    foreignKey({ columns: [t.tenantId, t.changedBy], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
  ],
);
