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
import { productPrices, productVariants } from './catalog.js';
import { orderBillCharges, orderBillLines, orderBills, recipeVersions } from './restaurant.js';
import { stockAdjustments, stockCountLines, stockTransferLines } from './inventory.js';
import { goodsReceiptLines, supplierReturnLines } from './purchasing.js';
import { branches, legalEntities, registers, terminals } from './organization.js';
import { tenants } from './platform.js';
import { taxProfiles } from './tax.js';
import { customers } from './customers.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

// ------------------------------------------------------------------ cash

export const CASHIER_SESSION_STATUSES = ['OPEN', 'CLOSED', 'RECONCILED'] as const;
export type CashierSessionStatus = (typeof CASHIER_SESSION_STATUSES)[number];

/**
 * A cashier's shift on one register. OPEN → CLOSED (counted, variance awaiting approval) →
 * RECONCILED; transitions are enforced by trigger and at most one session per register is OPEN.
 */
export const cashierSessions = pgTable(
  'cashier_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    openedBy: uuid('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openingFloat: money('opening_float').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    status: text('status').$type<CashierSessionStatus>().notNull().default('OPEN'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    unique('cashier_sessions_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    uniqueIndex('cashier_sessions_one_open_per_register').on(t.tenantId, t.registerId).where(sql`${t.status} = 'OPEN'`),
    index('cashier_sessions_register_idx').on(t.tenantId, t.registerId, t.openedAt.desc()),
    // Monitoring (ADR-0016): shifts closed with a variance that waits for approval, across tenants.
    index('cashier_sessions_awaiting_idx').on(t.closedAt).where(sql`${t.status} = 'CLOSED'`),
    check('cashier_sessions_status_check', sql`${t.status} IN ('OPEN','CLOSED','RECONCILED')`),
    check('cashier_sessions_float_check', sql`${t.openingFloat} >= 0`),
    check('cashier_sessions_closed_check', sql`(${t.status} = 'OPEN') = (${t.closedAt} IS NULL)`),
  ],
);

export const CASH_MOVEMENT_TYPES = ['OPENING_FLOAT', 'SALE', 'PAY_IN', 'PAY_OUT', 'REFUND'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

/** Append-only drawer ledger; expected cash = Σ amount (signed: + into the drawer). */
export const cashMovements = pgTable(
  'cash_movements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    type: text('type').$type<CashMovementType>().notNull(),
    amount: money('amount').notNull(),
    reason: text('reason'),
    saleId: uuid('sale_id'),
    saleReturnId: uuid('sale_return_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cash_movements_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    // Declared later in this file; resolved lazily.
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    index('cash_movements_session_idx').on(t.tenantId, t.cashierSessionId),
    check('cash_movements_type_check', sql`${t.type} IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND')`),
    check(
      'cash_movements_sign_check',
      sql`(${t.type} IN ('PAY_OUT','REFUND') AND ${t.amount} < 0) OR (${t.type} IN ('PAY_IN') AND ${t.amount} > 0) OR (${t.type} IN ('OPENING_FLOAT','SALE') AND ${t.amount} >= 0)`,
    ),
    check('cash_movements_refund_link', sql`(${t.type} = 'REFUND') = (${t.saleReturnId} IS NOT NULL)`),
    check('cash_movements_reason_check', sql`${t.type} NOT IN ('PAY_IN','PAY_OUT') OR length(trim(coalesce(${t.reason}, ''))) > 0`),
  ],
);

/** The count at close. Approval fields are written once by a different user (cash.reconcile). */
export const cashReconciliations = pgTable(
  'cash_reconciliations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    expectedCash: money('expected_cash').notNull(),
    countedCash: money('counted_cash').notNull(),
    variance: money('variance').notNull(),
    countedBy: uuid('counted_by').notNull(),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalNote: text('approval_note'),
  },
  (t) => [
    unique('cash_reconciliations_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('cash_reconciliations_session_unique').on(t.tenantId, t.cashierSessionId),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    check('cash_reconciliations_variance_check', sql`${t.variance} = ${t.countedCash} - ${t.expectedCash}`),
    check('cash_reconciliations_counted_check', sql`${t.countedCash} >= 0`),
    check('cash_reconciliations_approval_check', sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`),
    check('cash_reconciliations_not_self_approved', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.countedBy}`),
  ],
);

// ------------------------------------------------------------------ numbering

/**
 * Gapless counters (e.g. per-register sale numbers), incremented under a row lock inside the
 * same transaction as the document. Separate from invoice series, which stay disabled until the
 * compliance gate clears.
 */
export const sequenceCounters = pgTable(
  'sequence_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scopeId: uuid('scope_id').notNull(),
    name: text('name').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scopeId, t.name] }), check('sequence_counters_positive', sql`${t.nextValue} > 0`)],
);

