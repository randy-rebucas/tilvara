import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, numeric, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { branches } from './organization.js';

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
