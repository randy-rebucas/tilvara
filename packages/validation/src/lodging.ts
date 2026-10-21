import { z } from 'zod';
import { amountSchema } from './catalog.js';
import { rateSchema } from './tax.js';

// ------------------------------------------------------------------ hotels, resorts, transient houses (ADR-0023)

const localDate = z.iso.date();
const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as "03:00"');
const positiveAmount = amountSchema.refine((v) => Number(v) > 0, 'Amount must be greater than zero');
/** A signed, non-zero amount ("-250.00" a credit to the guest, "150.00" a fee). */
const signedAmount = z
  .string()
  .trim()
  .regex(/^-?\d{1,16}(\.\d{1,4})?$/, 'Use a decimal string such as "150.00" or "-250.00"')
  .refine((v) => Number(v) !== 0, 'Amount must not be zero');
const reason = z.string().trim().min(1).max(200);
const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const roomCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use up to 20 letters, digits, - or _');

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'] as const;
export const STAY_STATUSES = ['BOOKED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export const STAY_SOURCES = ['WALK_IN', 'PHONE', 'ONLINE', 'OTA', 'OTHER'] as const;

// ------------------------------------------------------------------ room types and rooms (§2)

export const createRoomTypeSchema = z
  .object({
    code: roomCode,
    name: z.string().trim().min(1).max(80),
    baseOccupancy: z.number().int().min(1).max(20).default(2),
    maxOccupancy: z.number().int().min(1).max(20).optional(),
    /** An existing SERVICE item whose branch price is the rack rate per night. */
    nightVariantId: z.uuid().optional(),
    /** Or: make the room-night item now at this rack rate (default price list), VAT category unless `taxCategoryId`. */
    rackRate: positiveAmount.optional(),
    taxCategoryId: z.uuid().optional(),
  })
  .refine((v) => (v.nightVariantId === undefined) !== (v.rackRate === undefined), { message: 'Give either the room-night item or a rack rate', path: ['rackRate'] })
  .refine((v) => v.maxOccupancy === undefined || v.maxOccupancy >= v.baseOccupancy, { message: 'At least the base occupancy', path: ['maxOccupancy'] });
export type CreateRoomTypeInput = z.infer<typeof createRoomTypeSchema>;

export const updateRoomTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseOccupancy: z.number().int().min(1).max(20),
    maxOccupancy: z.number().int().min(1).max(20),
    nightVariantId: z.uuid(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateRoomTypeInput = z.infer<typeof updateRoomTypeSchema>;

export const createRoomSchema = z.object({
  branchId: z.uuid(),
  roomTypeId: z.uuid(),
  number: z.string().trim().min(1).max(20),
  floor: z.string().trim().min(1).max(20).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z
  .object({
    roomTypeId: z.uuid(),
    number: z.string().trim().min(1).max(20),
    floor: z.string().trim().min(1).max(20).nullable(),
    notes: z.string().trim().max(500).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

export const roomListQuerySchema = z.object({ branchId: z.uuid().optional(), includeArchived: flag });
export type RoomListQuery = z.infer<typeof roomListQuerySchema>;

export const roomTypeListQuerySchema = z.object({ includeArchived: flag });
export type RoomTypeListQuery = z.infer<typeof roomTypeListQuerySchema>;

/** Housekeeping (§9): a status change, with a reason when the room goes out of order. */
export const roomStatusSchema = z
  .object({ status: z.enum(HOUSEKEEPING_STATUSES), note: z.string().trim().min(1).max(200).optional() })
  .refine((v) => v.status !== 'OUT_OF_ORDER' || v.note !== undefined, { message: 'Say why the room is out of order', path: ['note'] });
export type RoomStatusInput = z.infer<typeof roomStatusSchema>;

/** Dates a room cannot be sold (out of order, repairs): nights `startsOn` … the night before `endsOn`. */
export const createRoomBlockSchema = z
  .object({ roomId: z.uuid(), startsOn: localDate, endsOn: localDate, reason })
  .refine((v) => v.endsOn > v.startsOn, { message: 'Ends after it starts', path: ['endsOn'] });
export type CreateRoomBlockInput = z.infer<typeof createRoomBlockSchema>;

export const roomBlockListQuerySchema = z.object({ branchId: z.uuid(), from: localDate.optional(), to: localDate.optional() });
export type RoomBlockListQuery = z.infer<typeof roomBlockListQuerySchema>;

export const housekeepingQuerySchema = z.object({ branchId: z.uuid() });
export type HousekeepingQuery = z.infer<typeof housekeepingQuerySchema>;

/** Per branch (§7, §10, §6): when nights are charged, the local accommodation tax, the cancellation default. */
export const lodgingSettingsSchema = z
  .object({
    nightAuditTime: hhmm,
    /** On the room night's net ex VAT; null = none. Confirm the rate and base with a tax adviser per LGU. */
    accommodationTaxRate: rateSchema.refine((v) => Number(v) <= 0.2, 'At most 0.2').nullable(),
    /** Cancellations and no-shows keep the deposit unless the request says refund. */
    forfeitOnCancel: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type LodgingSettingsInput = z.infer<typeof lodgingSettingsSchema>;

// ------------------------------------------------------------------ stays (§3, §4, §8)

export const stayGuestSchema = z.object({
  isPrimary: z.boolean().default(false),
  fullName: z.string().trim().min(1).max(120),
  nationality: z.string().trim().min(1).max(60).optional(),
  /** Passport, driver's licence, UMID… */
  idType: z.string().trim().min(1).max(40).optional(),
  idNumber: z.string().trim().min(1).max(64).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  birthDate: localDate.optional(),
  contact: z.string().trim().min(1).max(120).optional(),
});
export type StayGuestInput = z.infer<typeof stayGuestSchema>;

export const updateStayGuestSchema = z
  .object({
    isPrimary: z.boolean(),
    fullName: z.string().trim().min(1).max(120),
    nationality: z.string().trim().min(1).max(60).nullable(),
    idType: z.string().trim().min(1).max(40).nullable(),
    idNumber: z.string().trim().min(1).max(64).nullable(),
    address: z.string().trim().min(1).max(300).nullable(),
    birthDate: localDate.nullable(),
    contact: z.string().trim().min(1).max(120).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateStayGuestInput = z.infer<typeof updateStayGuestSchema>;

/** SC/PWD guests (§7): each night takes the statutory discount on their share (default 1 ÷ guests). */
export const stayBeneficiarySchema = z.object({
  scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
  name: z.string().trim().min(1).max(200),
  idNumber: z.string().trim().min(1).max(64),
  share: rateSchema.or(z.literal('1')).optional(),
});
export type StayBeneficiaryInput = z.infer<typeof stayBeneficiarySchema>;

const stayFields = {
  roomId: z.uuid(),
  customerId: z.uuid().nullable(),
  guestName: z.string().trim().min(1).max(120).nullable(),
  arrivalDate: localDate,
  departureDate: localDate,
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20),
  /** The agreed gross rate per night (`lodging.rates` or `prices.manage`); null = the rack rate in force each night. */
  nightlyRate: amountSchema.nullable(),
  allowCharges: z.boolean(),
  /** Outlet charges to the room (net of returns) may not go above this; null = no limit. */
  chargeLimit: amountSchema.nullable(),
  source: z.enum(STAY_SOURCES),
  externalReference: z.string().trim().min(1).max(64).nullable(),
  notes: z.string().trim().max(500).nullable(),
};

export const createStaySchema = z
  .object({
    branchId: z.uuid(),
    roomId: stayFields.roomId,
    customerId: z.uuid().optional(),
    guestName: z.string().trim().min(1).max(120).optional(),
    arrivalDate: localDate,
    departureDate: localDate,
    adults: stayFields.adults.default(1),
    children: stayFields.children.default(0),
    nightlyRate: amountSchema.optional(),
    allowCharges: z.boolean().default(true),
    chargeLimit: amountSchema.optional(),
    source: z.enum(STAY_SOURCES).default('WALK_IN'),
    externalReference: z.string().trim().min(1).max(64).optional(),
    notes: z.string().trim().max(500).optional(),
    /** The registry entries known now (needed before check-in). */
    guests: z.array(stayGuestSchema).max(20).default([]),
    /** A walk-in: book and check in in one call (§4). */
    checkIn: z.boolean().default(false),
    overrideHousekeeping: z.boolean().default(false),
  })
  .refine((v) => v.departureDate > v.arrivalDate, { message: 'Departure is after arrival', path: ['departureDate'] })
  .refine((v) => v.customerId !== undefined || v.guestName !== undefined || v.guests.length > 0, { message: 'Name the guest or the customer', path: ['guestName'] })
  .refine((v) => v.guests.filter((g) => g.isPrimary).length <= 1, { message: 'One primary guest', path: ['guests'] });
export type CreateStayInput = z.infer<typeof createStaySchema>;

/** Move, extend, shorten, change the rate or the guest (audited; re-checked by the no-double-booking constraint). */
export const updateStaySchema = z
  .object(stayFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine((v) => !v.arrivalDate || !v.departureDate || v.departureDate > v.arrivalDate, { message: 'Departure is after arrival', path: ['departureDate'] });
export type UpdateStayInput = z.infer<typeof updateStaySchema>;

export const stayListQuerySchema = z.object({
  branchId: z.uuid().optional(),
  status: z.enum(STAY_STATUSES).optional(),
  /** Stays overlapping these dates (arrival < to and departure > from). */
  from: localDate.optional(),
  to: localDate.optional(),
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type StayListQuery = z.infer<typeof stayListQuerySchema>;

export const lodgingAvailabilityQuerySchema = z
  .object({ branchId: z.uuid(), from: localDate, to: localDate, roomTypeId: z.uuid().optional() })
  .refine((v) => v.to > v.from, { message: '"to" is after "from"', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, { message: 'At most 62 nights', path: ['to'] });
export type LodgingAvailabilityQuery = z.infer<typeof lodgingAvailabilityQuerySchema>;

/** In-house guests of the branch's legal entity, by room number or name (the till's Charge to room). */
export const inHouseQuerySchema = z.object({ branchId: z.uuid(), q: z.string().trim().max(60).optional() });
export type InHouseQuery = z.infer<typeof inHouseQuerySchema>;

export const checkInSchema = z.object({
  /** A room not yet CLEAN or INSPECTED (audited). */
  overrideHousekeeping: z.boolean().default(false),
  /** Move the deposits held onto the folio now (check-out always does). */
  applyDeposits: z.boolean().default(false),
  /** Registry entries to add first. */
  guests: z.array(stayGuestSchema).max(20).default([]),
});
export type CheckInInput = z.infer<typeof checkInSchema>;

export const checkOutSchema = z.object({
  /** The guest leaves before the departure date: the stay ends today, later nights are never charged. */
  departEarly: z.boolean().default(false),
});
export type CheckOutInput = z.infer<typeof checkOutSchema>;

const depositRefund = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), cashierSessionId: z.uuid() }),
  z.object({ method: z.literal('BANK_TRANSFER'), reference: z.string().trim().min(1).max(64) }),
]);

/** Cancel a booking or mark a no-show (§3, §6); deposits held are forfeited or refunded. */
export const cancelStaySchema = z
  .object({
    reason,
    /** Default: the branch's `forfeitOnCancel`; against it needs `lodging.rates`. */
    deposits: z.enum(['FORFEIT', 'REFUND']).optional(),
    /** How a refund is paid (required when refunding a deposit). */
    refund: depositRefund.optional(),
  });
export type CancelStayInput = z.infer<typeof cancelStaySchema>;

// ------------------------------------------------------------------ deposits (§6)

export const receiveDepositSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), cashierSessionId: z.uuid(), amount: positiveAmount }),
  /** A card/QR payment taken at the front desk (purpose FOLIO). */
  z.object({ method: z.literal('INTENT'), cashierSessionId: z.uuid(), paymentIntentId: z.uuid() }),
  /** Paid into the bank (`lodging.rates`); no drawer effect. */
  z.object({ method: z.literal('BANK_TRANSFER'), amount: positiveAmount, reference: z.string().trim().min(1).max(64) }),
]);
export type ReceiveDepositInput = z.infer<typeof receiveDepositSchema>;

export const refundDepositSchema = z.object({ amount: positiveAmount.optional(), reason, refund: depositRefund });
export type RefundDepositInput = z.infer<typeof refundDepositSchema>;

export const forfeitDepositSchema = z.object({ amount: positiveAmount.optional(), reason });
export type ForfeitDepositInput = z.infer<typeof forfeitDepositSchema>;

export const applyDepositSchema = z.object({ amount: positiveAmount.optional() });
export type ApplyDepositInput = z.infer<typeof applyDepositSchema>;

// ------------------------------------------------------------------ folios (§5)

/** Settling at the front desk, at an open cashier session (§5.2). */
export const folioPaymentSchema = z.discriminatedUnion('method', [
  /** May exceed the balance: the rest is change. */
  z.object({ method: z.literal('CASH'), cashierSessionId: z.uuid(), tendered: positiveAmount }),
  z.object({ method: z.literal('INTENT'), cashierSessionId: z.uuid(), paymentIntentId: z.uuid() }),
  z.object({ method: z.literal('STORE_CREDIT'), cashierSessionId: z.uuid(), amount: positiveAmount }),
  z.object({ method: z.literal('BANK_TRANSFER'), cashierSessionId: z.uuid(), amount: positiveAmount, reference: z.string().trim().min(1).max(64) }),
]);
export type FolioPaymentInput = z.infer<typeof folioPaymentSchema>;

/** A goodwill credit (negative) or a manual fee (positive), on the room-night price basis; VAT by @1pos/tax. */
export const folioAdjustmentSchema = z.object({ amount: signedAmount, reason, description: z.string().trim().min(1).max(120).optional() });
export type FolioAdjustmentInput = z.infer<typeof folioAdjustmentSchema>;

/** Undo a night charged by mistake (and its accommodation tax), once. */
export const nightReversalSchema = z.object({ entryId: z.uuid(), reason });
export type NightReversalInput = z.infer<typeof nightReversalSchema>;

export const nightAuditSchema = z.object({ branchId: z.uuid() });
export type NightAuditInput = z.infer<typeof nightAuditSchema>;

// ------------------------------------------------------------------ reports (§12)

export const guestLedgerQuerySchema = z.object({ legalEntityId: z.uuid() });
export type GuestLedgerQuery = z.infer<typeof guestLedgerQuerySchema>;
