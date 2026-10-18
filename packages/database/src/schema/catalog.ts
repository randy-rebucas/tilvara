import { sql } from 'drizzle-orm';
import {
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

export const PRODUCT_TYPES = ['STANDARD', 'SERVICE'] as const;
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
    check('products_type_check', sql`${t.productType} IN ('STANDARD','SERVICE')`),
    check('products_sold_by_check', sql`${t.soldBy} IN ('UNIT','WEIGHT')`),
    check('products_service_untracked', sql`${t.productType} <> 'SERVICE' OR NOT ${t.trackInventory}`),
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
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_variants_tenant_id_id_unique').on(t.tenantId, t.id),
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
    check('product_prices_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);
