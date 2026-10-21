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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { productPrices, productVariants, promotions } from './catalog.js';
import { customers } from './customers.js';
import { tenantMemberships } from './identity.js';
import { branches, legalEntities } from './organization.js';
import { tenants } from './platform.js';
import { cashierSessions, paymentIntents, saleLines, sales } from './sales.js';
import { customerPackages } from './salon.js';
import { taxProfiles } from './tax.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });
const kilos = (name: string) => numeric(name, { precision: 12, scale: 3 });
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

// ------------------------------------------------------------------ set-up (ADR-0024 §3, §6, §9)

/** Per branch: turnaround, the items the shop adds by itself, the unclaimed-items policy, notices. */
export const laundrySettings = pgTable(
  'laundry_settings',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    regularHours: integer('regular_hours').notNull().default(48),
    expressHours: integer('express_hours').notNull().default(6),
    /** Added as a line to an EXPRESS job; its laundry unit decides the quantity (per job, kilo or load). */
    expressVariantId: uuid('express_variant_id'),
    /** Added as a line when delivery is asked for. */
    deliveryVariantId: uuid('delivery_variant_id'),
    /** One line per day a claimed job waited beyond `storage_free_days`; null days = no storage fee. */
    storageFeeVariantId: uuid('storage_fee_variant_id'),
    storageFreeDays: integer('storage_free_days'),
    unclaimedDays: integer('unclaimed_days').notNull().default(30),
    finalNoticeDays: integer('final_notice_days').notNull().default(3),
    reminderDays: integer('reminder_days').array().notNull().default(sql`'{3,7}'::integer[]`),
    claimPolicyText: text('claim_policy_text'),
    smsEnabled: boolean('sms_enabled').notNull().default(false),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.expressVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.deliveryVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.storageFeeVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('laundry_settings_hours_check', sql`${t.regularHours} BETWEEN 1 AND 720 AND ${t.expressHours} BETWEEN 1 AND 168`),
    check('laundry_settings_days_check', sql`${t.unclaimedDays} BETWEEN 7 AND 365 AND ${t.finalNoticeDays} BETWEEN 1 AND 30 AND ${t.finalNoticeDays} < ${t.unclaimedDays}
      AND (${t.storageFreeDays} IS NULL OR ${t.storageFreeDays} BETWEEN 0 AND 365) AND cardinality(${t.reminderDays}) <= 5`),
    check('laundry_settings_policy_check', sql`${t.claimPolicyText} IS NULL OR length(${t.claimPolicyText}) <= 1000`),
  ],
);

/** The garment types a counter picks from when it counts pieces at drop-off (business-wide). */
export const laundryGarmentTypes = pgTable(
  'laundry_garment_types',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('laundry_garment_types_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('laundry_garment_types_name_active_unique').on(t.tenantId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    check('laundry_garment_types_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  ],
);

export const MACHINE_KINDS = ['WASHER', 'DRYER'] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

/** A washer or dryer of a branch (§7). Archived, never deleted (runs and sales name it). */
export const laundryMachines = pgTable(
  'laundry_machines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').$type<MachineKind>().notNull(),
    label: text('label').notNull(),
    capacityKg: kilos('capacity_kg'),
    cycleMinutes: integer('cycle_minutes').notNull(),
    /** Set: out of service, with why. */
    outOfOrderReason: text('out_of_order_reason'),
    isSample: boolean('is_sample').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('laundry_machines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('laundry_machines_tenant_branch_id_unique').on(t.tenantId, t.branchId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    uniqueIndex('laundry_machines_label_active_unique').on(t.tenantId, t.branchId, sql`lower(${t.label})`).where(sql`${t.archivedAt} IS NULL`),
    check('laundry_machines_kind_check', sql`${t.kind} IN ('WASHER','DRYER')`),
    check('laundry_machines_label_check', sql`length(btrim(${t.label})) BETWEEN 1 AND 30`),
    check('laundry_machines_minutes_check', sql`${t.cycleMinutes} BETWEEN 1 AND 240 AND (${t.capacityKg} IS NULL OR ${t.capacityKg} > 0)`),
    check('laundry_machines_reason_check', sql`${t.outOfOrderReason} IS NULL OR length(btrim(${t.outOfOrderReason})) BETWEEN 1 AND 200`),
  ],
);

