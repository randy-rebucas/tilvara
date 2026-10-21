import { z } from 'zod';

/** ADR-0025 §2: OTC, RX (prescription), ANTIBIOTIC (prescription), DANGEROUS (RA 9165: S2 licence and yellow form). */
export const DRUG_CLASS_VALUES = ['OTC', 'RX', 'ANTIBIOTIC', 'DANGEROUS'] as const;
export type DrugClassValue = (typeof DRUG_CLASS_VALUES)[number];
export const DOSAGE_FORM_VALUES = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'DROPS', 'CREAM', 'OINTMENT', 'INJECTION', 'INHALER', 'SACHET', 'OTHER'] as const;
export type DosageFormValue = (typeof DOSAGE_FORM_VALUES)[number];
/** Classes a sale line needs a prescription for (ADR-0025 §6). */
export const PRESCRIPTION_DRUG_CLASSES: readonly DrugClassValue[] = ['RX', 'ANTIBIOTIC', 'DANGEROUS'];
export const needsPrescription = (c: string | null | undefined): boolean => c === 'RX' || c === 'ANTIBIOTIC' || c === 'DANGEROUS';

const ref = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, digits, - or _');
const text = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const pieces = z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/, 'A quantity like 30 or 2.5').refine((v) => Number(v) > 0, 'More than zero');
const licence = z.string().trim().min(3).max(30);

/** A product's medicine details (ADR-0025 §2); `null` on an update makes it an ordinary item again. */
export const drugDetailsSchema = z.object({
  drugClass: z.enum(DRUG_CLASS_VALUES),
  genericName: text(200),
  /** "500 mg", "250 mg/5 mL". */
  strength: z.string().trim().max(60).nullable().optional(),
  dosageForm: z.enum(DOSAGE_FORM_VALUES),
  fdaRegistrationNo: z.string().trim().max(40).nullable().optional(),
});
export type DrugDetailsInput = z.infer<typeof drugDetailsSchema>;

/** What a prescription orders, in generic names (any brand with the same generic, strength and form fills it). */
export const prescriptionItemSchema = z.object({
  genericName: text(200),
  strength: z.string().trim().max(60).nullable().optional(),
  dosageForm: z.enum(DOSAGE_FORM_VALUES),
  /** In pieces (tablets, capsules, bottles). */
  quantity: pieces,
  drugClass: z.enum(DRUG_CLASS_VALUES),
  directions: z.string().trim().max(300).nullable().optional(),
});

const prescriptionFields = {
  customerId: z.uuid().nullable().optional(),
  patientName: text(200),
  patientAddress: z.string().trim().max(300).nullable().optional(),
  prescriberName: text(200),
  prescriberLicenseNo: licence,
  prescriberS2No: z.string().trim().max(30).nullable().optional(),
  yellowFormNo: z.string().trim().max(40).nullable().optional(),
  issuedOn: day,
  notes: z.string().trim().max(1000).nullable().optional(),
};

/** A dangerous drug's prescription names the S2 licence, the yellow form and the patient's address. */
function dangerousNeedsForms(v: { items: { drugClass: string }[]; prescriberS2No?: string | null | undefined; yellowFormNo?: string | null | undefined; patientAddress?: string | null | undefined }, ctx: z.RefinementCtx) {
  if (!v.items.some((i) => i.drugClass === 'DANGEROUS')) return;
  if (!v.prescriberS2No) ctx.addIssue({ code: 'custom', path: ['prescriberS2No'], message: 'A dangerous drug needs the prescriber\'s S2 licence number' });
  if (!v.yellowFormNo) ctx.addIssue({ code: 'custom', path: ['yellowFormNo'], message: 'A dangerous drug needs the yellow prescription form number' });
  if (!v.patientAddress) ctx.addIssue({ code: 'custom', path: ['patientAddress'], message: 'A dangerous drug needs the patient\'s address' });
}

