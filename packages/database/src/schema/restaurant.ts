import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productPrices, productVariants } from './catalog.js';
import { stockAdjustments } from './inventory.js';
import { branches, legalEntities, terminals } from './organization.js';
import { taxProfiles } from './tax.js';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });
const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
/** The tax engine's result buckets (same columns as sales and sale lines). */
const buckets = () => ({
  gross: money('gross').notNull(),
  discount: money('discount').notNull(),
  statutoryDiscount: money('statutory_discount').notNull(),
  vatExemptionAmount: money('vat_exemption_amount').notNull(),
  vatableSales: money('vatable_sales').notNull(),
  vatAmount: money('vat_amount').notNull(),
  vatExemptSales: money('vat_exempt_sales').notNull(),
  zeroRatedSales: money('zero_rated_sales').notNull(),
  percentageTaxSales: money('percentage_tax_sales').notNull(),
  amountDue: money('amount_due').notNull(),
});
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
    unique('kitchen_stations_branch_id_unique').on(t.tenantId, t.branchId, t.id),
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
    unique('restaurant_tables_branch_id_unique').on(t.tenantId, t.branchId, t.id),
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
    /**
     * Counter service (ADR-0014 amendment, session 25): the counter's Sell screen takes the takeaway
     * menu's choices, and paying a sale sends its menu items to the kitchen (pay first, then fire).
     */
    counterService: boolean('counter_service').notNull().default(false),
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

// ------------------------------------------------------------------ orders (ADR-0014 §6) — operational, never financial

export const ORDER_STATUSES = ['OPEN', 'BILLED', 'SETTLED', 'CANCELLED', 'MERGED'] as const;
export const ORDER_ITEM_STATUSES = ['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED', 'VOIDED'] as const;

/**
 * A table's (or takeaway customer's) order. OPEN → BILLED → SETTLED, BILLED → OPEN (bill reopened),
 * OPEN → CANCELLED | MERGED (trigger-enforced). At most one live order per table. An order is not a
 * sale: settling it creates sales through checkout (slice 4).
 * A COUNTER order (session 25) is the kitchen's copy of a sale paid first at the counter: created with
 * its sale (`sale_id`, FK in 0092), fired at once and SETTLED (OPEN → SETTLED, counter orders only).
 */
export const restaurantOrders = pgTable(
  'restaurant_orders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    orderNumber: bigint('order_number', { mode: 'number' }).notNull(),
    orderType: text('order_type').notNull(),
    tableId: uuid('table_id'),
    guestCount: integer('guest_count'),
    /** Takeaway: the name called out at pickup. */
    customerName: text('customer_name'),
    note: text('note'),
    status: text('status').notNull().default('OPEN'),
    /** COUNTER orders: the sale that paid for it (one order per sale). */
    saleId: uuid('sale_id'),
    /**
     * An offline counter sale (session 25): the call number its till printed (the sale's device number),
     * shown instead of `order_number` everywhere so the customer's receipt matches the back office.
     */
    tillCallNumber: integer('till_call_number'),
    mergedIntoId: uuid('merged_into_id'),
    closeReason: text('close_reason'),
    openedBy: uuid('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('restaurant_orders_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('restaurant_orders_branch_id_unique').on(t.tenantId, t.branchId, t.id),
    unique('restaurant_orders_number_unique').on(t.tenantId, t.branchId, t.orderNumber),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.tableId], foreignColumns: [restaurantTables.tenantId, restaurantTables.branchId, restaurantTables.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.mergedIntoId], foreignColumns: [t.tenantId, t.branchId, t.id] }),
    uniqueIndex('restaurant_orders_table_live_unique').on(t.tenantId, t.tableId).where(sql`${t.status} IN ('OPEN','BILLED') AND ${t.tableId} IS NOT NULL`),
    index('restaurant_orders_branch_status_idx').on(t.tenantId, t.branchId, t.status),
    check('restaurant_orders_type_check', sql`${t.orderType} IN ('DINE_IN','TAKEAWAY','COUNTER')`),
    check('restaurant_orders_counter_sale_check', sql`(${t.orderType} = 'COUNTER') = (${t.saleId} IS NOT NULL)`),
    check('restaurant_orders_till_call_check', sql`${t.tillCallNumber} IS NULL OR (${t.orderType} = 'COUNTER' AND ${t.tillCallNumber} > 0)`),
    uniqueIndex('restaurant_orders_sale_unique').on(t.tenantId, t.saleId).where(sql`${t.saleId} IS NOT NULL`),
    check('restaurant_orders_status_check', sql`${t.status} IN ('OPEN','BILLED','SETTLED','CANCELLED','MERGED')`),
    check('restaurant_orders_table_check', sql`(${t.orderType} = 'DINE_IN') = (${t.tableId} IS NOT NULL)`),
    check('restaurant_orders_merged_check', sql`(${t.status} = 'MERGED') = (${t.mergedIntoId} IS NOT NULL) AND ${t.mergedIntoId} IS DISTINCT FROM ${t.id}`),
    check('restaurant_orders_guests_check', sql`${t.guestCount} IS NULL OR ${t.guestCount} BETWEEN 1 AND 500`),
    check('restaurant_orders_cancel_reason', sql`${t.status} <> 'CANCELLED' OR length(trim(coalesce(${t.closeReason}, ''))) > 0`),
  ],
);

