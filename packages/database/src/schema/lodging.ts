import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { customers } from './customers.js';
import { branches, legalEntities, registers } from './organization.js';
import { tenants } from './platform.js';
import { cashierSessions, paymentIntents, saleReturns, sales } from './sales.js';
import { taxProfiles } from './tax.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
const rate = (name: string) => numeric(name, { precision: 7, scale: 6 });

// ------------------------------------------------------------------ rooms (ADR-0023 §2, §9)

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

/**
 * A kind of room, business-wide. Its room night is an ordinary SERVICE item (`night_variant_id`): the
 * item's branch price is the rack rate per night and its tax category decides VAT.
 */
export const roomTypes = pgTable(
  'room_types',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    baseOccupancy: smallint('base_occupancy').notNull().default(2),
    maxOccupancy: smallint('max_occupancy').notNull().default(2),
    nightVariantId: uuid('night_variant_id').notNull(),
    /** A trial sample (removed with the sample items). */
    isSample: boolean('is_sample').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('room_types_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.nightVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    uniqueIndex('room_types_code_active_unique').on(t.tenantId, t.code).where(sql`${t.archivedAt} IS NULL`),
    check('room_types_code_check', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'`),
    check('room_types_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('room_types_occupancy_check', sql`${t.baseOccupancy} BETWEEN 1 AND 20 AND ${t.maxOccupancy} BETWEEN ${t.baseOccupancy} AND 20`),
  ],
);

/** A room of a branch. Archived, never deleted (stays name it). Status changes are `room_status_changes` rows. */
export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    roomTypeId: uuid('room_type_id').notNull(),
    number: text('number').notNull(),
    floor: text('floor'),
    notes: text('notes'),
    housekeepingStatus: text('housekeeping_status').$type<HousekeepingStatus>().notNull().default('CLEAN'),
    isSample: boolean('is_sample').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rooms_tenant_id_id_unique').on(t.tenantId, t.id),
    // Stays and blocks name the room with its branch, so a stay is always at its room's branch.
    unique('rooms_tenant_branch_id_unique').on(t.tenantId, t.branchId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.roomTypeId], foreignColumns: [roomTypes.tenantId, roomTypes.id] }),
    uniqueIndex('rooms_number_active_unique').on(t.tenantId, t.branchId, sql`lower(${t.number})`).where(sql`${t.archivedAt} IS NULL`),
    check('rooms_number_check', sql`length(btrim(${t.number})) BETWEEN 1 AND 20`),
    check('rooms_floor_check', sql`${t.floor} IS NULL OR length(${t.floor}) <= 20`),
    check('rooms_notes_check', sql`${t.notes} IS NULL OR length(${t.notes}) <= 500`),
    check('rooms_status_check', sql`${t.housekeepingStatus} IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER')`),
  ],
);

/** Nights a room cannot be sold (`starts_on` … the night before `ends_on`); take part in the no-double-booking rule. */
export const roomBlocks = pgTable(
  'room_blocks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    roomId: uuid('room_id').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('room_blocks_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId, t.roomId], foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id] }),
    index('room_blocks_room_idx').on(t.tenantId, t.roomId, t.startsOn),
    check('room_blocks_span_check', sql`${t.endsOn} > ${t.startsOn}`),
    check('room_blocks_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 200`),
  ],
);

/** Who changed a room's housekeeping status, when, and why (append-only): the board's history. */
export const roomStatusChanges = pgTable(
  'room_status_changes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    roomId: uuid('room_id').notNull(),
    fromStatus: text('from_status').$type<HousekeepingStatus>().notNull(),
    toStatus: text('to_status').$type<HousekeepingStatus>().notNull(),
    note: text('note'),
    /** Set when a check-out made the room dirty. */
    stayId: uuid('stay_id'),
    changedBy: uuid('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('room_status_changes_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.roomId], foreignColumns: [rooms.tenantId, rooms.id] }),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    index('room_status_changes_room_idx').on(t.tenantId, t.roomId, t.changedAt),
    check('room_status_changes_status_check', sql`${t.fromStatus} IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER') AND ${t.toStatus} IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER')`),
    check('room_status_changes_note_check', sql`${t.note} IS NULL OR length(${t.note}) <= 200`),
  ],
);

