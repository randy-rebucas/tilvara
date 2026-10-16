import { sql } from 'drizzle-orm';
import { bigint, char, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { branches } from './organization.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

// ------------------------------------------------------------------ suppliers (master data)

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    tin: text('tin'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(0),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('suppliers_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('suppliers_code_active_unique').on(t.tenantId, sql`lower(${t.code})`).where(sql`${t.archivedAt} IS NULL`),
    check('suppliers_name_check', sql`length(trim(${t.name})) > 0`),
    check('suppliers_terms_check', sql`${t.paymentTermsDays} BETWEEN 0 AND 365`),
  ],
);

// ------------------------------------------------------------------ purchase orders

/** DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED; DRAFT/APPROVED → CANCELLED (trigger-enforced). */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    poNumber: bigint('po_number', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('DRAFT'),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    expectedOn: date('expected_on'),
    supplierRef: text('supplier_ref'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    endedBy: uuid('ended_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('purchase_orders_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('purchase_orders_number_unique').on(t.tenantId, t.branchId, t.poNumber),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    index('purchase_orders_branch_idx').on(t.tenantId, t.branchId, t.status),
    check('purchase_orders_status_check', sql`${t.status} IN ('DRAFT','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')`),
  ],
);

/** Editable only while the order is DRAFT (trigger-enforced). */
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    unitCost: money('unit_cost').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('purchase_order_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('purchase_order_lines_line_unique').on(t.tenantId, t.purchaseOrderId, t.lineNo),
    foreignKey({ columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('purchase_order_lines_quantity_check', sql`${t.quantity} > 0`),
    check('purchase_order_lines_cost_check', sql`${t.unitCost} >= 0`),
  ],
);

// ------------------------------------------------------------------ goods receipts (evidence, append-only)

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    receiptNumber: bigint('receipt_number', { mode: 'number' }).notNull(),
    supplierInvoiceRef: text('supplier_invoice_ref'),
    supplierDeliveryRef: text('supplier_delivery_ref'),
    notes: text('notes'),
    receivedBy: uuid('received_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('goods_receipts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('goods_receipts_number_unique').on(t.tenantId, t.branchId, t.receiptNumber),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }),
    index('goods_receipts_po_idx').on(t.tenantId, t.purchaseOrderId),
  ],
);

/** Accepted quantity goes into stock at `unit_cost`; rejected quantity is recorded, never stocked. */
export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    purchaseOrderLineId: uuid('purchase_order_line_id'),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    rejectedQuantity: qty('rejected_quantity').notNull().default('0'),
    rejectionReason: text('rejection_reason'),
    unitCost: money('unit_cost').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('goods_receipt_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.goodsReceiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    foreignKey({ columns: [t.tenantId, t.purchaseOrderLineId], foreignColumns: [purchaseOrderLines.tenantId, purchaseOrderLines.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    index('goods_receipt_lines_po_line_idx').on(t.tenantId, t.purchaseOrderLineId),
    check('goods_receipt_lines_quantity_check', sql`${t.quantity} >= 0 AND ${t.rejectedQuantity} >= 0 AND ${t.quantity} + ${t.rejectedQuantity} > 0`),
    check('goods_receipt_lines_rejection_check', sql`${t.rejectedQuantity} = 0 OR length(trim(coalesce(${t.rejectionReason}, ''))) > 0`),
    check('goods_receipt_lines_cost_check', sql`${t.unitCost} >= 0`),
  ],
);

// ------------------------------------------------------------------ supplier returns (evidence, append-only)

export const supplierReturns = pgTable(
  'supplier_returns',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    goodsReceiptId: uuid('goods_receipt_id'),
    returnNumber: bigint('return_number', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_returns_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_returns_number_unique').on(t.tenantId, t.branchId, t.returnNumber),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ columns: [t.tenantId, t.goodsReceiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    check('supplier_returns_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
);

/** Stock leaves at the average (ADR-0012 §5); `credit_unit_cost` is what the supplier owes back. */
export const supplierReturnLines = pgTable(
  'supplier_return_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    supplierReturnId: uuid('supplier_return_id').notNull(),
    goodsReceiptLineId: uuid('goods_receipt_line_id'),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    creditUnitCost: money('credit_unit_cost').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_return_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.supplierReturnId], foreignColumns: [supplierReturns.tenantId, supplierReturns.id] }),
    foreignKey({ columns: [t.tenantId, t.goodsReceiptLineId], foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('supplier_return_lines_quantity_check', sql`${t.quantity} > 0`),
    check('supplier_return_lines_cost_check', sql`${t.creditUnitCost} >= 0`),
  ],
);
