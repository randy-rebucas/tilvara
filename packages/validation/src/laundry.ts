import { z } from 'zod';
import { amountSchema, MACHINE_KINDS } from './catalog.js';
import { clientRefSchema, tenderSchema } from './sales.js';
import { quantitySchema } from './tax.js';

// ------------------------------------------------------------------ laundromats and laundry shops (ADR-0024)

const localDate = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const positiveAmount = amountSchema.refine((v) => Number(v) > 0, 'Amount must be greater than zero');
const reason = z.string().trim().min(1).max(200);
const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Use a phone number such as 0917 123 4567');
const kilos = z.string().trim().regex(/^\d{1,6}(\.\d{1,3})?$/, 'Use kilos such as "5.250"');

export const SERVICE_LEVELS = ['REGULAR', 'EXPRESS'] as const;
export const JOB_ORDER_STATUSES = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY', 'CLAIMED', 'CANCELLED', 'DISPOSED'] as const;
export type JobOrderStatus = (typeof JOB_ORDER_STATUSES)[number];
/** The processing steps a person moves a job through (§3); READY → FOLDING is the one way back. */
export const JOB_ORDER_STEPS = ['WASHING', 'DRYING', 'FOLDING', 'READY'] as const;
export const TRIP_KINDS = ['PICKUP', 'DELIVERY'] as const;
export const TRIP_STATUSES = ['SCHEDULED', 'DONE', 'FAILED', 'CANCELLED'] as const;
export const DISPOSAL_REASONS = ['DONATED', 'DISCARDED', 'OTHER'] as const;

// ------------------------------------------------------------------ settings and set-up (§3, §6, §9)

