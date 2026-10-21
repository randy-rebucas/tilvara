import { sql } from 'drizzle-orm';
import { boolean, check, date, type PgTableExtraConfigValue, foreignKey, index, integer, numeric, pgTable, primaryKey, smallint, text, time, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { customers } from './customers.js';
import { tenantMemberships } from './identity.js';
import { branches, legalEntities } from './organization.js';
import { tenants } from './platform.js';
import { saleLines, saleReturns, sales, saleTips } from './sales.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
/** A commission rate, 0–1. */
const rate = (name: string) => numeric(name, { precision: 7, scale: 6 });

// ------------------------------------------------------------------ service staff (ADR-0022 §2)

/**
 * The people who perform services at a branch, whether or not they sign in (a member may be linked).
 * Personal data: a name only (processing register). Archived, never deleted (sales name them).
 */
export const serviceStaff = pgTable(
  'service_staff',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    displayName: text('display_name').notNull(),
    membershipId: uuid('membership_id'),
    /** Their commission on what they sell or perform, unless a service sets its own (§5). */
    commissionRate: rate('commission_rate').notNull().default('0'),
    /** The calendar colour, `#rrggbb`. */
    color: text('color'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('service_staff_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.membershipId], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    // A member is one staff member at a time.
    uniqueIndex('service_staff_membership_once').on(t.tenantId, t.membershipId).where(sql`${t.membershipId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    index('service_staff_branch_idx').on(t.tenantId, t.branchId),
    check('service_staff_name_check', sql`length(btrim(${t.displayName})) BETWEEN 1 AND 80`),
    check('service_staff_rate_check', sql`${t.commissionRate} >= 0 AND ${t.commissionRate} <= 1`),
    check('service_staff_color_check', sql`${t.color} IS NULL OR ${t.color} ~ '^#[0-9a-f]{6}$'`),
  ],
);

/** The services a staff member does, each with an optional commission rate of its own. None listed = every service. */
export const serviceStaffServices = pgTable(
  'service_staff_services',
  {
    tenantId: uuid('tenant_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    commissionRate: rate('commission_rate'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.staffId, t.variantId] }),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [serviceStaff.tenantId, serviceStaff.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('service_staff_services_rate_check', sql`${t.commissionRate} IS NULL OR (${t.commissionRate} >= 0 AND ${t.commissionRate} <= 1)`),
  ],
);

/** Weekly working hours in the branch's calendar; several spans a day for split shifts, never overlapping (checked by the API). */
export const serviceStaffHours = pgTable(
  'service_staff_hours',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: smallint('weekday').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
  },
  (t) => [
    unique('service_staff_hours_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [serviceStaff.tenantId, serviceStaff.id] }),
    index('service_staff_hours_staff_idx').on(t.tenantId, t.staffId),
    check('service_staff_hours_weekday_check', sql`${t.weekday} BETWEEN 0 AND 6`),
    check('service_staff_hours_span_check', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** Leave, days off and breaks: the staff member cannot be booked in it (unless squeezed in, ADR-0022 §4). */
export const serviceStaffTimeOff = pgTable(
  'service_staff_time_off',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('service_staff_time_off_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [serviceStaff.tenantId, serviceStaff.id] }),
    index('service_staff_time_off_staff_idx').on(t.tenantId, t.staffId, t.startsAt),
    check('service_staff_time_off_span_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('service_staff_time_off_reason_check', sql`${t.reason} IS NULL OR length(${t.reason}) <= 200`),
  ],
);

// ------------------------------------------------------------------ appointments (ADR-0022 §4)

export const APPOINTMENT_STATUSES = ['BOOKED', 'ARRIVED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * A booking at a branch, for a customer or a guest by name. Operational, not books: changed in
 * place and audited. COMPLETED only by the sale that rang it up (`sale_id`, once).
 */
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    customerId: uuid('customer_id'),
    /** A walk-in or a caller who is not a customer yet. */
    guestName: text('guest_name'),
    status: text('status').$type<AppointmentStatus>().notNull().default('BOOKED'),
    /** The span of its services. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    notes: text('notes'),
    /** Email the customer the day before (ADR-0022 §10). */
    remind: boolean('remind').notNull().default(false),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    saleId: uuid('sale_id'),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('appointments_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    uniqueIndex('appointments_sale_once').on(t.tenantId, t.saleId).where(sql`${t.saleId} IS NOT NULL`),
    index('appointments_branch_time_idx').on(t.tenantId, t.branchId, t.startsAt),
    index('appointments_customer_idx').on(t.tenantId, t.customerId, t.startsAt).where(sql`${t.customerId} IS NOT NULL`),
    index('appointments_reminder_idx').on(t.startsAt).where(sql`${t.status} = 'BOOKED' AND ${t.remind} AND ${t.remindedAt} IS NULL`),
    check('appointments_status_check', sql`${t.status} IN ('BOOKED','ARRIVED','COMPLETED','NO_SHOW','CANCELLED')`),
    check('appointments_who_check', sql`${t.customerId} IS NOT NULL OR length(btrim(coalesce(${t.guestName}, ''))) BETWEEN 1 AND 120`),
    check('appointments_guest_name_check', sql`${t.guestName} IS NULL OR length(${t.guestName}) <= 120`),
    check('appointments_span_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('appointments_sale_check', sql`(${t.status} = 'COMPLETED') = (${t.saleId} IS NOT NULL)`),
    check('appointments_notes_check', sql`${t.notes} IS NULL OR length(${t.notes}) <= 500`),
    check('appointments_cancel_check', sql`${t.cancelReason} IS NULL OR length(${t.cancelReason}) <= 200`),
  ],
);

/**
 * The services of an appointment, each with its staff member and time. `active` rows of one staff
 * member never overlap (GiST exclusion constraint `appointment_services_no_double_booking`, migration
 * 0099); cancelling or a no-show clears `active`.
 */
export const appointmentServices = pgTable(
  'appointment_services',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    appointmentId: uuid('appointment_id').notNull(),
    position: integer('position').notNull(),
    variantId: uuid('variant_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    unique('appointment_services_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('appointment_services_position_unique').on(t.tenantId, t.appointmentId, t.position),
    foreignKey({ columns: [t.tenantId, t.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [serviceStaff.tenantId, serviceStaff.id] }),
    index('appointment_services_staff_idx').on(t.tenantId, t.staffId, t.startsAt),
    check('appointment_services_span_check', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

// ------------------------------------------------------------------ service packages (ADR-0022 §6)

/** What a PACKAGE item holds: sessions of services. Copied into each package sold, so changing it never touches packages already sold. */
export const servicePackageItems = pgTable(
  'service_package_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    packageVariantId: uuid('package_variant_id').notNull(),
    serviceVariantId: uuid('service_variant_id').notNull(),
    sessions: integer('sessions').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.packageVariantId, t.serviceVariantId] }),
    foreignKey({ columns: [t.tenantId, t.packageVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.serviceVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('service_package_items_sessions_check', sql`${t.sessions} BETWEEN 1 AND 1000`),
    check('service_package_items_not_itself', sql`${t.packageVariantId} <> ${t.serviceVariantId}`),
  ],
);

/**
 * One package a customer bought (a package line of quantity 2 makes two). `value` is what the
 * business owes for it ex VAT (*Prepaid service packages*) until its sessions are used. Append-only.
 */
export const customerPackages = pgTable(
  'customer_packages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    packageVariantId: uuid('package_variant_id').notNull(),
    name: text('name').notNull(),
    saleId: uuid('sale_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    /** 1…quantity of its sale line. */
    unitNo: integer('unit_no').notNull(),
    value: money('value').notNull(),
    expiresOn: date('expires_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Typed by hand: sale_lines points back here (`customer_package_id`), which TypeScript cannot infer in a cycle.
  (t): PgTableExtraConfigValue[] => [
    unique('customer_packages_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('customer_packages_unit_unique').on(t.tenantId, t.saleLineId, t.unitNo),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ columns: [t.tenantId, t.packageVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    index('customer_packages_customer_idx').on(t.tenantId, t.customerId),
    check('customer_packages_unit_check', sql`${t.unitNo} >= 1`),
    check('customer_packages_value_check', sql`${t.value} >= 0`),
  ],
);

/** The sessions of one service in a package sold, and their share of its value. Append-only. */
export const customerPackageItems = pgTable(
  'customer_package_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    customerPackageId: uuid('customer_package_id').notNull(),
    serviceVariantId: uuid('service_variant_id').notNull(),
    sessions: integer('sessions').notNull(),
    value: money('value').notNull(),
  },
  (t) => [
    unique('customer_package_items_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('customer_package_items_service_unique').on(t.tenantId, t.customerPackageId, t.serviceVariantId),
    foreignKey({ columns: [t.tenantId, t.customerPackageId], foreignColumns: [customerPackages.tenantId, customerPackages.id] }),
    foreignKey({ columns: [t.tenantId, t.serviceVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('customer_package_items_sessions_check', sql`${t.sessions} >= 1`),
    check('customer_package_items_value_check', sql`${t.value} >= 0`),
  ],
);

export const PACKAGE_ENTRY_KINDS = ['SOLD', 'REDEEMED', 'RESTORED', 'REFUNDED'] as const;
export type PackageEntryKind = (typeof PACKAGE_ENTRY_KINDS)[number];

/**
 * Sessions and value in and out of a package item. Append-only; an insert trigger serialises one
 * package's entries and refuses a balance below zero (`customer_package_balance`).
 */
export const customerPackageEntries = pgTable(
  'customer_package_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    customerPackageId: uuid('customer_package_id').notNull(),
    customerPackageItemId: uuid('customer_package_item_id').notNull(),
    kind: text('kind').$type<PackageEntryKind>().notNull(),
    /** Signed: + SOLD/RESTORED, − REDEEMED/REFUNDED. */
    sessions: integer('sessions').notNull(),
    value: money('value').notNull(),
    saleId: uuid('sale_id'),
    saleLineId: uuid('sale_line_id'),
    saleReturnId: uuid('sale_return_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_package_entries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.customerPackageId], foreignColumns: [customerPackages.tenantId, customerPackages.id] }),
    foreignKey({ columns: [t.tenantId, t.customerPackageItemId], foreignColumns: [customerPackageItems.tenantId, customerPackageItems.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    index('customer_package_entries_item_idx').on(t.tenantId, t.customerPackageItemId),
    index('customer_package_entries_package_idx').on(t.tenantId, t.customerPackageId),
    check('customer_package_entries_kind_check', sql`${t.kind} IN ('SOLD','REDEEMED','RESTORED','REFUNDED')`),
    check(
      'customer_package_entries_sign_check',
      sql`CASE WHEN ${t.kind} IN ('SOLD','RESTORED') THEN ${t.sessions} > 0 AND ${t.value} >= 0 ELSE ${t.sessions} < 0 AND ${t.value} <= 0 END`,
    ),
    check(
      'customer_package_entries_link_check',
      sql`CASE ${t.kind} WHEN 'SOLD' THEN ${t.saleLineId} IS NOT NULL AND ${t.saleReturnId} IS NULL
                         WHEN 'REDEEMED' THEN ${t.saleLineId} IS NOT NULL AND ${t.saleReturnId} IS NULL
                         ELSE ${t.saleReturnId} IS NOT NULL END`,
    ),
  ],
);

// ------------------------------------------------------------------ tips per staff (ADR-0022 §7)

/** A tip's split among the staff who served; the shares add up to the tip (deferred trigger). Append-only. */
export const saleTipShares = pgTable(
  'sale_tip_shares',
  {
    tenantId: uuid('tenant_id').notNull(),
    saleTipId: uuid('sale_tip_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.saleTipId, t.staffId] }),
    foreignKey({ columns: [t.tenantId, t.saleTipId], foreignColumns: [saleTips.tenantId, saleTips.id] }),
    foreignKey({ columns: [t.tenantId, t.staffId], foreignColumns: [serviceStaff.tenantId, serviceStaff.id] }),
    check('sale_tip_shares_amount_check', sql`${t.amount} > 0`),
  ],
);

// ------------------------------------------------------------------ client notes (ADR-0022 §8)

/**
 * What the business keeps about a client's services: colour formulas, preferences, allergies. May hold
 * health information (sensitive personal information): processing register §15a. Edited in place and
 * audited by id only; deleted when the customer is anonymised.
 */
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customer_notes_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('customer_notes_customer_idx').on(t.tenantId, t.customerId),
    check('customer_notes_body_check', sql`length(btrim(${t.body})) BETWEEN 1 AND 2000`),
  ],
);
