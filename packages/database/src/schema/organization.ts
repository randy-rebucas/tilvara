import { sql } from 'drizzle-orm';
import { char, check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';

export const VAT_STATUSES = ['VAT', 'NON_VAT'] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];
export const PRICE_DISPLAY_MODES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;
export type PriceDisplayMode = (typeof PRICE_DISPLAY_MODES)[number];
export const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN'] as const;
/**
 * DISABLED: no invoice numbers issued (default). DEV_SERIES: test numbering clearly
 * marked non-official. A production mode is deliberately absent until the compliance
 * gate in docs/compliance is cleared.
 */
export const INVOICING_MODES = ['DISABLED', 'DEV_SERIES'] as const;
export type InvoicingMode = (typeof INVOICING_MODES)[number];

/** A taxpayer. Not necessarily the subscription owner. */
export const legalEntities = pgTable(
  'legal_entities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    registeredName: text('registered_name').notNull(),
    tradeName: text('trade_name'),
    /** 9-digit TIN without branch code; nullable until invoicing is configured. */
    tin: char('tin', { length: 9 }),
    vatStatus: text('vat_status').$type<VatStatus>().notNull(),
    registeredAddress: text('registered_address'),
    rdoCode: text('rdo_code'),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    priceDisplay: text('price_display').$type<PriceDisplayMode>().notNull().default('TAX_INCLUSIVE'),
    roundingMode: text('rounding_mode').$type<(typeof ROUNDING_MODES)[number]>().notNull().default('HALF_UP'),
    invoicingMode: text('invoicing_mode').$type<InvoicingMode>().notNull().default('DISABLED'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('legal_entities_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('legal_entities_tenant_tin_unique').on(t.tenantId, t.tin).where(sql`${t.tin} IS NOT NULL`),
    check('legal_entities_tin_format', sql`${t.tin} IS NULL OR ${t.tin} ~ '^[0-9]{9}$'`),
    check('legal_entities_vat_status_check', sql`${t.vatStatus} IN ('VAT','NON_VAT')`),
    check('legal_entities_price_display_check', sql`${t.priceDisplay} IN ('TAX_INCLUSIVE','TAX_EXCLUSIVE')`),
    check('legal_entities_rounding_check', sql`${t.roundingMode} IN ('HALF_UP','HALF_EVEN')`),
    check('legal_entities_invoicing_mode_check', sql`${t.invoicingMode} IN ('DISABLED','DEV_SERIES')`),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** BIR 5-digit branch code; 00000 = head office. */
    birBranchCode: char('bir_branch_code', { length: 5 }).notNull().default('00000'),
    address: text('address'),
    timezone: text('timezone').notNull().default('Asia/Manila'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('branches_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('branches_tenant_code_unique').on(t.tenantId, t.code),
    unique('branches_entity_bir_code_unique').on(t.tenantId, t.legalEntityId, t.birBranchCode),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    check('branches_code_format', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'`),
    check('branches_bir_code_format', sql`${t.birBranchCode} ~ '^[0-9]{5}$'`),
  ],
);

export const registers = pgTable(
  'registers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('registers_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('registers_branch_code_unique').on(t.tenantId, t.branchId, t.code),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check('registers_code_format', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'`),
  ],
);

export const TERMINAL_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * A physical device. The credential secret is shown once at registration; only its
 * SHA-256 is stored. Revoked terminals can never be reactivated (register a new one).
 */
export const terminals = pgTable(
  'terminals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    registerId: uuid('register_id').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<TerminalStatus>().notNull().default('ACTIVE'),
    credentialHash: text('credential_hash').notNull(),
    credentialHint: text('credential_hint').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('terminals_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('terminals_credential_hash_unique').on(t.credentialHash),
    index('terminals_register_idx').on(t.tenantId, t.registerId),
    foreignKey({ columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] }),
    check('terminals_status_check', sql`${t.status} IN ('ACTIVE','REVOKED')`),
    check('terminals_revoked_consistency', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`),
  ],
);
