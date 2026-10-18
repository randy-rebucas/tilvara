import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { tenants } from './platform.js';

/**
 * 1POS support staff (ADR-0016 slice 6). A platform table: no runtime grants, managed by the ops
 * CLI (`support staff-add|staff-disable`) and read only by the `support_*` / `auth_*` functions.
 * Being staff gives no access by itself: a business must grant it (support_grants).
 */
export const platformStaff = pgTable(
  'platform_staff',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    status: text('status').notNull().default('ACTIVE'),
    addedBy: text('added_by').notNull(),
    addedReason: text('added_reason').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: text('disabled_by'),
    disabledReason: text('disabled_reason'),
  },
  (t) => [
    check('platform_staff_status_check', sql`${t.status} IN ('ACTIVE','DISABLED')`),
    check('platform_staff_disabled_consistent', sql`(${t.status} = 'DISABLED') = (${t.disabledAt} IS NOT NULL)`),
  ],
);

/**
 * Time-limited, purpose-specific access a business gives 1POS support (SPEC §13, THREAT_MODEL T14).
 * Read-only is the only access level. At most 72 hours; revoking ends it at once (the API re-checks
 * the grant on every request). Never deleted: the grant and its use stay in the business's records.
 */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: text('purpose').notNull(),
    ticketRef: text('ticket_ref'),
    access: text('access').notNull().default('READ_ONLY'),
    grantedBy: uuid('granted_by').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    unique('support_grants_tenant_id_id_unique').on(t.tenantId, t.id),
    index('support_grants_tenant_idx').on(t.tenantId, t.grantedAt.desc()),
    // Staff list open grants across businesses (through support_list_grants()).
    index('support_grants_open_idx').on(t.expiresAt).where(sql`${t.revokedAt} IS NULL`),
    check('support_grants_access_check', sql`${t.access} IN ('READ_ONLY')`),
    check('support_grants_purpose_present', sql`length(btrim(${t.purpose})) >= 5`),
    check('support_grants_window', sql`${t.expiresAt} > ${t.grantedAt} AND ${t.expiresAt} <= ${t.grantedAt} + interval '72 hours'`),
    check('support_grants_revoked_consistent', sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`),
  ],
);

export const DATA_EXPORT_STATUSES = ['REQUESTED', 'READY', 'FAILED', 'EXPIRED'] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/**
 * A business's copy of its own records (ADR-0016 slice 6): a ZIP of CSVs made by the worker from one
 * snapshot, kept in private storage until `expires_at`, downloaded through a short-lived signed link.
 * Status moves only through the worker's data_export_* functions.
 */
export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status').$type<DataExportStatus>().notNull().default('REQUESTED'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    fileKey: text('file_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    rowCounts: jsonb('row_counts').$type<Record<string, number>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    unique('data_exports_tenant_id_id_unique').on(t.tenantId, t.id),
    index('data_exports_tenant_idx').on(t.tenantId, t.requestedAt.desc()),
    // One export in the making per business.
    uniqueIndex('data_exports_one_requested').on(t.tenantId).where(sql`${t.status} = 'REQUESTED'`),
    // The worker's hourly sweep of files past their date.
    index('data_exports_ready_idx').on(t.expiresAt).where(sql`${t.status} = 'READY'`),
    check('data_exports_status_check', sql`${t.status} IN ('REQUESTED','READY','FAILED','EXPIRED')`),
    check('data_exports_ready_has_file', sql`${t.status} <> 'READY' OR (${t.fileKey} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`),
  ],
);