/** Per branch: when nights are charged (§7), the local accommodation tax (§10), the cancellation default (§6). */
export const lodgingSettings = pgTable(
  'lodging_settings',
  {
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    nightAuditTime: time('night_audit_time').notNull().default('03:00'),
    accommodationTaxRate: rate('accommodation_tax_rate'),
    forfeitOnCancel: boolean('forfeit_on_cancel').notNull().default(true),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check('lodging_settings_tax_rate_check', sql`${t.accommodationTaxRate} IS NULL OR (${t.accommodationTaxRate} >= 0 AND ${t.accommodationTaxRate} <= 0.2)`),
  ],
);

// ------------------------------------------------------------------ stays (§3, §4)

export const STAY_STATUSES = ['BOOKED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];

/**
 * A booking of a room over dates of the branch's calendar (`departure_date` exclusive). Operational:
 * changed in place and audited; a trigger keeps the status moves (BOOKED → IN_HOUSE → CHECKED_OUT, or
 * CANCELLED / NO_SHOW). Active stays (BOOKED, IN_HOUSE) of one room never overlap each other or a
 * block (GiST exclusion + trigger, migration 0102). The folio is the financial record.
 */
export const stays = pgTable(
  'stays',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    roomId: uuid('room_id').notNull(),
    roomTypeId: uuid('room_type_id').notNull(),
    customerId: uuid('customer_id'),
    /** A walk-in or a caller who is not a customer (yet). */
    guestName: text('guest_name'),
    arrivalDate: date('arrival_date').notNull(),
    departureDate: date('departure_date').notNull(),
    adults: smallint('adults').notNull().default(1),
    children: smallint('children').notNull().default(0),
    status: text('status').$type<StayStatus>().notNull().default('BOOKED'),
    /** The agreed gross rate per night (as the entity's prices are shown); null = the branch price of the room night each night. */
    nightlyRate: money('nightly_rate'),
    allowCharges: boolean('allow_charges').notNull().default(true),
    /** Outlet charges to the room, net of returns, may not exceed this; null = no limit. */
    chargeLimit: money('charge_limit'),
    source: text('source').notNull().default('WALK_IN'),
    externalReference: text('external_reference'),
    notes: text('notes'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: uuid('checked_in_by'),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutBy: uuid('checked_out_by'),
    /** Why it was cancelled or marked a no-show. */
    cancelReason: text('cancel_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
  },
  (t) => [
    unique('stays_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.roomId], foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id] }),
    foreignKey({ columns: [t.tenantId, t.roomTypeId], foreignColumns: [roomTypes.tenantId, roomTypes.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('stays_branch_dates_idx').on(t.tenantId, t.branchId, t.arrivalDate),
    index('stays_in_house_idx').on(t.tenantId, t.legalEntityId).where(sql`${t.status} = 'IN_HOUSE'`),
    index('stays_customer_idx').on(t.tenantId, t.customerId).where(sql`${t.customerId} IS NOT NULL`),
    check('stays_status_check', sql`${t.status} IN ('BOOKED','IN_HOUSE','CHECKED_OUT','CANCELLED','NO_SHOW')`),
    check('stays_dates_check', sql`${t.departureDate} > ${t.arrivalDate}`),
    check('stays_guests_check', sql`${t.adults} BETWEEN 1 AND 20 AND ${t.children} BETWEEN 0 AND 20`),
    check('stays_who_check', sql`${t.customerId} IS NOT NULL OR length(btrim(coalesce(${t.guestName}, ''))) BETWEEN 1 AND 120`),
    check('stays_guest_name_check', sql`${t.guestName} IS NULL OR length(${t.guestName}) <= 120`),
    check('stays_rate_check', sql`${t.nightlyRate} IS NULL OR ${t.nightlyRate} >= 0`),
    check('stays_limit_check', sql`${t.chargeLimit} IS NULL OR ${t.chargeLimit} >= 0`),
    check('stays_source_check', sql`${t.source} IN ('WALK_IN','PHONE','ONLINE','OTA','OTHER')`),
    check('stays_reference_check', sql`${t.externalReference} IS NULL OR length(${t.externalReference}) <= 64`),
    check('stays_notes_check', sql`${t.notes} IS NULL OR length(${t.notes}) <= 500`),
    check('stays_in_house_check', sql`${t.status} NOT IN ('IN_HOUSE','CHECKED_OUT') OR (${t.checkedInAt} IS NOT NULL AND ${t.checkedInBy} IS NOT NULL)`),
    check('stays_checked_out_check', sql`(${t.status} = 'CHECKED_OUT') = (${t.checkedOutAt} IS NOT NULL)`),
    check('stays_cancel_check', sql`(${t.status} IN ('CANCELLED','NO_SHOW')) = (${t.cancelledAt} IS NOT NULL AND length(btrim(coalesce(${t.cancelReason}, ''))) BETWEEN 1 AND 200)`),
  ],
);

/**
 * The guest registry (§8): who stayed, as the registration card records them. Personal data
 * (processing register §16): audited by field name only; deleted when the stay's customer is anonymised.
 */
export const stayGuests = pgTable(
  'stay_guests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    stayId: uuid('stay_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    fullName: text('full_name').notNull(),
    nationality: text('nationality'),
    idType: text('id_type'),
    idNumber: text('id_number'),
    address: text('address'),
    birthDate: date('birth_date'),
    contact: text('contact'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stay_guests_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    uniqueIndex('stay_guests_one_primary').on(t.tenantId, t.stayId).where(sql`${t.isPrimary}`),
    index('stay_guests_stay_idx').on(t.tenantId, t.stayId),
    check('stay_guests_name_check', sql`length(btrim(${t.fullName})) BETWEEN 1 AND 120`),
    check('stay_guests_lengths_check', sql`coalesce(length(${t.nationality}), 0) <= 60 AND coalesce(length(${t.idType}), 0) <= 40 AND coalesce(length(${t.idNumber}), 0) <= 64
      AND coalesce(length(${t.address}), 0) <= 300 AND coalesce(length(${t.contact}), 0) <= 120`),
  ],
);

/**
 * SC/PWD guests of a stay (§7, RA 9994 / RA 10754): each night applies the statutory discount to their
 * share (null = 1 ÷ guests in the room). Kept once a night used them (the SC/PWD book names them);
 * `removed_at` stops them counting for later nights.
 */
export const stayBeneficiaries = pgTable(
  'stay_beneficiaries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    stayId: uuid('stay_id').notNull(),
    schemeCode: text('scheme_code').notNull(),
    name: text('name').notNull(),
    idNumber: text('id_number').notNull(),
    share: rate('share'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    unique('stay_beneficiaries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    index('stay_beneficiaries_stay_idx').on(t.tenantId, t.stayId),
    check('stay_beneficiaries_share_check', sql`${t.share} IS NULL OR (${t.share} > 0 AND ${t.share} <= 1)`),
    check('stay_beneficiaries_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 200 AND length(btrim(${t.idNumber})) BETWEEN 1 AND 64`),
  ],
);

// ------------------------------------------------------------------ folios (§5)

/** A stay's guest ledger, in its branch's legal entity: OPEN until check-out settles it (then no more entries). */
export const folios = pgTable(
  'folios',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    stayId: uuid('stay_id').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('PHP'),
    status: text('status').notNull().default('OPEN'),
    openedBy: uuid('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    settledBy: uuid('settled_by'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    unique('folios_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('folios_stay_unique').on(t.tenantId, t.stayId),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    index('folios_open_idx').on(t.tenantId, t.legalEntityId).where(sql`${t.status} = 'OPEN'`),
    check('folios_status_check', sql`${t.status} IN ('OPEN','SETTLED')`),
    check('folios_settled_check', sql`(${t.status} = 'SETTLED') = (${t.settledAt} IS NOT NULL)`),
  ],
);

export const FOLIO_PAYMENT_METHODS = ['CASH', 'CARD', 'QR', 'EWALLET', 'STORE_CREDIT', 'BANK_TRANSFER'] as const;

/**
 * A settlement at the front desk (§5.2), at an open cashier session: cash (with change), a card/QR
 * payment (consumed once), the stay's customer's store credit, or a bank transfer (no drawer effect).
 * Append-only; its PAYMENT folio entry and its journal entry are written with it.
 */
export const folioPayments = pgTable(
  'folio_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    folioId: uuid('folio_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    cashierSessionId: uuid('cashier_session_id').notNull(),
    method: text('method').notNull(),
    /** Applied to the folio. */
    amount: money('amount').notNull(),
    tendered: money('tendered').notNull(),
    change: money('change').notNull().default('0'),
    paymentIntentId: uuid('payment_intent_id'),
    reference: text('reference'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('folio_payments_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.folioId], foreignColumns: [folios.tenantId, folios.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    uniqueIndex('folio_payments_intent_once').on(t.tenantId, t.paymentIntentId).where(sql`${t.paymentIntentId} IS NOT NULL`),
    index('folio_payments_folio_idx').on(t.tenantId, t.folioId),
    index('folio_payments_session_idx').on(t.tenantId, t.cashierSessionId),
    check('folio_payments_method_check', sql`${t.method} IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT','BANK_TRANSFER')`),
    check('folio_payments_intent_check', sql`(${t.method} IN ('CARD','QR','EWALLET')) = (${t.paymentIntentId} IS NOT NULL)`),
    check('folio_payments_reference_check', sql`(${t.method} = 'BANK_TRANSFER') = (${t.reference} IS NOT NULL) AND coalesce(length(${t.reference}), 0) <= 64`),
    check('folio_payments_amounts_check', sql`${t.amount} > 0 AND ${t.change} >= 0 AND ${t.tendered} - ${t.change} = ${t.amount} AND (${t.method} = 'CASH' OR ${t.change} = 0)`),
  ],
);

export const DEPOSIT_KINDS = ['RECEIVED', 'APPLIED', 'REFUNDED', 'FORFEITED'] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];

/**
 * Booking deposits (§6), append-only and signed: RECEIVED (+), APPLIED onto the folio (−), REFUNDED (−),
 * FORFEITED (−). A stay never holds less than zero (insert trigger, per-stay lock). Held without VAT.
 */
export const stayDeposits = pgTable(
  'stay_deposits',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    stayId: uuid('stay_id').notNull(),
    folioId: uuid('folio_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').$type<DepositKind>().notNull(),
    amount: money('amount').notNull(),
    /** RECEIVED / REFUNDED: CASH, CARD, QR, EWALLET or BANK_TRANSFER. */
    method: text('method'),
    cashierSessionId: uuid('cashier_session_id'),
    paymentIntentId: uuid('payment_intent_id'),
    reference: text('reference'),
    reason: text('reason'),
    /** FORFEITED: the cancellation fee's split (computed by @1pos/tax with the room night's category). */
    netAmount: money('net_amount'),
    vatAmount: money('vat_amount'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stay_deposits_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    foreignKey({ columns: [t.tenantId, t.folioId], foreignColumns: [folios.tenantId, folios.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    foreignKey({ columns: [t.tenantId, t.paymentIntentId], foreignColumns: [paymentIntents.tenantId, paymentIntents.id] }),
    uniqueIndex('stay_deposits_intent_once').on(t.tenantId, t.paymentIntentId).where(sql`${t.paymentIntentId} IS NOT NULL`),
    index('stay_deposits_stay_idx').on(t.tenantId, t.stayId),
    check('stay_deposits_kind_check', sql`${t.kind} IN ('RECEIVED','APPLIED','REFUNDED','FORFEITED')`),
    check('stay_deposits_sign_check', sql`CASE WHEN ${t.kind} = 'RECEIVED' THEN ${t.amount} > 0 ELSE ${t.amount} < 0 END`),
    check(
      'stay_deposits_method_check',
      sql`CASE WHEN ${t.kind} IN ('RECEIVED','REFUNDED') THEN ${t.method} IN ('CASH','CARD','QR','EWALLET','BANK_TRANSFER') ELSE ${t.method} IS NULL END
          AND (${t.method} IS DISTINCT FROM 'CASH' OR ${t.cashierSessionId} IS NOT NULL)
          AND coalesce(${t.method} IN ('CARD','QR','EWALLET'), false) = (${t.paymentIntentId} IS NOT NULL)
          AND coalesce(${t.method} = 'BANK_TRANSFER', false) = (${t.reference} IS NOT NULL)`,
    ),
    check('stay_deposits_refund_check', sql`${t.kind} <> 'REFUNDED' OR ${t.method} IN ('CASH','BANK_TRANSFER')`),
    check('stay_deposits_forfeit_check', sql`(${t.kind} = 'FORFEITED') = (${t.netAmount} IS NOT NULL AND ${t.vatAmount} IS NOT NULL)`),
    check('stay_deposits_text_check', sql`coalesce(length(${t.reference}), 0) <= 64 AND coalesce(length(${t.reason}), 0) <= 200`),
  ],
);

export const FOLIO_ENTRY_KINDS = ['ROOM_NIGHT', 'ACCOMMODATION_TAX', 'CHARGE', 'CHARGE_RETURN', 'DEPOSIT_APPLIED', 'PAYMENT', 'ADJUSTMENT', 'NIGHT_REVERSAL'] as const;
export type FolioEntryKind = (typeof FOLIO_ENTRY_KINDS)[number];

/**
 * The guest ledger's lines (§5), append-only. `amount` is signed: + the guest owes more. A room night,
 * an adjustment and a reversal carry their tax buckets (from @1pos/tax, signed with the amount) and
 * snapshots; a charge or its return points at the sale or the return; a payment at its `folio_payments`
 * row; a deposit applied at its `stay_deposits` row. One ROOM_NIGHT per (stay, night); a reversal undoes
 * one entry once. Inserts are serialised per folio and refused on a settled folio (trigger, 0102).
 */
export const folioEntries = pgTable(
  'folio_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    folioId: uuid('folio_id').notNull(),
    stayId: uuid('stay_id').notNull(),
    kind: text('kind').$type<FolioEntryKind>().notNull(),
    amount: money('amount').notNull(),
    /** ROOM_NIGHT (and its tax and reversal): the night, a date of the branch's calendar. */
    nightDate: date('night_date'),
    description: text('description'),
    reason: text('reason'),
    // Tax buckets (signed like `amount`), for ROOM_NIGHT, ADJUSTMENT and NIGHT_REVERSAL of a night.
    gross: money('gross'),
    discount: money('discount'),
    statutoryDiscount: money('statutory_discount'),
    vatExemptionAmount: money('vat_exemption_amount'),
    vatableSales: money('vatable_sales'),
    vatAmount: money('vat_amount'),
    vatExemptSales: money('vat_exempt_sales'),
    zeroRatedSales: money('zero_rated_sales'),
    percentageTaxSales: money('percentage_tax_sales'),
    /** The rate charged for the night (gross per night, as prices are shown) and what it came from. */
    unitPrice: money('unit_price'),
    variantId: uuid('variant_id'),
    taxCategoryCode: text('tax_category_code'),
    vatTreatment: text('vat_treatment'),
    taxProfileId: uuid('tax_profile_id'),
    /** The tax profile and line computation (incl. SC/PWD beneficiaries by id and share). */
    taxSnapshot: jsonb('tax_snapshot'),
    saleId: uuid('sale_id'),
    saleReturnId: uuid('sale_return_id'),
    folioPaymentId: uuid('folio_payment_id'),
    stayDepositId: uuid('stay_deposit_id'),
    /** NIGHT_REVERSAL: the entry it undoes; ACCOMMODATION_TAX: the night it is levied on. */
    relatedEntryId: uuid('related_entry_id'),
    /** The journal date its posting used (a night in a closed month is booked on the first open day after it). */
    journalDate: date('journal_date'),
    /** Null: the night audit (system). */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('folio_entries_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.folioId], foreignColumns: [folios.tenantId, folios.id] }),
    foreignKey({ columns: [t.tenantId, t.stayId], foreignColumns: [stays.tenantId, stays.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.taxProfileId], foreignColumns: [taxProfiles.tenantId, taxProfiles.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleReturnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
    foreignKey({ columns: [t.tenantId, t.folioPaymentId], foreignColumns: [folioPayments.tenantId, folioPayments.id] }),
    foreignKey({ columns: [t.tenantId, t.stayDepositId], foreignColumns: [stayDeposits.tenantId, stayDeposits.id] }),
    foreignKey({ columns: [t.tenantId, t.relatedEntryId], foreignColumns: [t.tenantId, t.id] }),
    uniqueIndex('folio_entries_night_once').on(t.tenantId, t.stayId, t.nightDate).where(sql`${t.kind} = 'ROOM_NIGHT'`),
    uniqueIndex('folio_entries_night_tax_once').on(t.tenantId, t.relatedEntryId).where(sql`${t.kind} = 'ACCOMMODATION_TAX'`),
    uniqueIndex('folio_entries_reversal_once').on(t.tenantId, t.relatedEntryId).where(sql`${t.kind} = 'NIGHT_REVERSAL'`),
    uniqueIndex('folio_entries_charge_once').on(t.tenantId, t.saleId).where(sql`${t.kind} = 'CHARGE'`),
    uniqueIndex('folio_entries_charge_return_once').on(t.tenantId, t.saleReturnId).where(sql`${t.kind} = 'CHARGE_RETURN'`),
    uniqueIndex('folio_entries_payment_once').on(t.tenantId, t.folioPaymentId).where(sql`${t.folioPaymentId} IS NOT NULL`),
    uniqueIndex('folio_entries_deposit_once').on(t.tenantId, t.stayDepositId).where(sql`${t.stayDepositId} IS NOT NULL`),
    index('folio_entries_folio_idx').on(t.tenantId, t.folioId),
    index('folio_entries_night_idx').on(t.tenantId, t.nightDate).where(sql`${t.nightDate} IS NOT NULL`),
    check('folio_entries_kind_check', sql`${t.kind} IN ('ROOM_NIGHT','ACCOMMODATION_TAX','CHARGE','CHARGE_RETURN','DEPOSIT_APPLIED','PAYMENT','ADJUSTMENT','NIGHT_REVERSAL')`),
    check(
      'folio_entries_sign_check',
      sql`CASE WHEN ${t.kind} IN ('ROOM_NIGHT','CHARGE') THEN ${t.amount} >= 0
               WHEN ${t.kind} = 'ACCOMMODATION_TAX' THEN ${t.amount} > 0
               WHEN ${t.kind} IN ('CHARGE_RETURN','DEPOSIT_APPLIED','PAYMENT','NIGHT_REVERSAL') THEN ${t.amount} < 0
               ELSE ${t.amount} <> 0 END`,
    ),
    check(
      'folio_entries_link_check',
      sql`CASE ${t.kind}
            WHEN 'ROOM_NIGHT' THEN ${t.nightDate} IS NOT NULL AND ${t.variantId} IS NOT NULL AND ${t.taxProfileId} IS NOT NULL AND ${t.relatedEntryId} IS NULL
            WHEN 'ACCOMMODATION_TAX' THEN ${t.nightDate} IS NOT NULL AND ${t.relatedEntryId} IS NOT NULL
            WHEN 'CHARGE' THEN ${t.saleId} IS NOT NULL AND ${t.saleReturnId} IS NULL
            WHEN 'CHARGE_RETURN' THEN ${t.saleReturnId} IS NOT NULL AND ${t.saleId} IS NOT NULL
            WHEN 'DEPOSIT_APPLIED' THEN ${t.stayDepositId} IS NOT NULL
            WHEN 'PAYMENT' THEN ${t.folioPaymentId} IS NOT NULL
            WHEN 'ADJUSTMENT' THEN ${t.reason} IS NOT NULL AND ${t.taxProfileId} IS NOT NULL
            WHEN 'NIGHT_REVERSAL' THEN ${t.relatedEntryId} IS NOT NULL AND ${t.reason} IS NOT NULL END`,
    ),
    check('folio_entries_text_check', sql`coalesce(length(${t.reason}), 0) <= 200 AND coalesce(length(${t.description}), 0) <= 120`),
  ],
);
