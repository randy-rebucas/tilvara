import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantMemberships } from './identity.js';
import { tenants } from './platform.js';

export interface PlanLimits {
  maxLegalEntities: number;
  maxBranches: number;
  maxRegisters: number;
  maxUsers: number;
}

export const PLAN_FEATURES = ['multi_entity', 'api_access', 'advanced_reports'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Global plan catalog (platform-managed, seeded by migration). */
export const plans = pgTable('plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  monthlyPrice: numeric('monthly_price', { precision: 20, scale: 4 }).notNull(),
  currency: text('currency').notNull().default('PHP'),
  limits: jsonb('limits').$type<PlanLimits>().notNull(),
  features: jsonb('features').$type<PlanFeature[]>().notNull().default([]),
  /** Extension codes a business on this plan may switch on (ADR-0026); each extension's migration adds itself. */
  extensions: jsonb('extensions').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
});

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * One current subscription per tenant. Changed only by platform functions (billing, ADR-0027; the
 * support CLI). Access rule (app_subscription_write_allowed): TRIALING until trial end, ACTIVE until a
 * week past the paid-until date (the hourly billing pass makes it PAST_DUE at that date), and PAST_DUE
 * until grace end → full access; otherwise read-only. Data is never deleted for billing reasons.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code),
    status: text('status').$type<SubscriptionStatus>().notNull(),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    /** A plan costing no more, chosen by the owner: the next renewal bill is for it (ADR-0027). */
    scheduledPlanCode: text('scheduled_plan_code').references(() => plans.code),
    /** The owner asked to stop: at the paid-until date the subscription becomes CANCELED, not PAST_DUE. */
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /**
     * Where the billing periods are counted from (audit 45 #19): each period ends on this instant's day of the
     * month in Asia/Manila, n months on (Jan 31 → Feb 28 → Mar 31). Set by the billing functions; NULL until then.
     */
    billingAnchorAt: timestamp('billing_anchor_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('subscriptions_tenant_unique').on(t.tenantId),
    check('subscriptions_status_check', sql`${t.status} IN ('TRIALING','ACTIVE','PAST_DUE','CANCELED')`),
  ],
);