// ------------------------------------------------------------------ sales

const taxBuckets = () => ({
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

/** A completed sale. Append-only: voids and returns are separate documents (later slices). */
export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    cashierUserId: uuid('cashier_user_id').notNull(),
    /** Terminal-generated id for this checkout; unique per register (offline-safe dedupe). */
    clientTransactionId: text('client_transaction_id').notNull(),
    saleNumber: bigint('sale_number', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('COMPLETED'),
    currency: char('currency', { length: 3 }).notNull(),
    taxProfileId: uuid('tax_profile_id').notNull(),
    ...taxBuckets(),
    amountTendered: money('amount_tendered').notNull(),
    changeDue: money('change_due').notNull(),
    requiresProfessionalReview: boolean('requires_professional_review').notNull(),
    /** Tax profile as used (ADR-0008 snapshot). */
    taxSnapshot: jsonb('tax_snapshot').notNull(),
    /** A restaurant check: the bill this sale pays part or all of (ADR-0014 §8). */
    orderBillId: uuid('order_bill_id'),
    /** OFFLINE: rung up on a terminal without a connection and recorded when it synced (ADR-0015). */
    origin: text('origin').notNull().default('ONLINE'),
    terminalId: uuid('terminal_id'),
    /** The reference the offline receipt printed, before the register number was assigned. */
    offlineReference: text('offline_reference'),
    /** Review flags from sync: PRICE_CHANGED, SNAPSHOT_EXPIRED, CLOCK_ADJUSTED. */
    offlineFlags: text('offline_flags').array().notNull().default(sql`'{}'::text[]`),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    /** The customer the sale was rung up for (session 20, ADR-0018), if any. */
    customerId: uuid('customer_id'),
  },
  (t) => [
    unique('sales_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('sales_customer_idx').on(t.tenantId, t.customerId, t.completedAt.desc()).where(sql`${t.customerId} IS NOT NULL`),
    foreignKey({ columns: [t.tenantId, t.orderBillId], foreignColumns: [orderBills.tenantId, orderBills.id] }),
    foreignKey({ columns: [t.tenantId, t.terminalId], foreignColumns: [terminals.tenantId, terminals.id] }),
    check('sales_origin_check', sql`(${t.origin} = 'ONLINE' AND ${t.terminalId} IS NULL AND ${t.offlineReference} IS NULL) OR (${t.origin} = 'OFFLINE' AND ${t.terminalId} IS NOT NULL AND ${t.offlineReference} IS NOT NULL)`),
    index('sales_bill_idx').on(t.tenantId, t.orderBillId),
    unique('sales_register_number_unique').on(t.tenantId, t.registerId, t.saleNumber),
    unique('sales_register_client_tx_unique').on(t.tenantId, t.registerId, t.clientTransactionId),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    foreignKey({ columns: [t.tenantId, t.taxProfileId], foreignColumns: [taxProfiles.tenantId, taxProfiles.id] }),
    index('sales_session_idx').on(t.tenantId, t.cashierSessionId),
    index('sales_branch_time_idx').on(t.tenantId, t.branchId, t.completedAt.desc()),
    check('sales_status_check', sql`${t.status} IN ('COMPLETED')`),
    check('sales_number_positive', sql`${t.saleNumber} > 0`),
    check('sales_due_non_negative', sql`${t.amountDue} >= 0`),
    check('sales_tender_covers', sql`${t.amountTendered} - ${t.changeDue} = ${t.amountDue} AND ${t.changeDue} >= 0`),
    check(
      'sales_buckets_check',
      sql`${t.amountDue} = ${t.vatableSales} + ${t.vatAmount} + ${t.vatExemptSales} + ${t.zeroRatedSales} + ${t.percentageTaxSales} - ${t.statutoryDiscount}`,
    ),
  ],
);

/** SC/PWD beneficiary per sale — minimised (name + ID number only, never disability type). */
export const saleBeneficiaries = pgTable(
  'sale_beneficiaries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    schemeCode: text('scheme_code').notNull(),
    schemeVersion: integer('scheme_version').notNull(),
    name: text('name').notNull(),
    idNumber: text('id_number').notNull(),
    tin: text('tin'),
  },
  (t) => [
    unique('sale_beneficiaries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    index('sale_beneficiaries_sale_idx').on(t.tenantId, t.saleId),
    check('sale_beneficiaries_name_check', sql`length(trim(${t.name})) > 0 AND length(trim(${t.idNumber})) > 0`),
  ],
);

export const saleLines = pgTable(
  'sale_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    lineNo: integer('line_no').notNull(),
    clientLineId: text('client_line_id').notNull(),
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
    ...taxBuckets(),
    beneficiaryId: uuid('beneficiary_id'),
    schemeShare: numeric('scheme_share', { precision: 9, scale: 6 }),
    /** Engine line snapshot (profile + scheme versions). */
    taxSnapshot: jsonb('tax_snapshot').notNull(),
    /** A priced modifier's line points to the line of the item it modifies (ADR-0014 §3). */
    parentLineId: uuid('parent_line_id'),
    /** The approved price change this line was sold at (session 20); `unit_price` is the approved price, `price_id` the list price it replaced. */
    priceOverrideId: uuid('price_override_id'),
  },
  (t) => [
    unique('sale_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.priceOverrideId], foreignColumns: [priceOverrides.tenantId, priceOverrides.id] }),
    // An approval prices one line of one sale.
    uniqueIndex('sale_lines_price_override_once').on(t.tenantId, t.priceOverrideId).where(sql`${t.priceOverrideId} IS NOT NULL`),
    unique('sale_lines_sale_id_unique').on(t.tenantId, t.saleId, t.id),
    foreignKey({ columns: [t.tenantId, t.saleId, t.parentLineId], foreignColumns: [t.tenantId, t.saleId, t.id] }),
    unique('sale_lines_number_unique').on(t.tenantId, t.saleId, t.lineNo),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.priceId], foreignColumns: [productPrices.tenantId, productPrices.id] }),
    foreignKey({ columns: [t.tenantId, t.beneficiaryId], foreignColumns: [saleBeneficiaries.tenantId, saleBeneficiaries.id] }),
    index('sale_lines_sale_idx').on(t.tenantId, t.saleId),
    check('sale_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('sale_lines_beneficiary_share', sql`(${t.beneficiaryId} IS NULL) = (${t.schemeShare} IS NULL)`),
  ],
);

