import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './platform.js';
import { branches } from './organization.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });

export const unitsOfMeasure = pgTable(
  'units_of_measure',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    allowsFraction: boolean('allows_fraction').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('units_of_measure_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('units_of_measure_tenant_code_unique').on(t.tenantId, t.code),
    check('units_of_measure_code_format', sql`${t.code} ~ '^[A-Z][A-Z0-9]{0,9}$'`),
  ],
);

export const VAT_TREATMENTS = ['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** Classification only. Rates and computation rules live in the versioned tax engine (Phase 2). */
export const taxCategories = pgTable(
  'tax_categories',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    vatTreatment: text('vat_treatment').$type<VatTreatment>().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tax_categories_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('tax_categories_tenant_code_unique').on(t.tenantId, t.code),
    check('tax_categories_vat_treatment_check', sql`${t.vatTreatment} IN ('VATABLE','VAT_EXEMPT','ZERO_RATED')`),
    check('tax_categories_code_format', sql`${t.code} ~ '^[A-Z][A-Z0-9_]{0,29}$'`),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Part of the trial's sample set (ADR-0016 slice 6): labelled, and archived together by "remove sample items". */
    isSample: boolean('is_sample').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('categories_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.parentId], foreignColumns: [t.tenantId, t.id] }),
    check('categories_not_own_parent', sql`${t.parentId} IS DISTINCT FROM ${t.id}`),
  ],
);

/** PACKAGE: prepaid sessions of services (ADR-0022 §6). */
export const PRODUCT_TYPES = ['STANDARD', 'SERVICE', 'PACKAGE'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const SOLD_BY = ['UNIT', 'WEIGHT'] as const;
export type SoldBy = (typeof SOLD_BY)[number];

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    categoryId: uuid('category_id'),
    taxCategoryId: uuid('tax_category_id').notNull(),
    uomId: uuid('uom_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    productType: text('product_type').$type<ProductType>().notNull().default('STANDARD'),
    soldBy: text('sold_by').$type<SoldBy>().notNull().default('UNIT'),
    trackInventory: boolean('track_inventory').notNull().default(true),
    /** Stock comes in with expiry dates, kept as lots drawn first-expiry-first (ADR-0020 §3). */
    tracksExpiry: boolean('tracks_expiry').notNull().default(false),
    /** Part of the trial's sample set (ADR-0016 slice 6): labelled, and archived together by "remove sample items". */
    isSample: boolean('is_sample').notNull().default(false),
    /**
     * A medicine (ADR-0025 §2): its class (OTC, RX, ANTIBIOTIC, DANGEROUS), generic name, strength, dosage
     * form and FDA registration; null class = not a drug. The brand is the product's name. `generic_key`
     * (generated) finds equivalents and fills prescriptions.
     */
    drugClass: text('drug_class'),
    genericName: text('generic_name'),
    strength: text('strength'),
    dosageForm: text('dosage_form'),
    fdaRegistrationNo: text('fda_registration_no'),
    genericKey: text('generic_key').generatedAlwaysAs(sql.raw(String.raw`CASE WHEN generic_name IS NULL THEN NULL ELSE lower(regexp_replace(btrim(generic_name), '\s+', ' ', 'g')) || '|' || lower(regexp_replace(coalesce(strength, ''), '\s+', '', 'g')) || '|' || coalesce(dosage_form, '') END`)),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('products_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.categoryId], foreignColumns: [categories.tenantId, categories.id] }),
    foreignKey({ columns: [t.tenantId, t.taxCategoryId], foreignColumns: [taxCategories.tenantId, taxCategories.id] }),
    foreignKey({ columns: [t.tenantId, t.uomId], foreignColumns: [unitsOfMeasure.tenantId, unitsOfMeasure.id] }),
    index('products_tenant_name_idx').on(t.tenantId, sql`lower(${t.name})`),
    index('products_tenant_category_idx').on(t.tenantId, t.categoryId),
    check('products_type_check', sql`${t.productType} IN ('STANDARD','SERVICE','PACKAGE')`),
    check('products_sold_by_check', sql`${t.soldBy} IN ('UNIT','WEIGHT')`),
    check('products_service_untracked', sql`${t.productType} = 'STANDARD' OR NOT ${t.trackInventory}`),
    check('products_drug_class_check', sql`${t.drugClass} IS NULL OR (${t.drugClass} IN ('OTC','RX','ANTIBIOTIC','DANGEROUS') AND ${t.productType} = 'STANDARD' AND length(btrim(coalesce(${t.genericName}, ''))) BETWEEN 1 AND 200)`),
    check('products_dosage_form_check', sql`${t.dosageForm} IS NULL OR ${t.dosageForm} IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','DROPS','CREAM','OINTMENT','INJECTION','INHALER','SACHET','OTHER')`),
    index('products_generic_key_idx').on(t.tenantId, t.genericKey).where(sql`${t.genericKey} IS NOT NULL`),
  ],
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    sku: text('sku').notNull(),
    /** e.g. "Large / Red"; null for a product's single default variant. */
    name: text('name'),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    /** Reference/standard cost for margin hints. Actual inventory cost comes from the stock ledger. */
    referenceCost: money('reference_cost'),
    /** Its button on the till's quick keys (1–48), or null (ADR-0021 §3). */
    quickKeyPosition: integer('quick_key_position'),
    /** A service's duration, needed to book it (ADR-0022 §3). */
    serviceMinutes: integer('service_minutes'),
    /** A package's validity from the day it is sold; null = no expiry (ADR-0022 §6). */
    packageValidDays: integer('package_valid_days'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_variants_tenant_id_id_unique').on(t.tenantId, t.id),
    check('product_variants_service_minutes_range', sql`${t.serviceMinutes} IS NULL OR ${t.serviceMinutes} BETWEEN 5 AND 720`),
    check('product_variants_package_days_range', sql`${t.packageValidDays} IS NULL OR ${t.packageValidDays} BETWEEN 1 AND 3650`),
    check('product_variants_quick_key_range', sql`${t.quickKeyPosition} IS NULL OR ${t.quickKeyPosition} BETWEEN 1 AND 48`),
    foreignKey({ columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }),
    uniqueIndex('product_variants_tenant_sku_unique').on(t.tenantId, sql`lower(${t.sku})`).where(sql`${t.archivedAt} IS NULL`),
    index('product_variants_product_idx').on(t.tenantId, t.productId),
    // Terminal snapshot pages walk active items in (sku, id) order and stop after a page (ADR-0016 slice 5).
    index('product_variants_snapshot_order_idx').on(t.tenantId, t.sku, t.id).where(sql`${t.archivedAt} IS NULL`),
    check('product_variants_sku_format', sql`${t.sku} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'`),
    check('product_variants_cost_non_negative', sql`${t.referenceCost} IS NULL OR ${t.referenceCost} >= 0`),
  ],
);

export const barcodes = pgTable(
  'barcodes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    code: text('code').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('barcodes_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    uniqueIndex('barcodes_tenant_code_active_unique').on(t.tenantId, t.code).where(sql`${t.archivedAt} IS NULL`),
    index('barcodes_variant_idx').on(t.tenantId, t.variantId),
    check('barcodes_code_format', sql`${t.code} ~ '^[A-Za-z0-9-]{1,64}$'`),
  ],
);

/**
 * Tingi (ADR-0020): a pack and the piece sold from it are two items, each with its own stock, price
 * and barcode; opening a pack (`pack_openings`) turns one into `pieces_per_pack` of the other. A link
 * is never edited except `auto_open` and archiving; a new count is a new link, so old openings keep theirs.
 */
export const packConversions = pgTable(
  'pack_conversions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    packVariantId: uuid('pack_variant_id').notNull(),
    pieceVariantId: uuid('piece_variant_id').notNull(),
    piecesPerPack: numeric('pieces_per_pack', { precision: 18, scale: 4 }).notNull(),
    /** A sale short of pieces opens packs by itself (ADR-0020 §2). */
    autoOpen: boolean('auto_open').notNull().default(true),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('pack_conversions_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.packVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.pieceVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    // A piece comes from one pack at a time.
    uniqueIndex('pack_conversions_one_pack_per_piece').on(t.tenantId, t.pieceVariantId).where(sql`${t.archivedAt} IS NULL`),
    index('pack_conversions_pack_idx').on(t.tenantId, t.packVariantId),
    check('pack_conversions_distinct', sql`${t.packVariantId} <> ${t.pieceVariantId}`),
    check('pack_conversions_count', sql`${t.piecesPerPack} > 1`),
  ],
);

export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    /** Whether amounts in this list already include VAT (typical PH shelf pricing). */
    pricesIncludeTax: boolean('prices_include_tax').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('price_lists_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('price_lists_tenant_name_unique').on(t.tenantId, t.name),
    uniqueIndex('price_lists_one_default').on(t.tenantId).where(sql`${t.isDefault}`),
    check('price_lists_default_not_archived', sql`NOT (${t.isDefault} AND ${t.archivedAt} IS NOT NULL)`),
  ],
);

