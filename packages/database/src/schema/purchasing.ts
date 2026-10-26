import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { branches, legalEntities } from './organization.js';

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

// ------------------------------------------------------------------ supplier catalog (session 20)

/**
 * What a supplier calls an item and what it costs from them: their SKU and name, the last agreed unit
 * cost (ex VAT, like receipts), and whether they are the preferred supplier for it (one per item).
 * Purchase orders take the cost from here when a line gives none, and show the supplier's SKU.
 */
export const supplierItems = pgTable(
  'supplier_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    supplierSku: text('supplier_sku'),
    supplierItemName: text('supplier_item_name'),
    unitCost: money('unit_cost'),
    preferred: boolean('preferred').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('supplier_items_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    uniqueIndex('supplier_items_active_unique').on(t.tenantId, t.supplierId, t.variantId).where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('supplier_items_one_preferred').on(t.tenantId, t.variantId).where(sql`${t.preferred} AND ${t.archivedAt} IS NULL`),
    index('supplier_items_variant_idx').on(t.tenantId, t.variantId),
    check('supplier_items_cost_check', sql`${t.unitCost} IS NULL OR ${t.unitCost} >= 0`),
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
    /** Expiry date and lot of what came in (ADR-0020 §3); required for an item that tracks expiry. */
    expiresOn: date('expires_on'),
    lotCode: text('lot_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('goods_receipt_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    check('goods_receipt_lines_lot_needs_date', sql`${t.lotCode} IS NULL OR ${t.expiresOn} IS NOT NULL`),
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

// ------------------------------------------------------------------ supplier invoices and payments (session 16)

/**
 * A supplier's invoice for whole goods receipts of one branch: clears their GRNI, claims input VAT
 * and opens a payable (ADR-0013 amendment). OPEN → CANCELLED only (trigger), and only while unpaid.
 */
export const supplierInvoices = pgTable(
  'supplier_invoices',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    entryNumber: bigint('entry_number', { mode: 'number' }).notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    invoiceDate: date('invoice_date').notNull(),
    dueDate: date('due_date').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    netAmount: money('net_amount').notNull(),
    vatAmount: money('vat_amount').notNull(),
    totalAmount: money('total_amount').notNull(),
    /** GRNI cleared: the receipts at cost less returns against them before invoicing. */
    matchedAmount: money('matched_amount').notNull(),
    inputVat: money('input_vat').notNull(),
    status: text('status').notNull().default('OPEN'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('supplier_invoices_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_invoices_number_unique').on(t.tenantId, t.legalEntityId, t.entryNumber),
    uniqueIndex('supplier_invoices_supplier_ref_unique').on(t.tenantId, t.supplierId, sql`lower(${t.invoiceNumber})`).where(sql`${t.status} = 'OPEN'`),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    index('supplier_invoices_supplier_idx').on(t.tenantId, t.supplierId, t.status),
    index('supplier_invoices_due_idx').on(t.tenantId, t.legalEntityId, t.dueDate),
    check('supplier_invoices_status_check', sql`${t.status} IN ('OPEN','CANCELLED')`),
    check('supplier_invoices_number_check', sql`length(trim(${t.invoiceNumber})) > 0`),
    check('supplier_invoices_amounts_check', sql`${t.netAmount} >= 0 AND ${t.vatAmount} >= 0 AND ${t.totalAmount} = ${t.netAmount} + ${t.vatAmount} AND ${t.inputVat} IN (0, ${t.vatAmount}) AND ${t.matchedAmount} >= 0`),
    check('supplier_invoices_due_check', sql`${t.dueDate} >= ${t.invoiceDate}`),
    check('supplier_invoices_cancel_check', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL) AND (${t.status} = 'OPEN' OR length(trim(coalesce(${t.cancelReason}, ''))) > 0)`),
  ],
);

/** The receipts an invoice covers. A receipt is on at most one open invoice; `active` only goes true → false (cancel). */
export const supplierInvoiceReceipts = pgTable(
  'supplier_invoice_receipts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id').notNull(),
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    matchedAmount: money('matched_amount').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_invoice_receipts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_invoice_receipts_pair_unique').on(t.tenantId, t.supplierInvoiceId, t.goodsReceiptId),
    uniqueIndex('supplier_invoice_receipts_active_unique').on(t.tenantId, t.goodsReceiptId).where(sql`${t.active}`),
    foreignKey({ columns: [t.tenantId, t.supplierInvoiceId], foreignColumns: [supplierInvoices.tenantId, supplierInvoices.id] }),
    foreignKey({ columns: [t.tenantId, t.goodsReceiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
  ],
);

/**
 * A payment to one supplier from the bank, spread over one or more of its open invoices of one legal
 * entity (`supplier_payment_allocations`, session 22). Evidence: nothing changes after insert except a
 * void, once (trigger), which a reversal of its entry accompanies. `supplier_invoice_id` is the single
 * invoice of a one-invoice payment (every payment before session 22), null when it pays several.
 */
export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id'),
    paymentNumber: bigint('payment_number', { mode: 'number' }).notNull(),
    amount: money('amount').notNull(),
    paidOn: date('paid_on').notNull(),
    method: text('method').notNull(),
    reference: text('reference'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedBy: uuid('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
  },
  (t) => [
    unique('supplier_payments_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_payments_number_unique').on(t.tenantId, t.legalEntityId, t.paymentNumber),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierInvoiceId], foreignColumns: [supplierInvoices.tenantId, supplierInvoices.id] }),
    index('supplier_payments_invoice_idx').on(t.tenantId, t.supplierInvoiceId),
    index('supplier_payments_supplier_idx').on(t.tenantId, t.supplierId),
    check('supplier_payments_amount_check', sql`${t.amount} > 0`),
    // CASH_DRAWER (0120): cash taken from a till's drawer; its cash_movements row names this payment.
    check('supplier_payments_method_check', sql`${t.method} IN ('BANK_TRANSFER','CHECK','OTHER','CASH_DRAWER')`),
    check('supplier_payments_void_check', sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL) AND (${t.voidReason} IS NULL OR length(trim(${t.voidReason})) > 0)`),
  ],
);

/** Append-only. How much of a payment settles each invoice; Σ = the payment's amount (service, same transaction). */
export const supplierPaymentAllocations = pgTable(
  'supplier_payment_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    supplierPaymentId: uuid('supplier_payment_id').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id').notNull(),
    amount: money('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_payment_allocations_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_payment_allocations_pair_unique').on(t.tenantId, t.supplierPaymentId, t.supplierInvoiceId),
    foreignKey({ columns: [t.tenantId, t.supplierPaymentId], foreignColumns: [supplierPayments.tenantId, supplierPayments.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierInvoiceId], foreignColumns: [supplierInvoices.tenantId, supplierInvoices.id] }),
    index('supplier_payment_allocations_invoice_idx').on(t.tenantId, t.supplierInvoiceId),
    check('supplier_payment_allocations_amount_check', sql`${t.amount} > 0`),
  ],
);

