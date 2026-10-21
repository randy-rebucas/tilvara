import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';
import { customers } from './customers.js';
import { tenantMemberships } from './identity.js';
import { branches, legalEntities } from './organization.js';
import { tenants } from './platform.js';
import { saleLines, saleReturnLines, sales } from './sales.js';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

/** OTC, RX (prescription), ANTIBIOTIC (prescription, DOH antibiotic stewardship), DANGEROUS (RA 9165: S2 + yellow form). ADR-0025 §2. */
export const DRUG_CLASSES = ['OTC', 'RX', 'ANTIBIOTIC', 'DANGEROUS'] as const;
export type DrugClass = (typeof DRUG_CLASSES)[number];
export const DOSAGE_FORMS = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'DROPS', 'CREAM', 'OINTMENT', 'INJECTION', 'INHALER', 'SACHET', 'OTHER'] as const;
export type DosageForm = (typeof DOSAGE_FORMS)[number];
/** Classes that need a prescription at the sale (ADR-0025 §6). */
export const PRESCRIPTION_CLASSES: readonly DrugClass[] = ['RX', 'ANTIBIOTIC', 'DANGEROUS'];

/**
 * What makes two medicines equivalents (ADR-0025 §3): the same generic name, strength and dosage form,
 * compared without case or spaces ("Amoxicillin 500 mg capsule" = "amoxicillin 500MG capsule").
 * Products and prescription items keep it as a generated column.
 */
export const genericKeySql = (generic: string, strength: string, form: string) =>
  sql.raw(`lower(regexp_replace(btrim(${generic}), '\\s+', ' ', 'g')) || '|' || lower(regexp_replace(coalesce(${strength}, ''), '\\s+', '', 'g')) || '|' || coalesce(${form}, '')`);

// ------------------------------------------------------------------ settings and pharmacists

/** The business's pharmacy rules (ADR-0025 §8). No row: the defaults. */
export const pharmacySettings = pgTable(
  'pharmacy_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    /** An SC/PWD discount on a medicine needs the purchase booklet (assumption to be confirmed). */
    requirePurchaseBooklet: boolean('require_purchase_booklet').notNull().default(true),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * A member's pharmacist licence (PRC), needed to dispense dangerous drugs (ADR-0025 §6). Personal data
 * (processing register); changed in place, audited by field name.
 */
export const pharmacistLicenses = pgTable(
  'pharmacist_licenses',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    membershipId: uuid('membership_id').notNull(),
    licenseNo: text('license_no').notNull(),
    /** The licence's validity as printed on the PRC card; past it, the member cannot dispense dangerous drugs. */
    validUntil: date('valid_until'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pharmacist_licenses_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('pharmacist_licenses_membership_once').on(t.tenantId, t.membershipId),
    foreignKey({ columns: [t.tenantId, t.membershipId], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id] }),
    check('pharmacist_licenses_no_check', sql`length(btrim(${t.licenseNo})) BETWEEN 3 AND 30`),
  ],
);

// ------------------------------------------------------------------ prescriptions (ADR-0025 §6)

/**
 * A prescription presented at the pharmacy: who it is for and who wrote it. Health data: audited by id
 * only. Edited only until its first fill; voided only while nothing is dispensed on it (trigger).
 */