/** Entered in the admin (or at the till before the sale) for a later fill. */
export const createPrescriptionSchema = z
  .object({ branchId: z.uuid(), ...prescriptionFields, items: z.array(prescriptionItemSchema).min(1).max(20) })
  .superRefine(dangerousNeedsForms);
export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;

/** Changed only until something is dispensed on it; `items` replaces them all. */
export const updatePrescriptionSchema = z
  .object({ ...prescriptionFields, items: z.array(prescriptionItemSchema).min(1).max(20) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdatePrescriptionInput = z.infer<typeof updatePrescriptionSchema>;

export const voidPrescriptionSchema = z.object({ reason: text(300) });
export type VoidPrescriptionInput = z.infer<typeof voidPrescriptionSchema>;

/** A prescription recorded with the sale (at the till, online or offline): client refs for it and its items. */
export const salePrescriptionSchema = z
  .object({ ref, ...prescriptionFields, items: z.array(prescriptionItemSchema.extend({ ref })).min(1).max(20) })
  .superRefine(dangerousNeedsForms)
  .refine((v) => new Set(v.items.map((i) => i.ref)).size === v.items.length, { message: 'Duplicate item ref', path: ['items'] });
export type SalePrescriptionInput = z.infer<typeof salePrescriptionSchema>;

/** Which prescription item a sale line fills: one on record, or one recorded with this sale. */
export const linePrescriptionSchema = z.union([
  z.object({ itemId: z.uuid() }),
  z.object({ prescriptionRef: ref, itemRef: ref }),
]);
export type LinePrescriptionInput = z.infer<typeof linePrescriptionSchema>;

export const prescriptionListQuerySchema = z.object({
  branchId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  /** Patient name, prescriber or yellow-form number. */
  q: z.string().trim().min(1).max(100).optional(),
  /** Only those with something left to dispense. */
  open: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type PrescriptionListQuery = z.infer<typeof prescriptionListQuerySchema>;

/**
 * A pharmacist's approval at the till for a cashier who may not dispense (ADR-0025 §6): without
 * credentials the person asking approves for themselves (needs `pharmacy.dispense`).
 */
export const createDispenseApprovalSchema = z
  .object({
    branchId: z.uuid(),
    email: z.email().optional(),
    password: z.string().min(1).max(128).optional(),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((v) => (v.email === undefined) === (v.password === undefined), { message: 'Email and password together', path: ['password'] });
export type CreateDispenseApprovalInput = z.infer<typeof createDispenseApprovalSchema>;

export const pharmacistLicenseSchema = z.object({
  licenseNo: licence,
  validUntil: day.nullable().optional(),
});
export type PharmacistLicenseInput = z.infer<typeof pharmacistLicenseSchema>;

export const pharmacySettingsSchema = z.object({ requirePurchaseBooklet: z.boolean() });
export type PharmacySettingsInput = z.infer<typeof pharmacySettingsSchema>;

export const createLotHoldSchema = z.object({
  variantId: z.uuid(),
  lotCode: text(64),
  /** Omitted: every branch. */
  branchId: z.uuid().optional(),
  reason: text(200),
  reference: z.string().trim().max(100).nullable().optional(),
});
export type CreateLotHoldInput = z.infer<typeof createLotHoldSchema>;
export const releaseLotHoldSchema = z.object({ reason: text(200) });
export type ReleaseLotHoldInput = z.infer<typeof releaseLotHoldSchema>;
export const lotHoldListQuerySchema = z.object({
  variantId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  includeReleased: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
export type LotHoldListQuery = z.infer<typeof lotHoldListQuerySchema>;

export const lotTraceQuerySchema = z.object({ variantId: z.uuid(), lotCode: text(64) });
export type LotTraceQuery = z.infer<typeof lotTraceQuerySchema>;

export const equivalentsQuerySchema = z.object({ branchId: z.uuid(), variantId: z.uuid() });
export type EquivalentsQuery = z.infer<typeof equivalentsQuerySchema>;