export const BILL_KINDS = ['START', 'RENEWAL', 'UPGRADE'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const BILL_STATUSES = ['OPEN', 'PAID', 'VOID'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
export const BILLING_PAYMENT_METHODS = ['BANK_TRANSFER', 'CARD', 'GCASH', 'MAYA', 'GRABPAY', 'QRPH', 'CASH', 'OTHER'] as const;
export type BillingPaymentMethod = (typeof BILLING_PAYMENT_METHODS)[number];
export const BILLING_PROVIDERS = ['MANUAL', 'PAYMONGO', 'DEV'] as const;
export type BillingProviderCode = (typeof BILLING_PROVIDERS)[number];

/**
 * What a business owes Tilvara for a period of its plan (ADR-0027): issued by the billing pass
 * (START before a trial ends, RENEWAL before the paid-until date) or by the owner (choosing a plan,
 * UPGRADE prorated for the rest of the period). Written only by the `billing_*` definer functions;
 * only the status columns ever change, once, from OPEN. Not a BIR invoice or receipt.
 */
export const billingBills = pgTable(
  'billing_bills',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Per business: B-000001, B-000002, … */
    number: text('number').notNull(),
    kind: text('kind').$type<BillKind>().notNull(),
    planCode: text('plan_code')
      .notNull()
      .references(() => plans.code),
    /** UPGRADE: the plan it upgrades from. */
    fromPlanCode: text('from_plan_code').references(() => plans.code),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<BillStatus>().notNull().default('OPEN'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    /** The VAT inside `amount` (Tilvara is VAT-registered; prices are VAT-inclusive, 12%). */
    vatAmount: numeric('vat_amount', { precision: 20, scale: 4 }).notNull().default('0'),
    /** Reminders sent before the due date (three days and one day before), once each. */
    remindedEarlyAt: timestamp('reminded_early_at', { withTimezone: true }),
    remindedLastAt: timestamp('reminded_last_at', { withTimezone: true }),
  },
  (t) => [
    unique('billing_bills_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('billing_bills_tenant_number_unique').on(t.tenantId, t.number),
    check('billing_bills_kind_check', sql`${t.kind} IN ('START','RENEWAL','UPGRADE')`),
    check('billing_bills_status_check', sql`${t.status} IN ('OPEN','PAID','VOID')`),
    check('billing_bills_amount_check', sql`${t.amount} > 0`),
    check('billing_bills_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check('billing_bills_upgrade_check', sql`(${t.kind} = 'UPGRADE') = (${t.fromPlanCode} IS NOT NULL)`),
    check(
      'billing_bills_status_dates_check',
      sql`(${t.status} = 'PAID') = (${t.paidAt} IS NOT NULL) AND (${t.status} = 'VOID') = (${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL)`,
    ),
    // One open bill for the period (START/RENEWAL) and one open upgrade at a time.
    uniqueIndex('billing_bills_one_open_period').on(t.tenantId).where(sql`${t.status} = 'OPEN' AND ${t.kind} <> 'UPGRADE'`),
    uniqueIndex('billing_bills_one_open_upgrade').on(t.tenantId).where(sql`${t.status} = 'OPEN' AND ${t.kind} = 'UPGRADE'`),
    index('billing_bills_tenant_issued_idx').on(t.tenantId, t.issuedAt.desc()),
  ],
);

/**
 * Money received for a bill (append-only). `applied` is false for money that could not settle its bill
 * (already paid, voided, or a different amount): kept so ops refunds or applies it, never lost.
 */
export const billingPayments = pgTable(
  'billing_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    billId: uuid('bill_id').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    method: text('method').$type<BillingPaymentMethod>().notNull(),
    provider: text('provider').$type<BillingProviderCode>().notNull(),
    /** The bank's or provider's reference (PayMongo payment id). */
    reference: text('reference').notNull(),
    applied: boolean('applied').notNull(),
    /** Who recorded it: `ops:<name>` (support CLI) or the provider. */
    recordedBy: text('recorded_by').notNull(),
    note: text('note'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('billing_payments_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.billId], foreignColumns: [billingBills.tenantId, billingBills.id] }),
    unique('billing_payments_reference_unique').on(t.tenantId, t.provider, t.reference),
    uniqueIndex('billing_payments_provider_reference').on(t.provider, t.reference).where(sql`${t.provider} <> 'MANUAL'`),
    check('billing_payments_amount_check', sql`${t.amount} > 0`),
    check('billing_payments_method_check', sql`${t.method} IN ('BANK_TRANSFER','CARD','GCASH','MAYA','GRABPAY','QRPH','CASH','OTHER')`),
    check('billing_payments_provider_check', sql`${t.provider} IN ('MANUAL','PAYMONGO','DEV')`),
    index('billing_payments_bill_idx').on(t.tenantId, t.billId),
  ],
);

/** A hosted payment page opened for a bill (a PayMongo checkout session, or the Dev simulator's). */
export const billingCheckouts = pgTable(
  'billing_checkouts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    billId: uuid('bill_id').notNull(),
    provider: text('provider').$type<'PAYMONGO' | 'DEV'>().notNull(),
    providerCheckoutId: text('provider_checkout_id').notNull(),
    checkoutUrl: text('checkout_url').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    status: text('status').$type<'OPEN' | 'PAID' | 'EXPIRED'>().notNull().default('OPEN'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('billing_checkouts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('billing_checkouts_provider_id_unique').on(t.provider, t.providerCheckoutId),
    foreignKey({ columns: [t.tenantId, t.billId], foreignColumns: [billingBills.tenantId, billingBills.id] }),
    foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    check('billing_checkouts_provider_check', sql`${t.provider} IN ('PAYMONGO','DEV')`),
    check('billing_checkouts_status_check', sql`${t.status} IN ('OPEN','PAID','EXPIRED')`),
    index('billing_checkouts_bill_idx').on(t.tenantId, t.billId),
  ],
);

/**
 * Every provider webhook event accepted (signature checked), once: a resent event is answered
 * without being applied again. Platform table: written and read by definer functions only.
 */
export const billingProviderEvents = pgTable(
  'billing_provider_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    outcome: text('outcome').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

/** Who issues the businesses' receipts (ADR-0027): Tilvara's own registration, one row, set by ops (`support billing-seller`). */
export const billingSeller = pgTable(
  'billing_seller',
  {
    id: boolean('id').primaryKey().default(true),
    registeredName: text('registered_name').notNull(),
    tradeName: text('trade_name'),
    tin: text('tin'),
    address: text('address'),
    vatRegistered: boolean('vat_registered').notNull().default(true),
    /** The BIR permit or accreditation line printed on receipts, once Tilvara has one. */
    permitNote: text('permit_note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('billing_seller_one_row', sql`${t.id}`)],
);

/**
 * The receipt for a payment that settled a bill: system-generated, one per applied payment, numbered in one
 * series for Tilvara as issuer (R-00000001…). Seller and buyer are copied as they were on the day; never
 * changed (append-only). Mailed to the owners and kept in the app.
 */
export const billingReceipts = pgTable(
  'billing_receipts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    billId: uuid('bill_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    number: text('number').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    seller: jsonb('seller').$type<Record<string, unknown>>().notNull(),
    buyer: jsonb('buyer').$type<Record<string, unknown>>().notNull(),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    vatableAmount: numeric('vatable_amount', { precision: 20, scale: 4 }).notNull(),
    vatAmount: numeric('vat_amount', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    method: text('method').notNull(),
    reference: text('reference').notNull(),
  },
  (t) => [
    unique('billing_receipts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('billing_receipts_number_unique').on(t.number),
    unique('billing_receipts_payment_unique').on(t.paymentId),
    foreignKey({ columns: [t.tenantId, t.billId], foreignColumns: [billingBills.tenantId, billingBills.id] }),
    foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [billingPayments.tenantId, billingPayments.id] }),
    check('billing_receipts_amounts_check', sql`${t.amount} > 0 AND ${t.vatableAmount} + ${t.vatAmount} = ${t.amount}`),
    index('billing_receipts_tenant_idx').on(t.tenantId, t.issuedAt.desc()),
  ],
);
