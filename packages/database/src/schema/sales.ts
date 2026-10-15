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
import { branches, legalEntities, registers } from './organization.js';
import { tenants } from './platform.js';
import { taxProfiles } from './tax.js';

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
    check('cashier_sessions_status_check', sql`${t.status} IN ('OPEN','CLOSED','RECONCILED')`),
    check('cashier_sessions_float_check', sql`${t.openingFloat} >= 0`),
    check('cashier_sessions_closed_check', sql`(${t.status} = 'OPEN') = (${t.closedAt} IS NULL)`),
  ],
);

export const CASH_MOVEMENT_TYPES = ['OPENING_FLOAT', 'SALE', 'PAY_IN', 'PAY_OUT'] as const;
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
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cash_movements_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    index('cash_movements_session_idx').on(t.tenantId, t.cashierSessionId),
    check('cash_movements_type_check', sql`${t.type} IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT')`),
    check(
      'cash_movements_sign_check',
      sql`(${t.type} = 'PAY_OUT' AND ${t.amount} < 0) OR (${t.type} IN ('PAY_IN') AND ${t.amount} > 0) OR (${t.type} IN ('OPENING_FLOAT','SALE') AND ${t.amount} >= 0)`,
    ),
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
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sales_tenant_id_id_unique').on(t.tenantId, t.id),
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
  },
  (t) => [
    unique('sale_lines_tenant_id_id_unique').on(t.tenantId, t.id),
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

export const TENDER_METHODS = ['CASH', ...PAYMENT_METHODS] as const;

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sale_tenders_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    index('sale_tenders_sale_idx').on(t.tenantId, t.saleId),
    check('sale_tenders_method_check', sql`${t.method} IN ('CASH','CARD','QR','EWALLET')`),
    check('sale_tenders_intent_check', sql`(${t.method} = 'CASH') = (${t.paymentIntentId} IS NULL)`),
    check('sale_tenders_no_electronic_change', sql`${t.method} = 'CASH' OR ${t.change} = 0`),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    uniqueIndex('sale_tenders_intent_once').on(t.tenantId, t.paymentIntentId).where(sql`${t.paymentIntentId} IS NOT NULL`),
    check('sale_tenders_amounts_check', sql`${t.amount} >= 0 AND ${t.change} >= 0 AND ${t.tendered} - ${t.change} = ${t.amount}`),
  ],
);

// ------------------------------------------------------------------ stock

export const STOCK_MOVEMENT_TYPES = ['SALE', 'ADJUSTMENT'] as const;

/** Append-only inventory ledger; stock_balances is derived from it by trigger. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    type: text('type').notNull(),
    reason: text('reason'),
    saleId: uuid('sale_id'),
    saleLineId: uuid('sale_line_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_movements_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    index('stock_movements_item_idx').on(t.tenantId, t.branchId, t.variantId, t.createdAt),
    check('stock_movements_type_check', sql`${t.type} IN ('SALE','ADJUSTMENT')`),
    check('stock_movements_nonzero', sql`${t.quantity} <> 0`),
    check('stock_movements_sale_link', sql`(${t.type} = 'SALE') = (${t.saleLineId} IS NOT NULL AND ${t.saleId} IS NOT NULL)`),
    check('stock_movements_reason', sql`${t.type} <> 'ADJUSTMENT' OR length(trim(coalesce(${t.reason}, ''))) > 0`),
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
  ],
);
