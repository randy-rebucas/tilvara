import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { branches } from './organization.js';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });
const STATION_CODE = `'^[A-Z][A-Z0-9_]{0,15}$'`;

// ------------------------------------------------------------------ kitchen stations (ADR-0014 §5)

/**
 * A preparation station at a branch (Grill, Bar, …). Menu items route by station `code`, so one
 * tenant-wide menu works at every branch; items without a matching code go to the default station.
 */
export const kitchenStations = pgTable(
  'kitchen_stations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kitchen_stations_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    uniqueIndex('kitchen_stations_code_active_unique').on(t.tenantId, t.branchId, t.code).where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('kitchen_stations_default_unique').on(t.tenantId, t.branchId).where(sql`${t.isDefault} AND ${t.archivedAt} IS NULL`),
    check('kitchen_stations_code_check', sql`${t.code} ~ ${sql.raw(STATION_CODE)}`),
    check('kitchen_stations_name_check', sql`length(trim(${t.name})) > 0`),
    check('kitchen_stations_default_active', sql`NOT (${t.isDefault} AND ${t.archivedAt} IS NOT NULL)`),
  ],
);

// ------------------------------------------------------------------ dining areas and tables

export const diningAreas = pgTable(
  'dining_areas',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('dining_areas_tenant_id_id_unique').on(t.tenantId, t.id),
    // Lets a table's FK pin its area to the same branch.
    unique('dining_areas_branch_id_unique').on(t.tenantId, t.branchId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    uniqueIndex('dining_areas_name_active_unique').on(t.tenantId, t.branchId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    check('dining_areas_name_check', sql`length(trim(${t.name})) > 0`),
  ],
);

/** A table. Its status (free / occupied) is derived from open orders, never stored. */
export const restaurantTables = pgTable(
  'restaurant_tables',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    areaId: uuid('area_id').notNull(),
    code: text('code').notNull(),
    seats: integer('seats').notNull().default(2),
    /** Optional floor-plan placement (grid units) and shape. */
    posX: integer('pos_x'),
    posY: integer('pos_y'),
    shape: text('shape'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('restaurant_tables_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.areaId], foreignColumns: [diningAreas.tenantId, diningAreas.branchId, diningAreas.id] }),
    uniqueIndex('restaurant_tables_code_active_unique').on(t.tenantId, t.branchId, sql`lower(${t.code})`).where(sql`${t.archivedAt} IS NULL`),
    check('restaurant_tables_code_check', sql`length(trim(${t.code})) BETWEEN 1 AND 20`),
    check('restaurant_tables_seats_check', sql`${t.seats} BETWEEN 1 AND 99`),
    check('restaurant_tables_shape_check', sql`${t.shape} IS NULL OR ${t.shape} IN ('SQUARE','ROUND','RECT')`),
    check('restaurant_tables_pos_check', sql`(${t.posX} IS NULL) = (${t.posY} IS NULL) AND coalesce(${t.posX}, 0) BETWEEN 0 AND 999 AND coalesce(${t.posY}, 0) BETWEEN 0 AND 999`),
  ],
);

// ------------------------------------------------------------------ modifiers (ADR-0014 §3)

/** Choose between min and max options (required = min ≥ 1). Configuration: editable, archived not deleted. */
export const modifierGroups = pgTable(
  'modifier_groups',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    minSelect: integer('min_select').notNull().default(0),
    maxSelect: integer('max_select').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('modifier_groups_tenant_id_id_unique').on(t.tenantId, t.id),
    check('modifier_groups_name_check', sql`length(trim(${t.name})) > 0`),
    check('modifier_groups_select_check', sql`${t.minSelect} >= 0 AND ${t.maxSelect} >= 1 AND ${t.maxSelect} >= ${t.minSelect} AND ${t.maxSelect} <= 20`),
  ],
);

/**
 * One choice. With a variant it is priced (that variant's branch price) and moves stock or consumes
 * its recipe like any item; without one it is a free kitchen instruction ("No onions").
 */
export const modifierOptions = pgTable(
  'modifier_options',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    modifierGroupId: uuid('modifier_group_id').notNull(),
    name: text('name').notNull(),
    variantId: uuid('variant_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('modifier_options_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.modifierGroupId], foreignColumns: [modifierGroups.tenantId, modifierGroups.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    uniqueIndex('modifier_options_name_active_unique').on(t.tenantId, t.modifierGroupId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    check('modifier_options_name_check', sql`length(trim(${t.name})) > 0`),
  ],
);

// ------------------------------------------------------------------ menus and versions (ADR-0014 §2)

export const menus = pgTable(
  'menus',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('menus_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('menus_name_active_unique').on(t.tenantId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    check('menus_name_check', sql`length(trim(${t.name})) > 0`),
  ],
);

/**
 * DRAFT → PUBLISHED → RETIRED (trigger-enforced). Content is editable only while DRAFT; at most one
 * draft and one published version per menu. Publishing retires the previous published version.
 */
export const menuVersions = pgTable(
  'menu_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    menuId: uuid('menu_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('DRAFT'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_versions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('menu_versions_version_unique').on(t.tenantId, t.menuId, t.version),
    foreignKey({ columns: [t.tenantId, t.menuId], foreignColumns: [menus.tenantId, menus.id] }),
    uniqueIndex('menu_versions_one_draft').on(t.tenantId, t.menuId).where(sql`${t.status} = 'DRAFT'`),
    uniqueIndex('menu_versions_one_published').on(t.tenantId, t.menuId).where(sql`${t.status} = 'PUBLISHED'`),
    check('menu_versions_status_check', sql`${t.status} IN ('DRAFT','PUBLISHED','RETIRED')`),
    check('menu_versions_published_check', sql`(${t.status} = 'DRAFT') = (${t.publishedAt} IS NULL)`),
  ],
);

export const menuSections = pgTable(
  'menu_sections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    menuVersionId: uuid('menu_version_id').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    unique('menu_sections_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('menu_sections_version_id_unique').on(t.tenantId, t.menuVersionId, t.id),
    foreignKey({ columns: [t.tenantId, t.menuVersionId], foreignColumns: [menuVersions.tenantId, menuVersions.id] }),
    check('menu_sections_name_check', sql`length(trim(${t.name})) > 0`),
  ],
);

/** A sold item on a menu version, with its kitchen route and attached modifier groups. */
export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    menuVersionId: uuid('menu_version_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    displayName: text('display_name'),
    stationCode: text('station_code'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    unique('menu_items_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('menu_items_variant_unique').on(t.tenantId, t.menuVersionId, t.variantId),
    unique('menu_items_version_id_unique').on(t.tenantId, t.menuVersionId, t.id),
    foreignKey({ columns: [t.tenantId, t.menuVersionId, t.sectionId], foreignColumns: [menuSections.tenantId, menuSections.menuVersionId, menuSections.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('menu_items_station_check', sql`${t.stationCode} IS NULL OR ${t.stationCode} ~ ${sql.raw(STATION_CODE)}`),
  ],
);

export const menuItemModifierGroups = pgTable(
  'menu_item_modifier_groups',
  {
    tenantId: uuid('tenant_id').notNull(),
    menuVersionId: uuid('menu_version_id').notNull(),
    menuItemId: uuid('menu_item_id').notNull(),
    modifierGroupId: uuid('modifier_group_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.menuItemId, t.modifierGroupId] }),
    foreignKey({ columns: [t.tenantId, t.menuVersionId, t.menuItemId], foreignColumns: [menuItems.tenantId, menuItems.menuVersionId, menuItems.id] }),
    foreignKey({ columns: [t.tenantId, t.modifierGroupId], foreignColumns: [modifierGroups.tenantId, modifierGroups.id] }),
  ],
);

// ------------------------------------------------------------------ per-branch settings and 86

/**
 * Per branch: which menu serves each order type and the service charge (ADR-0014 §9). The charge is
 * computed on items net of discounts, ex VAT (tax adviser to confirm), and is never part of item prices.
 */
export const restaurantSettings = pgTable(
  'restaurant_settings',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    dineInMenuId: uuid('dine_in_menu_id'),
    takeawayMenuId: uuid('takeaway_menu_id'),
    serviceChargeRate: numeric('service_charge_rate', { precision: 9, scale: 6 }).notNull().default('0'),
    serviceChargeDineIn: boolean('service_charge_dine_in').notNull().default(true),
    serviceChargeTakeaway: boolean('service_charge_takeaway').notNull().default(false),
    serviceChargeVatTreatment: text('service_charge_vat_treatment').notNull().default('VATABLE'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.dineInMenuId], foreignColumns: [menus.tenantId, menus.id] }),
    foreignKey({ columns: [t.tenantId, t.takeawayMenuId], foreignColumns: [menus.tenantId, menus.id] }),
    check('restaurant_settings_rate_check', sql`${t.serviceChargeRate} >= 0 AND ${t.serviceChargeRate} <= 0.3`),
    check('restaurant_settings_vat_check', sql`${t.serviceChargeVatTreatment} IN ('VATABLE','VAT_EXEMPT')`),
  ],
);

/** "86": an item sold out at a branch right now. A row exists only while sold out. */
export const soldOutItems = pgTable(
  'sold_out_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    note: text('note'),
    markedBy: uuid('marked_by').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
  ],
);

// ------------------------------------------------------------------ recipes (ADR-0014 §4)

/**
 * What one unit of a sold item consumes, as of `effective_from`. Append-only and never backdated
 * (DB triggers), so the version a sale consumed with never changes; the one in force at T is the
 * latest with effective_from <= T. A version without ingredients stops consumption from then on.
 */
export const recipeVersions = pgTable(
  'recipe_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    /** The sold item (does not track inventory itself). */
    variantId: uuid('variant_id').notNull(),
    version: integer('version').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recipe_versions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('recipe_versions_version_unique').on(t.tenantId, t.variantId, t.version),
    unique('recipe_versions_effective_unique').on(t.tenantId, t.variantId, t.effectiveFrom),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    index('recipe_versions_lookup_idx').on(t.tenantId, t.variantId, t.effectiveFrom.desc()),
    check('recipe_versions_version_check', sql`${t.version} > 0`),
  ],
);

/** One ingredient of a recipe version: quantity per one unit sold, in the ingredient's own unit. */
export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    recipeVersionId: uuid('recipe_version_id').notNull(),
    ingredientVariantId: uuid('ingredient_variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recipe_ingredients_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('recipe_ingredients_ingredient_unique').on(t.tenantId, t.recipeVersionId, t.ingredientVariantId),
    foreignKey({ columns: [t.tenantId, t.recipeVersionId], foreignColumns: [recipeVersions.tenantId, recipeVersions.id] }),
    foreignKey({ columns: [t.tenantId, t.ingredientVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('recipe_ingredients_quantity_check', sql`${t.quantity} > 0`),
  ],
);