export const laundrySettingsSchema = z
  .object({
    regularHours: z.number().int().min(1).max(720),
    expressHours: z.number().int().min(1).max(168),
    expressVariantId: z.uuid().nullable(),
    deliveryVariantId: z.uuid().nullable(),
    storageFeeVariantId: z.uuid().nullable(),
    /** Days after READY a job stays without a storage fee; null = never charged. */
    storageFreeDays: z.number().int().min(0).max(365).nullable(),
    unclaimedDays: z.number().int().min(7).max(365),
    finalNoticeDays: z.number().int().min(1).max(30),
    /** Days after READY a reminder goes out (each once). */
    reminderDays: z.array(z.number().int().min(1).max(365)).max(5).refine((d) => new Set(d).size === d.length, 'Each day once'),
    claimPolicyText: z.string().trim().max(1000).nullable(),
    smsEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine((v) => v.finalNoticeDays === undefined || v.unclaimedDays === undefined || v.finalNoticeDays < v.unclaimedDays, { message: 'Before the unclaimed day', path: ['finalNoticeDays'] });
export type LaundrySettingsInput = z.infer<typeof laundrySettingsSchema>;

export const createGarmentTypeSchema = z.object({ name: z.string().trim().min(1).max(60) });
export type CreateGarmentTypeInput = z.infer<typeof createGarmentTypeSchema>;
export const updateGarmentTypeSchema = z
  .object({ name: z.string().trim().min(1).max(60), archived: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateGarmentTypeInput = z.infer<typeof updateGarmentTypeSchema>;
export const garmentTypeListQuerySchema = z.object({ includeArchived: flag });
export type GarmentTypeListQuery = z.infer<typeof garmentTypeListQuerySchema>;

export const createMachineSchema = z.object({
  branchId: z.uuid(),
  kind: z.enum(MACHINE_KINDS),
  label: z.string().trim().min(1).max(30),
  capacityKg: kilos.optional(),
  cycleMinutes: z.number().int().min(1).max(240),
});
export type CreateMachineInput = z.infer<typeof createMachineSchema>;

export const updateMachineSchema = z
  .object({
    label: z.string().trim().min(1).max(30),
    capacityKg: kilos.nullable(),
    cycleMinutes: z.number().int().min(1).max(240),
    /** A reason takes it out of service; null puts it back. */
    outOfOrderReason: z.string().trim().min(1).max(200).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;

export const machineListQuerySchema = z.object({ branchId: z.uuid().optional(), includeArchived: flag });
export type MachineListQuery = z.infer<typeof machineListQuerySchema>;
export const machineBoardQuerySchema = z.object({ branchId: z.uuid() });
export type MachineBoardQuery = z.infer<typeof machineBoardQuerySchema>;

/** A drop-off load on a machine (§7). */
export const jobMachineRunSchema = z.object({ machineId: z.uuid(), minutes: z.number().int().min(1).max(240).optional() });
export type JobMachineRunInput = z.infer<typeof jobMachineRunSchema>;

// ------------------------------------------------------------------ job orders (§3)

export const jobOrderLineSchema = z.object({
  variantId: z.uuid(),
  /** What was weighed or counted; the billed quantity is at least the service's minimum. */
  quantity: quantitySchema,
  /** A session of the customer's laundry package (§10), priced at zero on the job. */
  packageId: z.uuid().optional(),
});
export type JobOrderLineInput = z.infer<typeof jobOrderLineSchema>;

export const jobOrderItemSchema = z
  .object({
    garmentTypeId: z.uuid().optional(),
    label: z.string().trim().min(1).max(60).optional(),
    count: z.number().int().min(1).max(999),
    note: z.string().trim().max(200).optional(),
  })
  .refine((i) => i.garmentTypeId !== undefined || i.label !== undefined, { message: 'Name the garment type', path: ['label'] });
export type JobOrderItemInput = z.infer<typeof jobOrderItemSchema>;

export const tripInputSchema = z
  .object({
    address: z.string().trim().min(1).max(300),
    contactPhone: phone,
    contactName: z.string().trim().min(1).max(120).optional(),
    windowStart: instant.optional(),
    windowEnd: instant.optional(),
    riderMemberId: z.uuid().optional(),
    riderName: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((t) => !t.windowStart || !t.windowEnd || t.windowStart < t.windowEnd, { message: 'The window ends after it starts', path: ['windowEnd'] });
export type TripInput = z.infer<typeof tripInputSchema>;

export const createJobOrderSchema = z
  .object({
    branchId: z.uuid(),
    customerId: z.uuid().optional(),
    customerName: z.string().trim().min(1).max(120).optional(),
    customerPhone: phone.optional(),
    serviceLevel: z.enum(SERVICE_LEVELS).default('REGULAR'),
    /** Omitted: drop-off time + the branch's regular or express hours. */
    promisedAt: instant.optional(),
    weightKg: kilos.optional(),
    bagCount: z.number().int().min(1).max(99).default(1),
    specialInstructions: z.string().trim().max(500).optional(),
    conditionNotes: z.string().trim().max(500).optional(),
    /** Ready notices and reminders (§6); default on. */
    notify: z.boolean().default(true),
    /** Empty only for a pickup: priced when weighed at the shop. */
    lines: z.array(jobOrderLineSchema).max(50).default([]),
    items: z.array(jobOrderItemSchema).max(50).default([]),
    pickup: tripInputSchema.optional(),
    delivery: tripInputSchema.optional(),
  })
  .refine((v) => v.customerId !== undefined || v.customerName !== undefined, { message: 'A customer or a name', path: ['customerName'] })
  .refine((v) => v.lines.length > 0 || v.pickup !== undefined, { message: 'Add what is to be done (or schedule a pickup)', path: ['lines'] });
export type CreateJobOrderInput = z.infer<typeof createJobOrderSchema>;

export const updateJobOrderSchema = z
  .object({
    customerId: z.uuid().nullable(),
    customerName: z.string().trim().min(1).max(120).nullable(),
    customerPhone: phone.nullable(),
    promisedAt: instant,
    bagCount: z.number().int().min(1).max(99),
    specialInstructions: z.string().trim().max(500).nullable(),
    conditionNotes: z.string().trim().max(500).nullable(),
    notify: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateJobOrderInput = z.infer<typeof updateJobOrderSchema>;

export const jobOrderLinesSchema = z.object({ lines: z.array(jobOrderLineSchema).min(1).max(50), weightKg: kilos.optional() });
export type JobOrderLinesInput = z.infer<typeof jobOrderLinesSchema>;
export const jobOrderItemsSchema = z.object({ items: z.array(jobOrderItemSchema).max(50) });
export type JobOrderItemsInput = z.infer<typeof jobOrderItemsSchema>;

export const jobOrderStatusSchema = z.object({ status: z.enum(JOB_ORDER_STEPS), note: z.string().trim().min(1).max(200).optional() });
export type JobOrderStatusInput = z.infer<typeof jobOrderStatusSchema>;

export const jobOrderListQuerySchema = z.object({
  branchId: z.uuid().optional(),
  status: z.enum(JOB_ORDER_STATUSES).optional(),
  /** Open jobs only (not claimed, cancelled or disposed). */
  open: flag,
  overdue: flag,
  unclaimed: flag,
  customerId: z.uuid().optional(),
  /** Number, claim code, name or phone. */
  q: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type JobOrderListQuery = z.infer<typeof jobOrderListQuerySchema>;

export const jobOrderLookupQuerySchema = z
  .object({ claimCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/).optional(), branchId: z.uuid().optional(), number: z.coerce.number().int().min(1).optional() })
  .refine((v) => v.claimCode !== undefined || (v.branchId !== undefined && v.number !== undefined), 'A claim code, or a branch and a job number');
export type JobOrderLookupQuery = z.infer<typeof jobOrderLookupQuerySchema>;

const depositRefund = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), cashierSessionId: z.uuid() }),
  z.object({ method: z.literal('BANK_TRANSFER'), reference: z.string().trim().min(1).max(64) }),
]);

/** `deposit`: give the down payment back (`refund` says how, needed when one is held) or keep it (`laundry.dispose`). */
export const cancelJobOrderSchema = z.object({ reason, deposit: z.enum(['refund', 'forfeit']).default('refund'), refund: depositRefund.optional() });
export type CancelJobOrderInput = z.infer<typeof cancelJobOrderSchema>;

/**
 * Disposal needs the final notice SENT (decision A4), or `customerUnreachable` with why (audited): no
 * contact on file, every channel failed, the number no longer in service.
 */
export const disposeJobOrderSchema = z
  .object({
    reason: z.enum(DISPOSAL_REASONS),
    note: z.string().trim().max(200).optional(),
    customerUnreachable: z.boolean().default(false),
    unreachableReason: z.string().trim().min(3).max(200).optional(),
  })
  .refine((v) => !v.customerUnreachable || v.unreachableReason !== undefined, { message: 'Say why the customer could not be reached', path: ['unreachableReason'] });
export type DisposeJobOrderInput = z.infer<typeof disposeJobOrderSchema>;

// ------------------------------------------------------------------ down payments and the claim (§5)

export const jobDepositSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), cashierSessionId: z.uuid(), amount: positiveAmount }),
  /** A card/QR payment taken at the counter for this job (purpose JOB_ORDER). */
  z.object({ method: z.literal('INTENT'), cashierSessionId: z.uuid(), paymentIntentId: z.uuid() }),
  z.object({ method: z.literal('BANK_TRANSFER'), amount: positiveAmount, reference: z.string().trim().min(1).max(64) }),
]);
export type JobDepositInput = z.infer<typeof jobDepositSchema>;

export const refundJobDepositSchema = z.object({ amount: positiveAmount.optional(), reason, refund: depositRefund });
export type RefundJobDepositInput = z.infer<typeof refundJobDepositSchema>;

export const claimJobOrderSchema = z
  .object({
    cashierSessionId: z.uuid(),
    clientTransactionId: clientRefSchema,
    /** For the balance after the down payment; none when it is paid already. */
    tenders: z.array(tenderSchema).max(10).default([]),
    expectedAmountDue: amountSchema.optional(),
    /** From the customer's stub. */
    claimCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/).optional(),
    /** No stub: `laundry.release_override`, with what was checked instead (never the ID number). */
    overrideReason: z.string().trim().min(1).max(200).optional(),
    /** Released by a rider at the door (§8): the trip is marked done with the claim. */
    releasedVia: z.enum(['COUNTER', 'DELIVERY']).default('COUNTER'),
  })
  .refine((v) => v.releasedVia === 'DELIVERY' || v.claimCode !== undefined || v.overrideReason !== undefined, { message: 'The claim code from the stub, or an override reason', path: ['claimCode'] })
  .refine((v) => v.tenders.filter((t) => t.method === 'STORE_CREDIT').length <= 1, { message: 'Store credit once per sale', path: ['tenders'] })
  .refine((v) => !v.tenders.some((t) => t.method === 'ROOM_CHARGE'), { message: 'A claim is not charged to a room', path: ['tenders'] });