// ------------------------------------------------------------------ job orders (§3)

export const JOB_ORDER_STATUSES = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY', 'CLAIMED', 'CANCELLED', 'DISPOSED'] as const;
export type JobOrderStatus = (typeof JOB_ORDER_STATUSES)[number];
/** Statuses of a job still at the shop or on its way (not CLAIMED, CANCELLED or DISPOSED). */
export const OPEN_JOB_ORDER_STATUSES = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY'] as const;

/**
 * A drop-off (or a pickup) to be washed, dried, folded or pressed, and its claim ticket. Operational:
 * changed in place and audited; a trigger keeps the status moves (0104). Its lines are priced and
 * frozen by `computeCart` (the ticket's total, `pricedAt` + the tax profile); the sale is recorded at
 * claim from them (`sale_id`). Down payments are `job_order_deposits` until then.
 */
export const jobOrders = pgTable(
  'job_orders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    /** Per branch, from a gapless counter; printed J-000123. */
    number: bigint('number', { mode: 'number' }).notNull(),
    /** On the customer's stub: what releases the laundry. */
    claimCode: text('claim_code').notNull(),
    customerId: uuid('customer_id'),
    /** A walk-in who is not a customer (yet): name and phone for the notice. Personal data. */
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    serviceLevel: text('service_level').notNull().default('REGULAR'),
    promisedAt: timestamp('promised_at', { withTimezone: true }).notNull(),
    status: text('status').$type<JobOrderStatus>().notNull().default('RECEIVED'),
    weightKg: kilos('weight_kg'),
    bagCount: smallint('bag_count').notNull().default(1),
    specialInstructions: text('special_instructions'),
    conditionNotes: text('condition_notes'),
    pickupRequested: boolean('pickup_requested').notNull().default(false),
    deliveryRequested: boolean('delivery_requested').notNull().default(false),
    /** Ready notices and reminders go out (§6). */
    notify: boolean('notify').notNull().default(true),
    // The frozen price of the lines (null until a pickup is weighed and priced).
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    taxProfileId: uuid('tax_profile_id'),
    taxSnapshot: jsonb('tax_snapshot'),
    requiresProfessionalReview: boolean('requires_professional_review').notNull().default(false),
    pricedAt: timestamp('priced_at', { withTimezone: true }),
    amountDue: money('amount_due').notNull().default('0'),
    saleId: uuid('sale_id'),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: uuid('claimed_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    disposedAt: timestamp('disposed_at', { withTimezone: true }),
    disposedReason: text('disposed_reason'),
    disposedNote: text('disposed_note'),
    receivedBy: uuid('received_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('job_orders_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('job_orders_tenant_branch_id_unique').on(t.tenantId, t.branchId, t.id),
    unique('job_orders_number_unique').on(t.tenantId, t.branchId, t.number),
    unique('job_orders_claim_code_unique').on(t.tenantId, t.claimCode),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ columns: [t.tenantId, t.taxProfileId], foreignColumns: [taxProfiles.tenantId, taxProfiles.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    uniqueIndex('job_orders_sale_once').on(t.tenantId, t.saleId).where(sql`${t.saleId} IS NOT NULL`),
    index('job_orders_branch_status_idx').on(t.tenantId, t.branchId, t.status),
    index('job_orders_customer_idx').on(t.tenantId, t.customerId).where(sql`${t.customerId} IS NOT NULL`),
    index('job_orders_ready_idx').on(t.tenantId, t.readyAt).where(sql`${t.status} = 'READY'`),
    check('job_orders_status_check', sql`${t.status} IN ('RECEIVED','WASHING','DRYING','FOLDING','READY','OUT_FOR_DELIVERY','CLAIMED','CANCELLED','DISPOSED')`),
    check('job_orders_level_check', sql`${t.serviceLevel} IN ('REGULAR','EXPRESS')`),
    check('job_orders_number_check', sql`${t.number} > 0 AND ${t.claimCode} ~ '^[A-Z0-9]{6}$'`),
    check('job_orders_who_check', sql`${t.customerId} IS NOT NULL OR length(btrim(coalesce(${t.customerName}, ''))) BETWEEN 1 AND 120`),
    check('job_orders_text_check', sql`coalesce(length(${t.customerName}), 0) <= 120 AND coalesce(length(${t.customerPhone}), 0) <= 20
      AND coalesce(length(${t.specialInstructions}), 0) <= 500 AND coalesce(length(${t.conditionNotes}), 0) <= 500
      AND coalesce(length(${t.cancelReason}), 0) <= 200 AND coalesce(length(${t.disposedNote}), 0) <= 200`),
    check('job_orders_weight_check', sql`(${t.weightKg} IS NULL OR ${t.weightKg} > 0) AND ${t.bagCount} BETWEEN 1 AND 99 AND ${t.amountDue} >= 0`),
    check('job_orders_priced_check', sql`(${t.pricedAt} IS NULL) = (${t.taxProfileId} IS NULL) AND (${t.pricedAt} IS NULL) = (${t.taxSnapshot} IS NULL)`),
    check('job_orders_claimed_check', sql`(${t.status} = 'CLAIMED') = (${t.saleId} IS NOT NULL AND ${t.claimedAt} IS NOT NULL)`),
    check('job_orders_cancelled_check', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL AND length(btrim(coalesce(${t.cancelReason}, ''))) > 0)`),
    check('job_orders_disposed_check', sql`(${t.status} = 'DISPOSED') = (${t.disposedAt} IS NOT NULL AND ${t.disposedReason} IN ('DONATED','DISCARDED','OTHER'))`),
  ],
);

/**
 * What a job is charged for, priced and frozen by the tax path (as a restaurant bill's lines): a re-weigh
 * or an add-on found while washing replaces the set (audited). `measured_quantity` is what was weighed or
 * counted, `quantity` what is billed (at least the service's minimum).
 */
export const jobOrderLines = pgTable(
  'job_order_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    variantId: uuid('variant_id').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    taxCategoryCode: text('tax_category_code').notNull(),
    vatTreatment: text('vat_treatment').notNull(),
    laundryUnit: text('laundry_unit'),
    measuredQuantity: qty('measured_quantity').notNull(),
    quantity: qty('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    priceIncludesTax: boolean('price_includes_tax').notNull(),
    priceId: uuid('price_id').notNull(),
    priceListId: uuid('price_list_id').notNull(),
    trackInventory: boolean('track_inventory').notNull(),
    productType: text('product_type').notNull(),
    promotionId: uuid('promotion_id'),
    /** A session of this customer's package (§10): priced at zero, redeemed at claim. */
    customerPackageId: uuid('customer_package_id'),
    ...buckets(),
    taxSnapshot: jsonb('tax_snapshot').notNull(),
  },
  (t) => [
    unique('job_order_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('job_order_lines_number_unique').on(t.tenantId, t.jobOrderId, t.lineNo),
    foreignKey({ columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.priceId], foreignColumns: [productPrices.tenantId, productPrices.id] }),
    foreignKey({ columns: [t.tenantId, t.promotionId], foreignColumns: [promotions.tenantId, promotions.id] }),
    foreignKey({ columns: [t.tenantId, t.customerPackageId], foreignColumns: [customerPackages.tenantId, customerPackages.id] }),
    index('job_order_lines_job_idx').on(t.tenantId, t.jobOrderId),
    check('job_order_lines_quantity_check', sql`${t.quantity} > 0 AND ${t.measuredQuantity} > 0 AND ${t.quantity} >= ${t.measuredQuantity}`),
    check('job_order_lines_unit_check', sql`${t.laundryUnit} IS NULL OR ${t.laundryUnit} IN ('KG','LOAD','PIECE')`),
  ],
);

/** Pieces counted at drop-off ("12 shirts"), printed on the ticket and checked at release (§3). */
export const jobOrderItems = pgTable(
  'job_order_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    garmentTypeId: uuid('garment_type_id'),
    label: text('label').notNull(),
    count: integer('count').notNull(),
    note: text('note'),
  },
  (t) => [
    unique('job_order_items_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.garmentTypeId], foreignColumns: [laundryGarmentTypes.tenantId, laundryGarmentTypes.id] }),
    index('job_order_items_job_idx').on(t.tenantId, t.jobOrderId),
    check('job_order_items_check', sql`length(btrim(${t.label})) BETWEEN 1 AND 60 AND ${t.count} BETWEEN 1 AND 999 AND coalesce(length(${t.note}), 0) <= 200`),
  ],
);

/** Who moved a job, when, from and to (append-only): the board's history and the turnaround report. */
export const jobOrderStatusChanges = pgTable(
  'job_order_status_changes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('job_order_status_changes_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
    index('job_order_status_changes_job_idx').on(t.tenantId, t.jobOrderId, t.changedAt),
    check('job_order_status_changes_note_check', sql`coalesce(length(${t.note}), 0) <= 200`),
  ],
);

export const JOB_DEPOSIT_KINDS = ['RECEIVED', 'APPLIED', 'REFUNDED', 'FORFEITED'] as const;
export type JobDepositKind = (typeof JOB_DEPOSIT_KINDS)[number];

/**
 * Down payments on a job (§5), append-only and signed: RECEIVED (+), APPLIED at claim (−, the claim
 * sale's JOB_DEPOSIT tender), REFUNDED (−), FORFEITED (−). Never below zero, never more than the job's
 * frozen total (insert trigger, per-job lock). Held without VAT until applied or forfeited.
 */
export const jobOrderDeposits = pgTable(
  'job_order_deposits',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').$type<JobDepositKind>().notNull(),
    amount: money('amount').notNull(),
    /** RECEIVED / REFUNDED: CASH, CARD, QR, EWALLET or BANK_TRANSFER. */
    method: text('method'),
    cashierSessionId: uuid('cashier_session_id'),
    paymentIntentId: uuid('payment_intent_id'),
    reference: text('reference'),
    reason: text('reason'),
    /** APPLIED: the claim sale. */
    saleId: uuid('sale_id'),
    /** FORFEITED: kept as income, its split by @1pos/tax with the job's main service's category. */
    netAmount: money('net_amount'),
    vatAmount: money('vat_amount'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('job_order_deposits_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    uniqueIndex('job_order_deposits_intent_once').on(t.tenantId, t.paymentIntentId).where(sql`${t.paymentIntentId} IS NOT NULL`),
    uniqueIndex('job_order_deposits_applied_once').on(t.tenantId, t.saleId).where(sql`${t.kind} = 'APPLIED'`),
    index('job_order_deposits_job_idx').on(t.tenantId, t.jobOrderId),
    index('job_order_deposits_session_idx').on(t.tenantId, t.cashierSessionId).where(sql`${t.cashierSessionId} IS NOT NULL`),
    check('job_order_deposits_kind_check', sql`${t.kind} IN ('RECEIVED','APPLIED','REFUNDED','FORFEITED')`),
    check('job_order_deposits_sign_check', sql`CASE WHEN ${t.kind} = 'RECEIVED' THEN ${t.amount} > 0 ELSE ${t.amount} < 0 END`),
    check(
      'job_order_deposits_method_check',
      sql`CASE WHEN ${t.kind} IN ('RECEIVED','REFUNDED') THEN ${t.method} IN ('CASH','CARD','QR','EWALLET','BANK_TRANSFER') ELSE ${t.method} IS NULL END
          AND (${t.method} IS DISTINCT FROM 'CASH' OR ${t.cashierSessionId} IS NOT NULL)
          AND coalesce(${t.method} IN ('CARD','QR','EWALLET'), false) = (${t.paymentIntentId} IS NOT NULL)
          AND coalesce(${t.method} = 'BANK_TRANSFER', false) = (${t.reference} IS NOT NULL)`,
    ),
    check('job_order_deposits_refund_check', sql`${t.kind} <> 'REFUNDED' OR ${t.method} IN ('CASH','BANK_TRANSFER')`),
    check('job_order_deposits_applied_check', sql`(${t.kind} = 'APPLIED') = (${t.saleId} IS NOT NULL)`),
    check('job_order_deposits_forfeit_check', sql`(${t.kind} = 'FORFEITED') = (${t.netAmount} IS NOT NULL AND ${t.vatAmount} IS NOT NULL)`),
    check('job_order_deposits_text_check', sql`coalesce(length(${t.reference}), 0) <= 64 AND coalesce(length(${t.reason}), 0) <= 200`),
  ],
);

export const NOTICE_KINDS = ['READY', 'REMINDER', 'FINAL'] as const;
export const NOTICE_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;

/**
 * "Ready for pickup" notices and reminders (§6): one row per (job, kind, step), queued by the API (READY)
 * or the worker's hourly pass (REMINDER, FINAL), then settled once by the worker with what each channel
 * did. Recipients are kept masked only.
 */
export const jobOrderNotices = pgTable(
  'job_order_notices',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    kind: text('kind').notNull(),
    /** REMINDER: the day after READY it is for; READY and FINAL: 0. */
    step: integer('step').notNull().default(0),
    status: text('status').notNull().default('QUEUED'),
    emailStatus: text('email_status'),
    emailTo: text('email_to'),
    smsStatus: text('sms_status'),
    smsTo: text('sms_to'),
    providerReference: text('provider_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    unique('job_order_notices_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('job_order_notices_once').on(t.tenantId, t.jobOrderId, t.kind, t.step),
    foreignKey({ columns: [t.tenantId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.id] }),
    check('job_order_notices_kind_check', sql`${t.kind} IN ('READY','REMINDER','FINAL')`),
    check('job_order_notices_status_check', sql`${t.status} IN ('QUEUED','SENT','FAILED','SKIPPED') AND (${t.status} = 'QUEUED') = (${t.settledAt} IS NULL)`),
    check('job_order_notices_channel_check', sql`coalesce(${t.emailStatus}, 'SKIPPED') IN ('SENT','FAILED','SKIPPED') AND coalesce(${t.smsStatus}, 'SKIPPED') IN ('SENT','FAILED','SKIPPED')
      AND coalesce(length(${t.emailTo}), 0) <= 254 AND coalesce(length(${t.smsTo}), 0) <= 20 AND coalesce(length(${t.providerReference}), 0) <= 128`),
  ],
);

export const TRIP_KINDS = ['PICKUP', 'DELIVERY'] as const;
export const TRIP_STATUSES = ['SCHEDULED', 'DONE', 'FAILED', 'CANCELLED'] as const;

/** A pickup from or a delivery to the customer (§8). The address and phone are personal data. */
export const jobOrderTrips = pgTable(
  'job_order_trips',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    jobOrderId: uuid('job_order_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').notNull(),
    /** Null only once the customer was anonymised (the trip stays, without where or whom). */
    address: text('address'),
    contactPhone: text('contact_phone'),
    contactName: text('contact_name'),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    riderMemberId: uuid('rider_member_id'),
    riderName: text('rider_name'),
    status: text('status').notNull().default('SCHEDULED'),
    failReason: text('fail_reason'),
    notes: text('notes'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('job_order_trips_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.branchId, jobOrders.id] }),
    foreignKey({ columns: [t.tenantId, t.riderMemberId], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    index('job_order_trips_branch_idx').on(t.tenantId, t.branchId, t.windowStart),
    index('job_order_trips_job_idx').on(t.tenantId, t.jobOrderId),
    // One live trip of each kind per job.
    uniqueIndex('job_order_trips_live_once').on(t.tenantId, t.jobOrderId, t.kind).where(sql`${t.status} = 'SCHEDULED'`),
    check('job_order_trips_kind_check', sql`${t.kind} IN ('PICKUP','DELIVERY')`),
    check('job_order_trips_status_check', sql`${t.status} IN ('SCHEDULED','DONE','FAILED','CANCELLED')`),
    check('job_order_trips_text_check', sql`coalesce(length(btrim(${t.address})) BETWEEN 1 AND 300, true) AND coalesce(length(btrim(${t.contactPhone})) BETWEEN 7 AND 20, true)
      AND coalesce(length(${t.contactName}), 0) <= 120 AND coalesce(length(${t.riderName}), 0) <= 80 AND coalesce(length(${t.notes}), 0) <= 300 AND coalesce(length(${t.failReason}), 0) <= 200`),
    check('job_order_trips_window_check', sql`${t.windowStart} IS NULL OR ${t.windowEnd} IS NULL OR ${t.windowEnd} > ${t.windowStart}`),
    check('job_order_trips_done_check', sql`(${t.status} = 'DONE') = (${t.doneAt} IS NOT NULL) AND (${t.status} IN ('FAILED','CANCELLED')) = (${t.failReason} IS NOT NULL)`),
  ],
);

// ------------------------------------------------------------------ machine runs (§7)

/**
 * A washer or dryer in use: a self-service cycle sold at the counter (its sale line) or a drop-off load
 * (its job). `ends_at` is when it is due to finish; `stopped_at` is set once if stopped early. Runs of
 * one machine never overlap (GiST exclusion, 0104).
 */
export const machineRuns = pgTable(
  'machine_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    machineId: uuid('machine_id').notNull(),
    source: text('source').notNull(),
    saleId: uuid('sale_id'),
    saleLineId: uuid('sale_line_id'),
    jobOrderId: uuid('job_order_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    plannedMinutes: integer('planned_minutes').notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    stoppedBy: uuid('stopped_by'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('machine_runs_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.machineId], foreignColumns: [laundryMachines.tenantId, laundryMachines.branchId, laundryMachines.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.jobOrderId], foreignColumns: [jobOrders.tenantId, jobOrders.branchId, jobOrders.id] }),
    uniqueIndex('machine_runs_sale_line_once').on(t.tenantId, t.saleLineId).where(sql`${t.saleLineId} IS NOT NULL`),
    index('machine_runs_machine_idx').on(t.tenantId, t.machineId, t.startedAt),
    index('machine_runs_branch_idx').on(t.tenantId, t.branchId, t.startedAt),
    check('machine_runs_source_check', sql`(${t.source} = 'SELF_SERVICE' AND ${t.saleLineId} IS NOT NULL AND ${t.saleId} IS NOT NULL AND ${t.jobOrderId} IS NULL)
      OR (${t.source} = 'JOB' AND ${t.jobOrderId} IS NOT NULL AND ${t.saleLineId} IS NULL AND ${t.saleId} IS NULL)`),
    check('machine_runs_time_check', sql`${t.plannedMinutes} BETWEEN 1 AND 240 AND ${t.endsAt} > ${t.startedAt}
      AND (${t.stoppedAt} IS NULL OR (${t.stoppedAt} >= ${t.startedAt} AND ${t.stoppedAt} < ${t.endsAt}))`),
  ],
);