/**
 * Append-only. A supplier's credit note (what is owed goes down: a return after invoicing, an
 * allowance) or debit note (it goes up: an undercharge, a charge left off) against one invoice
 * (session 22, ADR-0013 amendment). A credit note clears the GRNI that returns after invoicing left
 * (`grni_cleared`); the rest of either kind, net of claimable VAT, is a purchase price variance.
 */
export const supplierNotes = pgTable(
  'supplier_notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id').notNull(),
    kind: text('kind').notNull(),
    entryNumber: bigint('entry_number', { mode: 'number' }).notNull(),
    /** The supplier's own number on the note. */
    noteNumber: text('note_number').notNull(),
    noteDate: date('note_date').notNull(),
    netAmount: money('net_amount').notNull(),
    vatAmount: money('vat_amount').notNull(),
    totalAmount: money('total_amount').notNull(),
    inputVat: money('input_vat').notNull(),
    grniCleared: money('grni_cleared').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('supplier_notes_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('supplier_notes_number_unique').on(t.tenantId, t.legalEntityId, t.entryNumber),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierInvoiceId], foreignColumns: [supplierInvoices.tenantId, supplierInvoices.id] }),
    index('supplier_notes_invoice_idx').on(t.tenantId, t.supplierInvoiceId),
    check('supplier_notes_kind_check', sql`${t.kind} IN ('CREDIT','DEBIT')`),
    check('supplier_notes_text_check', sql`length(trim(${t.noteNumber})) > 0 AND length(trim(${t.reason})) > 0`),
    check('supplier_notes_amounts_check', sql`${t.netAmount} >= 0 AND ${t.vatAmount} >= 0 AND ${t.totalAmount} = ${t.netAmount} + ${t.vatAmount} AND ${t.totalAmount} > 0 AND ${t.inputVat} IN (0, ${t.vatAmount}) AND ${t.grniCleared} >= 0 AND (${t.kind} = 'CREDIT' OR ${t.grniCleared} = 0) AND ${t.grniCleared} <= ${t.totalAmount} - ${t.inputVat}`),
  ],
);