/**
 * A kitchen ticket: the items of one order fired together to one station for one course. The items
 * carry their own preparation status; `bumped_at` records the station marking the whole ticket ready.
 */
export const kitchenTickets = pgTable(
  'kitchen_tickets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    orderId: uuid('order_id').notNull(),
    stationId: uuid('station_id').notNull(),
    ticketNumber: bigint('ticket_number', { mode: 'number' }).notNull(),
    course: integer('course').notNull(),
    firedBy: uuid('fired_by').notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    bumpedAt: timestamp('bumped_at', { withTimezone: true }),
    bumpedBy: uuid('bumped_by'),
    /** The order's note for this course when it was fired (frozen with the ticket). */
    courseNote: text('course_note'),
    /**
     * Kitchen printing (session 25): a desktop till that prints this station claims the ticket for a
     * minute (`print_claimed_*`), prints it and marks it printed; a reprint clears `printed_at`.
     */
    printClaimedAt: timestamp('print_claimed_at', { withTimezone: true }),
    printClaimedBy: uuid('print_claimed_by'),
    printedAt: timestamp('printed_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
  },
  (t) => [
    unique('kitchen_tickets_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('kitchen_tickets_number_unique').on(t.tenantId, t.branchId, t.ticketNumber),
    foreignKey({ columns: [t.tenantId, t.branchId, t.orderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.branchId, restaurantOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.stationId], foreignColumns: [kitchenStations.tenantId, kitchenStations.branchId, kitchenStations.id] }),
    index('kitchen_tickets_station_idx').on(t.tenantId, t.stationId, t.firedAt),
    foreignKey({ columns: [t.tenantId, t.printClaimedBy], foreignColumns: [terminals.tenantId, terminals.id] }),
    index('kitchen_tickets_unprinted_idx').on(t.tenantId, t.branchId, t.firedAt).where(sql`${t.printedAt} IS NULL`),
    check('kitchen_tickets_print_claim_check', sql`(${t.printClaimedAt} IS NULL) = (${t.printClaimedBy} IS NULL)`),
    check('kitchen_tickets_course_check', sql`${t.course} BETWEEN 1 AND 9`),
  ],
);

/**
 * An item on an order: a menu ITEM, or a MODIFIER of one (priced options carry their variant, free
 * instructions have none). PENDING items may be edited or removed; once fired, what was ordered is
 * frozen and the item can only progress or be voided (trigger-enforced). Modifiers follow their item.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    parentItemId: uuid('parent_item_id'),
    kind: text('kind').notNull(),
    variantId: uuid('variant_id'),
    modifierOptionId: uuid('modifier_option_id'),
    menuVersionId: uuid('menu_version_id').notNull(),
    /** Name as ordered (menu display name or option name). */
    name: text('name').notNull(),
    quantity: qty('quantity').notNull(),
    course: integer('course').notNull().default(1),
    seat: integer('seat'),
    note: text('note'),
    stationCode: text('station_code'),
    status: text('status').notNull().default('PENDING'),
    kitchenTicketId: uuid('kitchen_ticket_id'),
    addedBy: uuid('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    firedAt: timestamp('fired_at', { withTimezone: true }),
    prepStartedAt: timestamp('prep_started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    servedAt: timestamp('served_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by'),
    voidReason: text('void_reason'),
    /** Voided after preparation started and thrown away: the WASTE document that took the stock. */
    wasteAdjustmentId: uuid('waste_adjustment_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('order_items_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.parentItemId], foreignColumns: [t.tenantId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.modifierOptionId], foreignColumns: [modifierOptions.tenantId, modifierOptions.id] }),
    foreignKey({ columns: [t.tenantId, t.menuVersionId], foreignColumns: [menuVersions.tenantId, menuVersions.id] }),
    foreignKey({ columns: [t.tenantId, t.kitchenTicketId], foreignColumns: [kitchenTickets.tenantId, kitchenTickets.id] }),
    foreignKey({ columns: [t.tenantId, t.wasteAdjustmentId], foreignColumns: [stockAdjustments.tenantId, stockAdjustments.id] }),
    index('order_items_order_idx').on(t.tenantId, t.orderId),
    index('order_items_ticket_idx').on(t.tenantId, t.kitchenTicketId),
    check('order_items_kind_check', sql`${t.kind} IN ('ITEM','MODIFIER')`),
    check('order_items_shape_check', sql`(${t.kind} = 'ITEM' AND ${t.parentItemId} IS NULL AND ${t.modifierOptionId} IS NULL AND ${t.variantId} IS NOT NULL)
      OR (${t.kind} = 'MODIFIER' AND ${t.parentItemId} IS NOT NULL AND ${t.modifierOptionId} IS NOT NULL)`),
    check('order_items_status_check', sql`${t.status} IN ('PENDING','FIRED','IN_PREP','READY','SERVED','VOIDED')`),
    check('order_items_quantity_check', sql`${t.quantity} > 0`),
    check('order_items_course_check', sql`${t.course} BETWEEN 1 AND 9`),
    check('order_items_seat_check', sql`${t.seat} IS NULL OR ${t.seat} BETWEEN 1 AND 500`),
    check('order_items_fired_check', sql`(${t.status} = 'PENDING') = (${t.firedAt} IS NULL)`),
    check('order_items_void_check', sql`(${t.status} = 'VOIDED') = (${t.voidedAt} IS NOT NULL) AND (${t.voidedAt} IS NULL OR length(trim(coalesce(${t.voidReason}, ''))) > 0)`),
    check('order_items_station_check', sql`${t.stationCode} IS NULL OR ${t.stationCode} ~ ${sql.raw(STATION_CODE)}`),
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

// ------------------------------------------------------------------ bills (ADR-0014 §8)

/**
 * The frozen price of an order: computed once by the tax path (`TaxService.computeCart`) over the
 * order's live items and stored verbatim. ACTIVE → SETTLED (every line fully paid in checks) or
 * VOIDED (reopened before any check). Checks are sales whose lines are exact shares of these lines.
 * Header buckets include the charges (service charge), so amount_due is what the table pays.
 */
export const orderBills = pgTable(
  'order_bills',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    orderId: uuid('order_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    billNumber: bigint('bill_number', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    currency: char('currency', { length: 3 }).notNull(),
    taxProfileId: uuid('tax_profile_id').notNull(),
    taxSnapshot: jsonb('tax_snapshot').notNull(),
    /** Order-level discount spread over the non-statutory lines (e.g. "0.1"), if any. */
    discountRate: numeric('discount_rate', { precision: 9, scale: 6 }),
    requiresProfessionalReview: boolean('requires_professional_review').notNull(),
    ...buckets(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedBy: uuid('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    unique('order_bills_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('order_bills_number_unique').on(t.tenantId, t.branchId, t.billNumber),
    foreignKey({ columns: [t.tenantId, t.branchId, t.orderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.branchId, restaurantOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.taxProfileId], foreignColumns: [taxProfiles.tenantId, taxProfiles.id] }),
    uniqueIndex('order_bills_one_active').on(t.tenantId, t.orderId).where(sql`${t.status} = 'ACTIVE'`),
    check('order_bills_status_check', sql`${t.status} IN ('ACTIVE','SETTLED','VOIDED')`),
    check('order_bills_void_check', sql`(${t.status} = 'VOIDED') = (${t.voidedAt} IS NOT NULL) AND (${t.voidedAt} IS NULL OR length(trim(coalesce(${t.voidReason}, ''))) > 0)`),
    check('order_bills_buckets_check', sql`${t.amountDue} = ${t.vatableSales} + ${t.vatAmount} + ${t.vatExemptSales} + ${t.zeroRatedSales} + ${t.percentageTaxSales} - ${t.statutoryDiscount}`),
  ],
);

/** SC/PWD diners on a bill — minimised (name + ID number), copied to each check that uses them. */
export const orderBillBeneficiaries = pgTable(
  'order_bill_beneficiaries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    orderBillId: uuid('order_bill_id').notNull(),
    schemeCode: text('scheme_code').notNull(),
    schemeVersion: integer('scheme_version').notNull(),
    name: text('name').notNull(),
    idNumber: text('id_number').notNull(),
    tin: text('tin'),
  },
  (t) => [
    unique('order_bill_beneficiaries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.orderBillId], foreignColumns: [orderBills.tenantId, orderBills.id] }),
    check('order_bill_beneficiaries_name_check', sql`length(trim(${t.name})) > 0 AND length(trim(${t.idNumber})) > 0`),
  ],
);

/** A priced line of the bill: an order item or a priced modifier of one (child line). */
export const orderBillLines = pgTable(
  'order_bill_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    orderBillId: uuid('order_bill_id').notNull(),
    lineNo: integer('line_no').notNull(),
    parentLineId: uuid('parent_line_id'),
    orderItemId: uuid('order_item_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    taxCategoryCode: text('tax_category_code').notNull(),
    vatTreatment: text('vat_treatment').notNull(),
    quantity: qty('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    priceIncludesTax: boolean('price_includes_tax').notNull(),
    priceId: uuid('price_id').notNull(),
    priceListId: uuid('price_list_id').notNull(),
    trackInventory: boolean('track_inventory').notNull(),
    ...buckets(),
    beneficiaryId: uuid('beneficiary_id'),
    schemeShare: numeric('scheme_share', { precision: 9, scale: 6 }),
    taxSnapshot: jsonb('tax_snapshot').notNull(),
  },
  (t) => [
    unique('order_bill_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('order_bill_lines_bill_id_unique').on(t.tenantId, t.orderBillId, t.id),
    unique('order_bill_lines_number_unique').on(t.tenantId, t.orderBillId, t.lineNo),
    foreignKey({ columns: [t.tenantId, t.orderBillId], foreignColumns: [orderBills.tenantId, orderBills.id] }),
    foreignKey({ columns: [t.tenantId, t.orderBillId, t.parentLineId], foreignColumns: [t.tenantId, t.orderBillId, t.id] }),
    foreignKey({ columns: [t.tenantId, t.orderItemId], foreignColumns: [orderItems.tenantId, orderItems.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.priceId], foreignColumns: [productPrices.tenantId, productPrices.id] }),
    foreignKey({ columns: [t.tenantId, t.beneficiaryId], foreignColumns: [orderBillBeneficiaries.tenantId, orderBillBeneficiaries.id] }),
    check('order_bill_lines_quantity_check', sql`${t.quantity} > 0`),
    check('order_bill_lines_beneficiary_share', sql`(${t.beneficiaryId} IS NULL) = (${t.schemeShare} IS NULL)`),
  ],
);

/** A charge on the bill (service charge, RA 11360): never part of item prices; owed to staff. */
export const orderBillCharges = pgTable(
  'order_bill_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    orderBillId: uuid('order_bill_id').notNull(),
    kind: text('kind').notNull(),
    /** Items net of discounts, ex VAT (tax adviser to confirm). */
    base: money('base').notNull(),
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    vatTreatment: text('vat_treatment').notNull(),
    ...buckets(),
    taxSnapshot: jsonb('tax_snapshot').notNull(),
  },
  (t) => [
    unique('order_bill_charges_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('order_bill_charges_kind_unique').on(t.tenantId, t.orderBillId, t.kind),
    foreignKey({ columns: [t.tenantId, t.orderBillId], foreignColumns: [orderBills.tenantId, orderBills.id] }),
    check('order_bill_charges_kind_check', sql`${t.kind} IN ('SERVICE_CHARGE')`),
    check('order_bill_charges_amount_check', sql`${t.amountDue} > 0 AND ${t.rate} > 0`),
  ],
);

/**
 * A note for one course of an order ("hold until the cake is out", "birthday: bring with a candle").
 * Live while the order is open; each ticket fired for the course copies it (`course_note`).
 */
export const orderCourseNotes = pgTable(
  'order_course_notes',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    orderId: uuid('order_id').notNull(),
    course: integer('course').notNull(),
    note: text('note').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.orderId, t.course] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.orderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.branchId, restaurantOrders.id] }),
    check('order_course_notes_course_check', sql`${t.course} BETWEEN 1 AND 9`),
    check('order_course_notes_note_check', sql`length(trim(${t.note})) BETWEEN 1 AND 200`),
  ],
);

/**
 * Where an item was before a move or merge (append-only, written by a trigger), so reports can
 * place items on the order they were on at a past moment.
 */
export const orderItemMoves = pgTable(
  'order_item_moves',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    itemId: uuid('item_id').notNull(),
    fromOrderId: uuid('from_order_id').notNull(),
    toOrderId: uuid('to_order_id').notNull(),
    movedAt: timestamp('moved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('order_item_moves_tenant_id_id_unique').on(t.tenantId, t.id),
    // No FK to the item: a pending item may be removed after a move, and its history stays.
    foreignKey({ columns: [t.tenantId, t.fromOrderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.toOrderId], foreignColumns: [restaurantOrders.tenantId, restaurantOrders.id] }),
    index('order_item_moves_item_idx').on(t.tenantId, t.itemId, t.movedAt),
  ],
);