export type ClaimJobOrderInput = z.infer<typeof claimJobOrderSchema>;

// ------------------------------------------------------------------ trips (§8)

export const createTripSchema = tripInputSchema.and(z.object({ kind: z.enum(TRIP_KINDS) }));
export type CreateTripInput = z.infer<typeof createTripSchema>;
export const updateTripSchema = z
  .object({
    address: z.string().trim().min(1).max(300),
    contactPhone: phone,
    contactName: z.string().trim().min(1).max(120).nullable(),
    windowStart: instant.nullable(),
    windowEnd: instant.nullable(),
    riderMemberId: z.uuid().nullable(),
    riderName: z.string().trim().min(1).max(80).nullable(),
    notes: z.string().trim().max(300).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTripInput = z.infer<typeof updateTripSchema>;
export const tripFailedSchema = z.object({ reason });
export const tripCancelSchema = z.object({ reason });
export type TripReasonInput = z.infer<typeof tripFailedSchema>;
/** Down payments held and unclaimed laundry per legal entity (§13). */
export const jobOrderDepositsQuerySchema = z.object({ legalEntityId: z.uuid() });
export type JobOrderDepositsQuery = z.infer<typeof jobOrderDepositsQuerySchema>;
export const tripListQuerySchema = z.object({ branchId: z.uuid(), date: localDate.optional(), status: z.enum(TRIP_STATUSES).optional() });
export type TripListQuery = z.infer<typeof tripListQuerySchema>;