export const prescriptions = pgTable(
  'prescriptions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid('legal_entity_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    customerId: uuid('customer_id'),
    patientName: text('patient_name').notNull(),
    /** Required for a dangerous drug (yellow prescription). */
    patientAddress: text('patient_address'),
    prescriberName: text('prescriber_name').notNull(),
    /** PRC licence number of the physician, dentist or veterinarian. */
    prescriberLicenseNo: text('prescriber_license_no').notNull(),
    /** S2 licence number (PDEA), for a dangerous drug. */
    prescriberS2No: text('prescriber_s2_no'),
    /** Serial number of the DOH yellow prescription form, for a dangerous drug. */
    yellowFormNo: text('yellow_form_no'),
    issuedOn: date('issued_on').notNull(),
    notes: text('notes'),
    /** COUNTER (with a sale), ADMIN (entered beforehand), OFFLINE (recorded by an offline till). */
    source: text('source').notNull().default('COUNTER'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [
    unique('prescriptions_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index('prescriptions_customer_idx').on(t.tenantId, t.customerId).where(sql`${t.customerId} IS NOT NULL`),
    index('prescriptions_branch_idx').on(t.tenantId, t.branchId, t.createdAt),
    // One yellow form is one prescription (per legal entity).
    uniqueIndex('prescriptions_yellow_form_once').on(t.tenantId, t.legalEntityId, sql`upper(btrim(${t.yellowFormNo}))`).where(sql`${t.yellowFormNo} IS NOT NULL AND ${t.voidedAt} IS NULL`),
    check('prescriptions_names_check', sql`length(btrim(${t.patientName})) BETWEEN 1 AND 200 AND length(btrim(${t.prescriberName})) BETWEEN 1 AND 200 AND length(btrim(${t.prescriberLicenseNo})) BETWEEN 3 AND 30`),
    check('prescriptions_source_check', sql`${t.source} IN ('COUNTER','ADMIN','OFFLINE')`),
    check('prescriptions_void_check', sql`(${t.voidedAt} IS NULL) = (${t.voidedBy} IS NULL) AND (${t.voidedAt} IS NULL OR length(btrim(coalesce(${t.voidReason}, ''))) > 0)`),
  ],
);

/** What a prescription orders, in generic names; any brand with the same generic key fills it. */
export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    prescriptionId: uuid('prescription_id').notNull(),
    lineNo: integer('line_no').notNull(),
    genericName: text('generic_name').notNull(),
    strength: text('strength'),
    dosageForm: text('dosage_form').$type<DosageForm>().notNull(),
    genericKey: text('generic_key').generatedAlwaysAs(genericKeySql('generic_name', 'strength', 'dosage_form')).notNull(),
    /** In pieces (tablets, capsules, bottles): what may be dispensed in all. */
    quantity: qty('quantity').notNull(),
    drugClass: text('drug_class').$type<DrugClass>().notNull(),
    directions: text('directions'),
  },
  (t) => [
    unique('prescription_items_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('prescription_items_line_unique').on(t.tenantId, t.prescriptionId, t.lineNo),
    foreignKey({ columns: [t.tenantId, t.prescriptionId], foreignColumns: [prescriptions.tenantId, prescriptions.id] }),
    check('prescription_items_quantity_check', sql`${t.quantity} > 0`),
    check('prescription_items_generic_check', sql`length(btrim(${t.genericName})) BETWEEN 1 AND 200`),
    check('prescription_items_class_check', sql`${t.drugClass} IN ('OTC','RX','ANTIBIOTIC','DANGEROUS')`),
    check('prescription_items_form_check', sql`${t.dosageForm} IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','DROPS','CREAM','OINTMENT','INJECTION','INHALER','SACHET','OTHER')`),
  ],
);

/**
 * Each dispensing against a prescription item, in pieces: + with a sale line, − with a return or void
 * of it. Append-only; a trigger keeps Σ between 0 and what was prescribed (a dangerous drug in one full
 * fill), per item under a lock.
 */
export const prescriptionFills = pgTable(
  'prescription_fills',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    prescriptionId: uuid('prescription_id').notNull(),
    prescriptionItemId: uuid('prescription_item_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    saleId: uuid('sale_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    saleReturnLineId: uuid('sale_return_line_id'),
    variantId: uuid('variant_id').notNull(),
    /** Pieces, signed. */
    quantity: qty('quantity').notNull(),
    /** Pieces per unit sold (a strip of 10 → 10), kept so a return gives back the same pieces. */
    piecesPerUnit: qty('pieces_per_unit').notNull(),
    /** The pharmacist or member who dispensed it (the approver when the cashier could not). */
    dispensedBy: uuid('dispensed_by').notNull(),
    approvalId: uuid('approval_id'),
    /** Recorded from an offline till and failed a check (ADR-0025 §6): for the pharmacist to review. */
    needsReview: boolean('needs_review').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('prescription_fills_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.prescriptionId], foreignColumns: [prescriptions.tenantId, prescriptions.id] }),
    foreignKey({ columns: [t.tenantId, t.prescriptionItemId], foreignColumns: [prescriptionItems.tenantId, prescriptionItems.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.saleLineId], foreignColumns: [saleLines.tenantId, saleLines.id] }),
    foreignKey({ columns: [t.tenantId, t.saleReturnLineId], foreignColumns: [saleReturnLines.tenantId, saleReturnLines.id] }),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    foreignKey({ columns: [t.tenantId, t.approvalId], foreignColumns: [dispenseApprovals.tenantId, dispenseApprovals.id] }),
    index('prescription_fills_item_idx').on(t.tenantId, t.prescriptionItemId),
    index('prescription_fills_prescription_idx').on(t.tenantId, t.prescriptionId),
    index('prescription_fills_sale_line_idx').on(t.tenantId, t.saleLineId),
    index('prescription_fills_branch_idx').on(t.tenantId, t.branchId, t.createdAt),
    check('prescription_fills_sign', sql`${t.quantity} <> 0 AND (${t.quantity} > 0) = (${t.saleReturnLineId} IS NULL)`),
    check('prescription_fills_pieces_check', sql`${t.piecesPerUnit} > 0`),
  ],
);

/**
 * A pharmacist's approval at the till (ADR-0025 §6), for a cashier who may not dispense: checked with the
 * pharmacist's credentials like a price override, used once by one sale of that cashier within 30 minutes.
 */
export const dispenseApprovals = pgTable(
  'dispense_approvals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    approvedBy: uuid('approved_by').notNull(),
    approvalMethod: text('approval_method').notNull(),
    /** The approver may dispense dangerous drugs (permission and a valid licence at approval). */
    allowsDangerous: boolean('allows_dangerous').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set once, by the sale that used it. */
    saleId: uuid('sale_id'),
  },
  (t) => [
    unique('dispense_approvals_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    check('dispense_approvals_method_check', sql`${t.approvalMethod} IN ('SELF','CREDENTIALS')`),
  ],
);

// ------------------------------------------------------------------ lot holds (ADR-0025 §5)

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