/** A branch uses its assigned price list, else the tenant default. */
export const branchPriceLists = pgTable(
  'branch_price_lists',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    priceListId: uuid('price_list_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
  ],
);

/**
 * Append-only, effective-dated prices. The price in force at instant T is the row with
 * the greatest effective_from <= T. Changing a price = inserting a new row, so every
 * historical sale can be traced to the exact price version used.
 */
export const productPrices = pgTable(
  'product_prices',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    priceListId: uuid('price_list_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    amount: money('amount').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_prices_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('product_prices_version_unique').on(t.tenantId, t.priceListId, t.variantId, t.effectiveFrom),
    foreignKey({ columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    index('product_prices_lookup_idx').on(t.tenantId, t.priceListId, t.variantId, t.effectiveFrom.desc()),
    // The next scheduled change of a list (tills refresh when it takes effect).
    index('product_prices_schedule_idx').on(t.tenantId, t.priceListId, t.effectiveFrom),
    check('product_prices_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

/**
 * One counter per business, bumped by a statement trigger whenever anything a till's snapshot is made
 * of changes (items, prices, lists, barcodes, tax, branch and register names). A till compares it with
 * the version its snapshot was taken at and fetches a new one when they differ (session 16).
 */
export const catalogVersions = pgTable('catalog_versions', {
  tenantId: uuid('tenant_id').primaryKey(),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ------------------------------------------------------------------ promotions (ADR-0021)

export const PROMOTION_KINDS = ['MULTI_BUY', 'BUY_X_GET_Y', 'QUANTITY_BREAK'] as const;
export type PromotionKindCode = (typeof PROMOTION_KINDS)[number];

/**
 * A promotion over a set of items (`promotion_items`), at every branch or the listed ones
 * (`promotion_branches`), from `starts_at` until `ends_at`. Its terms never change once made (a trigger
 * allows only the name and ending it earlier), so any sale can be re-priced as of any instant; changing
 * the terms means ending it and making a new one. Applied by `@1pos/pricing`.
 */
export const promotions = pgTable(
  'promotions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    kind: text('kind').$type<PromotionKindCode>().notNull(),
    /** MULTI_BUY: `quantity` units for `price`. */
    quantity: integer('quantity'),
    price: money('price'),
    /** BUY_X_GET_Y: buy `buy_quantity`, get `get_quantity` at `get_rate` off. */
    buyQuantity: integer('buy_quantity'),
    getQuantity: integer('get_quantity'),
    getRate: numeric('get_rate', { precision: 7, scale: 6 }),
    /** QUANTITY_BREAK: `[{ minQuantity, rate }]`, ascending. */
    tiers: jsonb('tiers').$type<{ minQuantity: string; rate: string }[]>(),
    allBranches: boolean('all_branches').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('promotions_tenant_id_id_unique').on(t.tenantId, t.id),
    index('promotions_window_idx').on(t.tenantId, t.startsAt, t.endsAt),
    check('promotions_kind_check', sql`${t.kind} IN ('MULTI_BUY','BUY_X_GET_Y','QUANTITY_BREAK')`),
    check('promotions_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('promotions_window_check', sql`${t.endsAt} IS NULL OR ${t.endsAt} >= ${t.startsAt}`),
    check(
      'promotions_terms_check',
      sql`CASE ${t.kind}
        WHEN 'MULTI_BUY' THEN coalesce(${t.quantity} >= 2 AND ${t.price} >= 0 AND ${t.buyQuantity} IS NULL AND ${t.getQuantity} IS NULL AND ${t.getRate} IS NULL AND ${t.tiers} IS NULL, false)
        WHEN 'BUY_X_GET_Y' THEN coalesce(${t.buyQuantity} >= 1 AND ${t.getQuantity} >= 1 AND ${t.getRate} > 0 AND ${t.getRate} <= 1 AND ${t.quantity} IS NULL AND ${t.price} IS NULL AND ${t.tiers} IS NULL, false)
        ELSE coalesce(jsonb_typeof(${t.tiers}) = 'array' AND jsonb_array_length(${t.tiers}) BETWEEN 1 AND 5 AND ${t.quantity} IS NULL AND ${t.price} IS NULL AND ${t.buyQuantity} IS NULL AND ${t.getQuantity} IS NULL AND ${t.getRate} IS NULL, false)
      END`,
    ),
  ],
);

/** The items of a promotion's set; written with the promotion, never changed. */
export const promotionItems = pgTable(
  'promotion_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    promotionId: uuid('promotion_id').notNull(),
    variantId: uuid('variant_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.promotionId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.promotionId], foreignColumns: [promotions.tenantId, promotions.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    index('promotion_items_variant_idx').on(t.tenantId, t.variantId),
  ],
);

/** The branches of a promotion that is not for every branch; written with it, never changed. */
export const promotionBranches = pgTable(
  'promotion_branches',
  {
    tenantId: uuid('tenant_id').notNull(),
    promotionId: uuid('promotion_id').notNull(),
    branchId: uuid('branch_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.promotionId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.promotionId], foreignColumns: [promotions.tenantId, promotions.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);