// ------------------------------------------------------------------ counter controls (session 20)

/**
 * A manager-approved price for one item at one branch, asked for by a cashier. Append-only. The
 * approver either holds `sales.price_override` and asked themself, or signed in on the spot
 * (CREDENTIALS). Valid for 30 minutes; a sale line uses it once (`sale_lines_price_override_once`).
 */
export const priceOverrides = pgTable(
  'price_overrides',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    /** The list price in force when it was approved. */
    priceId: uuid('price_id').notNull(),
    listUnitPrice: money('list_unit_price').notNull(),
    unitPrice: money('unit_price').notNull(),
    /** The most the approved price may be sold for on its line (null: approved before 0084, no limit). */
    quantity: qty('quantity'),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    approvedBy: uuid('approved_by').notNull(),
    approvalMethod: text('approval_method').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('price_overrides_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.priceId], foreignColumns: [productPrices.tenantId, productPrices.id] }),
    index('price_overrides_branch_idx').on(t.tenantId, t.branchId, t.createdAt.desc()),
    check('price_overrides_price_check', sql`${t.unitPrice} >= 0 AND ${t.listUnitPrice} >= 0 AND ${t.unitPrice} <> ${t.listUnitPrice}`),
    check('price_overrides_quantity_check', sql`${t.quantity} IS NULL OR ${t.quantity} > 0`),
    check('price_overrides_reason_check', sql`length(trim(${t.reason})) > 0`),
    check('price_overrides_method_check', sql`${t.approvalMethod} IN ('SELF','CREDENTIALS')`),
    check('price_overrides_self_check', sql`(${t.approvalMethod} = 'SELF') = (${t.approvedBy} = ${t.requestedBy})`),
    check('price_overrides_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const HELD_CART_STATUSES = ['OPEN', 'RESUMED', 'DISCARDED'] as const;
export type HeldCartStatus = (typeof HELD_CART_STATUSES)[number];

/**
 * A cart parked at a register so the next customer can be served (SPEC §6.3 held carts). Not a
 * financial record: no price, tax or stock is fixed until it is resumed and checked out like any cart.
 * Resuming or discarding it clears `lines` and `beneficiaries` (SC/PWD names), so personal data does
 * not outlive the cart.
 */
export const heldCarts = pgTable(
  'held_carts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    heldBy: uuid('held_by').notNull(),
    label: text('label').notNull(),
    lines: jsonb('lines').notNull(),
    beneficiaries: jsonb('beneficiaries').notNull().default(sql`'[]'::jsonb`),
    lineCount: integer('line_count').notNull(),
    /** The total the cashier saw when parking it (for the list only; re-priced on resume). */
    amountDue: money('amount_due'),
    status: text('status').$type<HeldCartStatus>().notNull().default('OPEN'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('held_carts_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    index('held_carts_open_idx').on(t.tenantId, t.registerId, t.createdAt).where(sql`${t.status} = 'OPEN'`),
    check('held_carts_status_check', sql`${t.status} IN ('OPEN','RESUMED','DISCARDED')`),
    check('held_carts_closed_check', sql`(${t.status} = 'OPEN') = (${t.closedAt} IS NULL) AND (${t.closedAt} IS NULL) = (${t.closedBy} IS NULL)`),
    check('held_carts_label_check', sql`length(trim(${t.label})) BETWEEN 1 AND 60`),
    check('held_carts_line_count_check', sql`${t.lineCount} BETWEEN 1 AND 200`),
  ],
);

// ------------------------------------------------------------------ payments (ADR-0010)

export const PAYMENT_METHODS = ['CARD', 'QR', 'EWALLET'] as const;
export const PAYMENT_INTENT_STATUSES = ['PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELED'] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * A non-cash payment attempt, committed before the provider is called. The intent id is the
 * provider idempotency key; `request_key` is the client's Idempotency-Key.
 */
export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    clientTransactionId: text('client_transaction_id').notNull(),
    requestKey: uuid('request_key').notNull(),
    provider: text('provider').notNull(),
    method: text('method').notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status').$type<PaymentIntentStatus>().notNull().default('PROCESSING'),
    providerReference: text('provider_reference'),
    failureCode: text('failure_code'),
    saleId: uuid('sale_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_intents_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('payment_intents_request_key_unique').on(t.tenantId, t.requestKey),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    index('payment_intents_session_idx').on(t.tenantId, t.cashierSessionId, t.clientTransactionId),
    // Monitoring (ADR-0016): payments still waiting for the provider or for reconciliation.
    index('payment_intents_unresolved_idx').on(t.createdAt).where(sql`${t.status} IN ('PROCESSING','UNKNOWN')`),
    check('payment_intents_status_check', sql`${t.status} IN ('PROCESSING','SUCCEEDED','FAILED','UNKNOWN','CANCELED')`),
    check('payment_intents_method_check', sql`${t.method} IN ('CARD','QR','EWALLET')`),
    check('payment_intents_amount_positive', sql`${t.amount} > 0`),
    check('payment_intents_consumed_only_succeeded', sql`${t.saleId} IS NULL OR ${t.status} = 'SUCCEEDED'`),
  ],
);

/** Append-only payment evidence: every request, outcome and settlement (sanitized, never card data). */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    paymentIntentId: uuid('payment_intent_id').notNull(),
    type: text('type').notNull(),
    detail: jsonb('detail'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_events_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    index('payment_events_intent_idx').on(t.tenantId, t.paymentIntentId),
    check(
      'payment_events_type_check',
      sql`${t.type} IN ('AUTHORIZE_REQUESTED','AUTHORIZED','DECLINED','TIMEOUT','RECONCILED','CANCEL_REQUESTED','CANCELED','CONSUMED')`,
    ),
  ],
);

export const TENDER_METHODS = ['CASH', ...PAYMENT_METHODS, 'STORE_CREDIT'] as const;

export const saleTenders = pgTable(
  'sale_tenders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    method: text('method').notNull(),
    /** Set for non-cash tenders: the consumed payment intent. */
    paymentIntentId: uuid('payment_intent_id'),
    /** Applied to the sale. */
    amount: money('amount').notNull(),
    tendered: money('tendered').notNull(),
    change: money('change').notNull(),
    /**
     * An exchange (session 20): this cash tender is the refund of that return, put towards the new
     * sale instead of leaving the drawer. Both documents move cash as usual (REFUND out, SALE in), so
     * the drawer and the books net to what really changed hands.
     */
    exchangeReturnId: uuid('exchange_return_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sale_tenders_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.exchangeReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    uniqueIndex('sale_tenders_exchange_once').on(t.tenantId, t.exchangeReturnId).where(sql`${t.exchangeReturnId} IS NOT NULL`),
    check('sale_tenders_exchange_cash', sql`${t.exchangeReturnId} IS NULL OR ${t.method} = 'CASH'`),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    index('sale_tenders_sale_idx').on(t.tenantId, t.saleId),
    check('sale_tenders_method_check', sql`${t.method} IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT')`),
    check('sale_tenders_intent_check', sql`(${t.method} IN ('CASH','STORE_CREDIT')) = (${t.paymentIntentId} IS NULL)`),
    check('sale_tenders_no_electronic_change', sql`${t.method} = 'CASH' OR ${t.change} = 0`),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    uniqueIndex('sale_tenders_intent_once').on(t.tenantId, t.paymentIntentId).where(sql`${t.paymentIntentId} IS NOT NULL`),
    check('sale_tenders_amounts_check', sql`${t.amount} >= 0 AND ${t.change} >= 0 AND ${t.tendered} - ${t.change} = ${t.amount}`),
  ],
);

// ------------------------------------------------------------------ returns (ADR-0011)

/**
 * A void or (partial) return of a completed sale. Append-only; the sale itself is never edited.
 * Amounts are positive and mean "given back".
 */
export const saleReturns = pgTable(
  'sale_returns',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    /** Session whose drawer paid the refund. */
    cashierSessionId: uuid('cashier_session_id').notNull(),
    kind: text('kind').notNull(),
    returnNumber: bigint('return_number', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    processedBy: uuid('processed_by').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    ...taxBuckets(),
    refundMethod: text('refund_method').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sale_returns_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('sale_returns_register_number_unique').on(t.tenantId, t.registerId, t.returnNumber),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    index('sale_returns_sale_idx').on(t.tenantId, t.saleId),
    check('sale_returns_kind_check', sql`${t.kind} IN ('VOID','RETURN')`),
    check('sale_returns_reason_check', sql`length(trim(${t.reason})) > 0`),
    check('sale_returns_refund_method_check', sql`${t.refundMethod} IN ('CASH','STORE_CREDIT')`),
    check(
      'sale_returns_buckets_check',
      sql`${t.amountDue} = ${t.vatableSales} + ${t.vatAmount} + ${t.vatExemptSales} + ${t.zeroRatedSales} + ${t.percentageTaxSales} - ${t.statutoryDiscount}`,
    ),
  ],
);

export const saleReturnLines = pgTable(
  'sale_return_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleReturnId: uuid('sale_return_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    quantity: qty('quantity').notNull(),
    disposition: text('disposition').notNull(),
    ...taxBuckets(),
  },
  (t) => [
    unique('sale_return_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('sale_return_lines_once_per_return').on(t.tenantId, t.saleReturnId, t.saleLineId),
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    index('sale_return_lines_line_idx').on(t.tenantId, t.saleLineId),
    check('sale_return_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('sale_return_lines_disposition_check', sql`${t.disposition} IN ('RESTOCK','DAMAGED')`),
  ],
);

// ------------------------------------------------------------------ store credit (session 20, ADR-0018)

/**
 * A customer's store credit with one legal entity (the business that owes it): Σ amount = balance,
 * never below zero (a trigger takes a per-customer lock and checks). Append-only. RETURN: a refund
 * given as credit (+); REDEEM: credit spent on a sale (−). The books carry the same amounts in
 * CUSTOMER_STORE_CREDIT, posted with the return or the sale.
 */
export const customerCreditEntries = pgTable(
  'customer_credit_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    kind: text('kind').notNull(),
    amount: money('amount').notNull(),
    saleId: uuid('sale_id'),
    saleReturnId: uuid('sale_return_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_credit_entries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    index('customer_credit_entries_customer_idx').on(t.tenantId, t.customerId, t.legalEntityId, t.createdAt),
    uniqueIndex('customer_credit_entries_return_once').on(t.tenantId, t.saleReturnId).where(sql`${t.saleReturnId} IS NOT NULL`),
    uniqueIndex('customer_credit_entries_sale_once').on(t.tenantId, t.saleId).where(sql`${t.saleId} IS NOT NULL`),
    check('customer_credit_entries_kind_check', sql`${t.kind} IN ('RETURN','REDEEM')`),
    check(
      'customer_credit_entries_link_check',
      sql`(${t.kind} = 'RETURN' AND ${t.amount} > 0 AND ${t.saleReturnId} IS NOT NULL AND ${t.saleId} IS NULL) OR (${t.kind} = 'REDEEM' AND ${t.amount} < 0 AND ${t.saleId} IS NOT NULL AND ${t.saleReturnId} IS NULL)`,
    ),
  ],
);

// ------------------------------------------------------------------ charges and restaurant checks (ADR-0014 §8, §9)

/**
 * A charge on a sale that is not an item (service charge). Its buckets are part of the sale's header
 * buckets (Σ lines + Σ charges = header); its ex-VAT amount is a liability, not revenue (RA 11360).
 */
export const saleCharges = pgTable(
  'sale_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    kind: text('kind').notNull(),
    orderBillChargeId: uuid('order_bill_charge_id'),
    base: money('base').notNull(),
    rate: numeric('rate', { precision: 9, scale: 6 }).notNull(),
    vatTreatment: text('vat_treatment').notNull(),
    ...taxBuckets(),
    taxSnapshot: jsonb('tax_snapshot').notNull(),
  },
  (t) => [
    unique('sale_charges_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('sale_charges_kind_unique').on(t.tenantId, t.saleId, t.kind),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.orderBillChargeId], foreignColumns: [orderBillCharges.tenantId, orderBillCharges.id] }),
    check('sale_charges_kind_check', sql`${t.kind} IN ('SERVICE_CHARGE')`),
    check('sale_charges_due_check', sql`${t.amountDue} >= 0`),
  ],
);

/** The part of a sale's charge given back by a return or void (prorated; the last return takes the rest). */
export const saleReturnCharges = pgTable(
  'sale_return_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    saleReturnId: uuid('sale_return_id').notNull(),
    saleChargeId: uuid('sale_charge_id').notNull(),
    ...taxBuckets(),
  },
  (t) => [
    unique('sale_return_charges_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('sale_return_charges_once').on(t.tenantId, t.saleReturnId, t.saleChargeId),
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    foreignKey({ columns: [t.tenantId, t.saleChargeId], foreignColumns: [saleCharges.tenantId, saleCharges.id] }),
  ],
);

/**
 * Which share of a bill line a check's sale line paid: `share_num / share_den` of the line. A DB
 * trigger keeps Σ shares per bill line ≤ 1 with exact fractions, so a line is never paid twice.
 */
export const orderBillAllocations = pgTable(
  'order_bill_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    orderBillId: uuid('order_bill_id').notNull(),
    billLineId: uuid('bill_line_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    shareNum: bigint('share_num', { mode: 'number' }).notNull(),
    shareDen: bigint('share_den', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('order_bill_allocations_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('order_bill_allocations_sale_line_unique').on(t.tenantId, t.saleLineId),
    foreignKey({ columns: [t.tenantId, t.orderBillId, t.billLineId], foreignColumns: [orderBillLines.tenantId, orderBillLines.orderBillId, orderBillLines.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.saleId, saleLines.id] }),
    index('order_bill_allocations_line_idx').on(t.tenantId, t.billLineId),
    check('order_bill_allocations_share_check', sql`${t.shareNum} > 0 AND ${t.shareDen} > 0 AND ${t.shareNum} <= ${t.shareDen}`),
  ],
);

// ------------------------------------------------------------------ stock

export const STOCK_MOVEMENT_TYPES = ['SALE', 'ADJUSTMENT', 'RETURN'] as const;

/** Append-only inventory ledger; stock_balances is derived from it by trigger. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    // ADR-0012: set by the costing trigger for outbound and customer returns; supplied by the
    // service for other inbound movements (the DB default is dropped, so a missing cost is refused).
    unitCost: money('unit_cost').notNull().default('0'),
    /** Signed inventory value moved; Σ value = balance value. */
    value: money('value').notNull().default('0'),
    type: text('type').notNull(),
    reason: text('reason'),
    saleId: uuid('sale_id'),
    saleLineId: uuid('sale_line_id'),
    saleReturnLineId: uuid('sale_return_line_id'),
    goodsReceiptLineId: uuid('goods_receipt_line_id'),
    supplierReturnLineId: uuid('supplier_return_line_id'),
    stockTransferLineId: uuid('stock_transfer_line_id'),
    stockCountLineId: uuid('stock_count_line_id'),
    stockAdjustmentId: uuid('stock_adjustment_id'),
    /** CONSUMPTION: the recipe version the sale line consumed with (ADR-0014 §4). */
    recipeVersionId: uuid('recipe_version_id'),
    /** Set by the costing trigger: an outbound movement that left the balance below zero (negative-stock policy). */
    belowZero: boolean('below_zero').notNull().default(false),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_movements_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.goodsReceiptLineId], foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id] }),
    foreignKey({ columns: [t.tenantId, t.supplierReturnLineId], foreignColumns: [supplierReturnLines.tenantId, supplierReturnLines.id] }),
    check('stock_movements_receipt_link', sql`(${t.type} = 'RECEIPT') = (${t.goodsReceiptLineId} IS NOT NULL)`),
    check('stock_movements_supplier_return_link', sql`(${t.type} = 'SUPPLIER_RETURN') = (${t.supplierReturnLineId} IS NOT NULL)`),
    foreignKey({ columns: [t.tenantId, t.stockTransferLineId], foreignColumns: [stockTransferLines.tenantId, stockTransferLines.id] }),
    foreignKey({ columns: [t.tenantId, t.stockCountLineId], foreignColumns: [stockCountLines.tenantId, stockCountLines.id] }),
    check('stock_movements_transfer_link', sql`(${t.type} IN ('TRANSFER_OUT','TRANSFER_IN')) = (${t.stockTransferLineId} IS NOT NULL)`),
    check('stock_movements_count_link', sql`(${t.type} = 'COUNT') = (${t.stockCountLineId} IS NOT NULL)`),
    foreignKey({ columns: [t.tenantId, t.stockAdjustmentId], foreignColumns: [stockAdjustments.tenantId, stockAdjustments.id] }),
    check('stock_movements_adjustment_link', sql`(${t.type} IN ('ADJUSTMENT','WASTE')) = (${t.stockAdjustmentId} IS NOT NULL)`),
    foreignKey({ columns: [t.tenantId, t.recipeVersionId], foreignColumns: [recipeVersions.tenantId, recipeVersions.id] }),
    check('stock_movements_consumption_link', sql`(${t.type} = 'CONSUMPTION') = (${t.recipeVersionId} IS NOT NULL)`),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    foreignKey({ columns: [t.tenantId, t.saleReturnLineId], foreignColumns: [saleReturnLines.tenantId, saleReturnLines.id] }),
    index('stock_movements_item_idx').on(t.tenantId, t.branchId, t.variantId, t.createdAt),
    check(
      'stock_movements_type_check',
      sql`${t.type} IN ('SALE','ADJUSTMENT','RETURN','RECEIPT','SUPPLIER_RETURN','TRANSFER_OUT','TRANSFER_IN','WASTE','COUNT','CONSUMPTION')`,
    ),
    check('stock_movements_nonzero', sql`${t.quantity} <> 0`),
    check('stock_movements_sale_link', sql`(${t.type} IN ('SALE','RETURN','CONSUMPTION')) = (${t.saleLineId} IS NOT NULL AND ${t.saleId} IS NOT NULL)`),
    check('stock_movements_return_link', sql`(${t.type} = 'RETURN') = (${t.saleReturnLineId} IS NOT NULL)`),
    check(
      'stock_movements_direction',
      sql`(${t.type} IN ('SALE','SUPPLIER_RETURN','TRANSFER_OUT','WASTE','CONSUMPTION') AND ${t.quantity} < 0) OR (${t.type} IN ('RETURN','RECEIPT','TRANSFER_IN') AND ${t.quantity} > 0) OR ${t.type} IN ('ADJUSTMENT','COUNT')`,
    ),
    check('stock_movements_reason', sql`${t.type} NOT IN ('ADJUSTMENT','WASTE') OR length(trim(coalesce(${t.reason}, ''))) > 0`),
  ],
);

/** Σ stock_movements per (branch, variant), maintained by a trigger; read-only to the app. */
export const stockBalances = pgTable(
  'stock_balances',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    /** Σ stock_movements.value (ADR-0012). */
    value: money('value').notNull().default('0'),
    /** Weighted-average unit cost; kept from the last stock on hand while quantity ≤ 0. */
    avgCost: money('avg_cost').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
  ],
);
