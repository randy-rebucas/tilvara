import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, type VatStatus } from './organization.js';
import { tenants } from './platform.js';

const rate = (name: string) => numeric(name, { precision: 9, scale: 6 });

export const TAX_ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN'] as const;
export type TaxRoundingMode = (typeof TAX_ROUNDING_MODES)[number];

/**
 * A legal entity's tax registration as of `effective_from` (ADR-0008). Append-only and never
 * backdated (DB trigger), so the profile a sale was computed with never changes; the one in
 * force at time T is the latest with effective_from <= T.
 */
export const taxProfiles = pgTable(
  'tax_profiles',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid('legal_entity_id').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    vatStatus: text('vat_status').$type<VatStatus>().notNull(),
    vatRate: rate('vat_rate').notNull(),
    /** Reported for non-VAT sellers (e.g. 3 % percentage tax); never added to prices. */
    percentageTaxRate: rate('percentage_tax_rate').notNull(),
    roundingMode: text('rounding_mode').$type<TaxRoundingMode>().notNull().default('HALF_UP'),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tax_profiles_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('tax_profiles_version_unique').on(t.tenantId, t.legalEntityId, t.effectiveFrom),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    index('tax_profiles_lookup_idx').on(t.tenantId, t.legalEntityId, t.effectiveFrom.desc()),
    check('tax_profiles_vat_status_check', sql`${t.vatStatus} IN ('VAT','NON_VAT')`),
    check('tax_profiles_rounding_check', sql`${t.roundingMode} IN ('HALF_UP','HALF_EVEN')`),
    check(
      'tax_profiles_rates_check',
      sql`(${t.vatStatus} = 'VAT' AND ${t.vatRate} > 0 AND ${t.vatRate} < 1 AND ${t.percentageTaxRate} = 0)
       OR (${t.vatStatus} = 'NON_VAT' AND ${t.vatRate} = 0 AND ${t.percentageTaxRate} >= 0 AND ${t.percentageTaxRate} < 1)`,
    ),
  ],
);

export const SCHEME_BASES = ['VAT_EXCLUSIVE', 'GROSS'] as const;
export const SCHEME_REVIEW_STATUSES = ['PENDING_PROFESSIONAL_REVIEW', 'APPROVED'] as const;

/**
 * Platform-wide statutory discount schemes (SC, PWD, …), versioned. Tenants read them; only the
 * platform changes them. `review_status` stays PENDING until a PH tax professional signs off.
 */
export const discountSchemes = pgTable(
  'discount_schemes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    code: text('code').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    rate: rate('rate').notNull(),
    vatExempt: boolean('vat_exempt').notNull(),
    base: text('base').$type<(typeof SCHEME_BASES)[number]>().notNull(),
    requiresId: boolean('requires_id').notNull().default(true),
    reviewStatus: text('review_status').$type<(typeof SCHEME_REVIEW_STATUSES)[number]>().notNull().default('PENDING_PROFESSIONAL_REVIEW'),
    legalBasis: text('legal_basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('discount_schemes_code_version_unique').on(t.code, t.version),
    check('discount_schemes_rate_check', sql`${t.rate} > 0 AND ${t.rate} <= 1`),
    check('discount_schemes_base_check', sql`${t.base} IN ('VAT_EXCLUSIVE','GROSS')`),
    check('discount_schemes_review_check', sql`${t.reviewStatus} IN ('PENDING_PROFESSIONAL_REVIEW','APPROVED')`),
  ],
);
