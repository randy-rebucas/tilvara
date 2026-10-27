import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { branches } from './organization.js';
import { tenants } from './platform.js';
import { customers } from './customers.js';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

// ------------------------------------------------------------------ transfers between branches

/** DISPATCHED (stock left the source, in transit) → RECEIVED (once). */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    fromBranchId: uuid('from_branch_id').notNull(),
    toBranchId: uuid('to_branch_id').notNull(),
    transferNumber: bigint('transfer_number', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('DISPATCHED'),
    notes: text('notes'),
    dispatchedBy: uuid('dispatched_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    receivedBy: uuid('received_by'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receiveNotes: text('receive_notes'),
  },
  (t) => [
    unique('stock_transfers_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_transfers_number_unique').on(t.tenantId, t.fromBranchId, t.transferNumber),
    foreignKey({ columns: [t.tenantId, t.fromBranchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.toBranchId], foreignColumns: [branches.tenantId, branches.id] }),
    index('stock_transfers_to_idx').on(t.tenantId, t.toBranchId, t.status),
    check('stock_transfers_branches_check', sql`${t.fromBranchId} <> ${t.toBranchId}`),
    check('stock_transfers_status_check', sql`${t.status} IN ('DISPATCHED','RECEIVED')`),
  ],
);

/** Sent quantity is fixed at dispatch; the received quantity is written once, at receipt (trigger-enforced). */
export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    stockTransferId: uuid('stock_transfer_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    receivedQuantity: qty('received_quantity'),
    discrepancyReason: text('discrepancy_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_transfer_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_transfer_lines_variant_unique').on(t.tenantId, t.stockTransferId, t.variantId),
    foreignKey({ columns: [t.tenantId, t.stockTransferId], foreignColumns: [stockTransfers.tenantId, stockTransfers.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('stock_transfer_lines_quantity_check', sql`${t.quantity} > 0`),
    check(
      'stock_transfer_lines_received_check',
      sql`${t.receivedQuantity} IS NULL OR (${t.receivedQuantity} >= 0 AND ${t.receivedQuantity} <= ${t.quantity} AND (${t.receivedQuantity} = ${t.quantity} OR length(trim(coalesce(${t.discrepancyReason}, ''))) > 0))`,
    ),
  ],
);

// ------------------------------------------------------------------ stock counts

/** A posted count; each line's variance movement is computed by the ledger trigger at posting time. */
export const stockCounts = pgTable(
  'stock_counts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    countNumber: bigint('count_number', { mode: 'number' }).notNull(),
    notes: text('notes'),
    countedBy: uuid('counted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_counts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_counts_number_unique').on(t.tenantId, t.branchId, t.countNumber),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    stockCountId: uuid('stock_count_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    countedQuantity: qty('counted_quantity').notNull(),
    /**
     * Only for a count posted from a count sheet: on hand when the sheet was frozen. The trigger then
     * moves counted − expected (stock moved since the freeze stays); without it, counted − on hand now.
     */
    expectedQuantity: qty('expected_quantity'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_count_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_count_lines_variant_unique').on(t.tenantId, t.stockCountId, t.variantId),
    foreignKey({ columns: [t.tenantId, t.stockCountId], foreignColumns: [stockCounts.tenantId, stockCounts.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('stock_count_lines_quantity_check', sql`${t.countedQuantity} >= 0`),
  ],
);

// ------------------------------------------------------------------ count sheets (blind counts)

export const COUNT_SHEET_STATUSES = ['OPEN', 'POSTED', 'CANCELLED'] as const;
export type CountSheetStatus = (typeof COUNT_SHEET_STATUSES)[number];

/**
 * A count in progress: on-hand quantities are frozen when it opens, people enter what they find
 * (blind: without seeing the frozen quantity unless they may adjust stock), and a manager posts it
 * later as a stock count whose variance is counted − frozen. OPEN → POSTED | CANCELLED, once.
 */
export const stockCountSheets = pgTable(
  'stock_count_sheets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    blind: boolean('blind').notNull().default(true),
    status: text('status').$type<CountSheetStatus>().notNull().default('OPEN'),
    notes: text('notes'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(),
    stockCountId: uuid('stock_count_id'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('stock_count_sheets_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_count_sheets_count_unique').on(t.tenantId, t.stockCountId),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.stockCountId], foreignColumns: [stockCounts.tenantId, stockCounts.id] }),
    check('stock_count_sheets_status_check', sql`${t.status} IN ('OPEN','POSTED','CANCELLED')`),
    check(
      'stock_count_sheets_close_check',
      sql`(${t.status} = 'OPEN') = (${t.closedAt} IS NULL) AND (${t.status} = 'POSTED') = (${t.stockCountId} IS NOT NULL)
          AND (${t.status} <> 'CANCELLED' OR length(trim(${t.cancelReason})) > 0)`,
    ),
    index('stock_count_sheets_branch_idx').on(t.tenantId, t.branchId, t.frozenAt),
  ],
);

export const stockCountSheetLines = pgTable(
  'stock_count_sheet_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    sheetId: uuid('sheet_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    expectedQuantity: qty('expected_quantity').notNull(),
    countedQuantity: qty('counted_quantity'),
    countedBy: uuid('counted_by'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    /**
     * The balance's `movement_seq` when this line was frozen (audit 45 #7): movements with a higher
     * `balance_seq` were not in `expected_quantity`. NULL on lines frozen before migration 0134.
     */
    frozenSeq: bigint('frozen_seq', { mode: 'number' }),
  },
  (t) => [
    unique('stock_count_sheet_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('stock_count_sheet_lines_variant_unique').on(t.tenantId, t.sheetId, t.variantId),
    foreignKey({ columns: [t.tenantId, t.sheetId], foreignColumns: [stockCountSheets.tenantId, stockCountSheets.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('stock_count_sheet_lines_counted_check', sql`${t.countedQuantity} IS NULL OR ${t.countedQuantity} >= 0`),
    check('stock_count_sheet_lines_by_check', sql`(${t.countedQuantity} IS NULL) = (${t.countedBy} IS NULL) AND (${t.countedBy} IS NULL) = (${t.countedAt} IS NULL)`),
  ],
);

// ------------------------------------------------------------------ inventory settings

export const NEGATIVE_STOCK_POLICIES = ['ALLOW', 'ALLOW_WITH_FLAG', 'BLOCK'] as const;
export type NegativeStockPolicy = (typeof NEGATIVE_STOCK_POLICIES)[number];

/**
 * Per branch (a missing row = the defaults). Negative stock: ALLOW (sell below zero, visible on the
 * balance), ALLOW_WITH_FLAG (also mark it and alert), BLOCK (a counter sale that would go below zero
 * is refused; offline sales cannot be refused, so they are flagged).
 */
export const inventorySettings = pgTable(
  'inventory_settings',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    negativeStockPolicy: text('negative_stock_policy').$type<NegativeStockPolicy>().notNull().default('ALLOW'),
    lowStockAlerts: boolean('low_stock_alerts').notNull().default(true),
    /** Mail the stock keepers about lots expiring within this many days (0: no mail). ADR-0020 §3. */
    expiryAlertDays: integer('expiry_alert_days').notNull().default(30),
    /** Expired or held lots may be sold (ALLOW) or not (BLOCK); null = ALLOW (ADR-0025 §4; 0112 wrote BLOCK for former pharmacies). */
    expiredStock: text('expired_stock'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check('inventory_settings_policy_check', sql`${t.negativeStockPolicy} IN ('ALLOW','ALLOW_WITH_FLAG','BLOCK')`),
    check('inventory_settings_expiry_days_check', sql`${t.expiryAlertDays} BETWEEN 0 AND 365`),
    check('inventory_settings_expired_stock_check', sql`${t.expiredStock} IS NULL OR ${t.expiredStock} IN ('ALLOW','BLOCK')`),
  ],
);

// ------------------------------------------------------------------ stock adjustments

/**
 * One adjustment or waste document: its movements point here and its journal entry's source is
 * this id, so every movement traces to its entry and back (Phase 3 exit review).
 */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_adjustments_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check('stock_adjustments_kind_check', sql`${t.kind} IN ('ADJUSTMENT','WASTE')`),
    check('stock_adjustments_reason_check', sql`length(trim(${t.reason})) > 0`),
    index('stock_adjustments_branch_idx').on(t.tenantId, t.branchId, t.createdAt),
  ],
);

// ------------------------------------------------------------------ reorder points

/** Per branch and item: alert at or below `reorder_point`; suggest ordering `reorder_quantity`. */
export const reorderPoints = pgTable(
  'reorder_points',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    reorderPoint: qty('reorder_point').notNull(),
    reorderQuantity: qty('reorder_quantity'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('reorder_points_check', sql`${t.reorderPoint} >= 0 AND (${t.reorderQuantity} IS NULL OR ${t.reorderQuantity} > 0)`),
  ],
);

// ------------------------------------------------------------------ shelf locations (ADR-0021 §5)

/** Where an item sits in a branch ("A3-2"): a label for counts and labels, not stock. */
export const itemLocations = pgTable(
  'item_locations',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    location: text('location').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('item_locations_location_check', sql`length(btrim(${t.location})) BETWEEN 1 AND 32`),
  ],
);

// ------------------------------------------------------------------ reservations (session 20, SPEC §10)

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Stock set aside at a branch (a customer's order, a layaway, a display piece) so it is not sold to
 * someone else: available = on hand − active reservations. It moves no stock and posts nothing; the
 * goods leave with their sale as usual. ACTIVE → RELEASED once (sold, collected or cancelled), or it
 * stops counting at `expires_at`.
 */
export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    note: text('note').notNull(),
    customerId: uuid('customer_id'),
    status: text('status').$type<ReservationStatus>().notNull().default('ACTIVE'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid('released_by'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    unique('stock_reservations_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('stock_reservations_active_idx').on(t.tenantId, t.branchId, t.variantId).where(sql`${t.status} = 'ACTIVE'`),
    check('stock_reservations_quantity_positive', sql`${t.quantity} > 0`),
    check('stock_reservations_note_check', sql`length(trim(${t.note})) BETWEEN 1 AND 200`),
    check('stock_reservations_status_check', sql`${t.status} IN ('ACTIVE','RELEASED')`),
    check('stock_reservations_released_check', sql`(${t.status} = 'RELEASED') = (${t.releasedAt} IS NOT NULL) AND (${t.releasedAt} IS NULL) = (${t.releasedBy} IS NULL) AND (${t.releasedAt} IS NULL) = (${t.releaseReason} IS NULL)`),
    check('stock_reservations_expiry_check', sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.createdAt}`),
  ],
);

// ------------------------------------------------------------------ lot holds (ADR-0025 §5, kept for every shop in 0112)

/**
 * A batch kept off sale (a recall, an FDA advisory) at one branch or all. Held lots are not sellable where
 * expired stock is blocked; they are written off or returned as usual. Released, never deleted.
 */
export const lotHolds = pgTable(
  'lot_holds',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    variantId: uuid('variant_id').notNull(),
    lotCode: text('lot_code').notNull(),
    /** Null: every branch. */
    branchId: uuid('branch_id'),
    reason: text('reason').notNull(),
    reference: text('reference'),
    placedBy: uuid('placed_by').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid('released_by'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    unique('lot_holds_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    uniqueIndex('lot_holds_open_once')
      .on(t.tenantId, t.variantId, sql`upper(btrim(${t.lotCode}))`, sql`coalesce(${t.branchId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.releasedAt} IS NULL`),
    check('lot_holds_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 200 AND length(btrim(${t.lotCode})) BETWEEN 1 AND 64`),
    check('lot_holds_release_check', sql`(${t.releasedAt} IS NULL) = (${t.releasedBy} IS NULL) AND (${t.releasedAt} IS NULL OR length(btrim(coalesce(${t.releaseReason}, ''))) > 0)`),
  ],
);
