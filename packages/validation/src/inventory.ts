import { z } from 'zod';
import { quantitySchema } from './tax.js';

const nonNegativeQuantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1" or "0.250"');
const uniqueVariants = <T extends { variantId: string }>(items: T[], ctx: z.RefinementCtx, field = 'lines') => {
  const seen = new Set<string>();
  items.forEach((x, i) => {
    if (seen.has(x.variantId)) ctx.addIssue({ code: 'custom', path: [field, i, 'variantId'], message: 'Each item once' });
    seen.add(x.variantId);
  });
};

// ------------------------------------------------------------------ transfers

export const createStockTransferSchema = z
  .object({
    fromBranchId: z.uuid(),
    toBranchId: z.uuid(),
    notes: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(z.object({ variantId: z.uuid(), quantity: quantitySchema })).min(1).max(200),
  })
  .superRefine((v, ctx) => {
    if (v.fromBranchId === v.toBranchId) ctx.addIssue({ code: 'custom', path: ['toBranchId'], message: 'Transfer to another branch' });
    uniqueVariants(v.lines, ctx);
  });
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;

/** Lines omitted are received in full; a shortfall needs a reason. */
export const receiveStockTransferSchema = z
  .object({
    notes: z.string().trim().max(1000).nullable().optional(),
    lines: z
      .array(z.object({ transferLineId: z.uuid(), receivedQuantity: nonNegativeQuantity, discrepancyReason: z.string().trim().max(200).optional() }))
      .max(200)
      .default([]),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.lines.forEach((l, i) => {
      if (seen.has(l.transferLineId)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'transferLineId'], message: 'Each line once' });
      seen.add(l.transferLineId);
    });
  });
export type ReceiveStockTransferInput = z.infer<typeof receiveStockTransferSchema>;

export const stockTransferListQuerySchema = z.object({
  branchId: z.uuid(),
  direction: z.enum(['OUT', 'IN', 'ANY']).default('ANY'),
  status: z.enum(['DISPATCHED', 'RECEIVED']).optional(),
});
export type StockTransferListQuery = z.infer<typeof stockTransferListQuerySchema>;

// ------------------------------------------------------------------ counts

export const createStockCountSchema = z
  .object({
    branchId: z.uuid(),
    notes: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(z.object({ variantId: z.uuid(), countedQuantity: nonNegativeQuantity })).min(1).max(1000),
  })
  .superRefine((v, ctx) => uniqueVariants(v.lines, ctx));
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;

export const branchQuerySchema = z.object({ branchId: z.uuid() });
export type BranchQuery = z.infer<typeof branchQuerySchema>;

// ------------------------------------------------------------------ shelf locations (ADR-0021 §5)

export const setItemLocationsSchema = z
  .object({
    branchId: z.uuid(),
    /** `location: null` (or blank) removes the item's location. */
    items: z
      .array(
        z.object({
          variantId: z.uuid(),
          location: z.string().trim().max(32).nullable().transform((v) => (v ? v.toUpperCase() : null)),
        }),
      )
      .min(1)
      .max(500),
  })
  .superRefine((v, ctx) => uniqueVariants(v.items, ctx, 'items'));
export type SetItemLocationsInput = z.infer<typeof setItemLocationsSchema>;

// ------------------------------------------------------------------ reorder points

export const setReorderPointsSchema = z
  .object({
    branchId: z.uuid(),
    /** `reorderPoint: null` removes the item's reorder point. */
    items: z
      .array(z.object({ variantId: z.uuid(), reorderPoint: nonNegativeQuantity.nullable(), reorderQuantity: quantitySchema.nullable().optional() }))
      .min(1)
      .max(500),
  })
  .superRefine((v, ctx) => uniqueVariants(v.items, ctx, 'items'));
export type SetReorderPointsInput = z.infer<typeof setReorderPointsSchema>;

// ------------------------------------------------------------------ inventory settings (per branch)

export const NEGATIVE_STOCK_POLICY_VALUES = ['ALLOW', 'ALLOW_WITH_FLAG', 'BLOCK'] as const;
export const inventorySettingsSchema = z.object({
  negativeStockPolicy: z.enum(NEGATIVE_STOCK_POLICY_VALUES),
  lowStockAlerts: z.boolean(),
  /** Mail about lots expiring within this many days; 0 turns it off (ADR-0020 §3). Left out: as it is. */
  expiryAlertDays: z.number().int().min(0).max(365).optional(),
  /** Expired or held lots may be sold (ALLOW) or not (BLOCK); null = ALLOW (ADR-0025 §4). Left out: as it is. */
  expiredStock: z.enum(['ALLOW', 'BLOCK']).nullable().optional(),
});
export type InventorySettingsInput = z.infer<typeof inventorySettingsSchema>;

// ------------------------------------------------------------------ count sheets (blind counts)

/**
 * Opens a sheet and freezes on-hand quantities. Without `variantIds`, every stock-tracked item the
 * branch has a balance for (at most 5,000; a larger branch counts by list).
 */
export const createCountSheetSchema = z.object({
  branchId: z.uuid(),
  blind: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
  variantIds: z.array(z.uuid()).min(1).max(5000).optional(),
});
export type CreateCountSheetInput = z.infer<typeof createCountSheetSchema>;

/** `countedQuantity: null` clears a count. An item not on the sheet is added (frozen at on hand now). */
export const countSheetLinesSchema = z
  .object({ lines: z.array(z.object({ variantId: z.uuid(), countedQuantity: nonNegativeQuantity.nullable() })).min(1).max(1000) })
  .superRefine((v, ctx) => uniqueVariants(v.lines, ctx));
export type CountSheetLinesInput = z.infer<typeof countSheetLinesSchema>;

export const cancelCountSheetSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type CancelCountSheetInput = z.infer<typeof cancelCountSheetSchema>;

export const countSheetListQuerySchema = z.object({ branchId: z.uuid(), status: z.enum(['OPEN', 'POSTED', 'CANCELLED']).optional() });
export type CountSheetListQuery = z.infer<typeof countSheetListQuerySchema>;

// ------------------------------------------------------------------ reservations (session 20)

/** Set stock aside at a branch; never more than is available (on hand − what is already reserved). */
export const createReservationSchema = z.object({
  branchId: z.uuid(),
  variantId: z.uuid(),
  quantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1"').refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
  /** For whom or why: "Maria, pick-up Saturday", "Display". */
  note: z.string().trim().min(1).max(200),
  customerId: z.uuid().optional(),
  /** It stops counting at this moment (ISO); omitted: until released. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const reservationListQuerySchema = z.object({ branchId: z.uuid(), status: z.enum(['ACTIVE', 'ALL']).default('ACTIVE') });
export type ReservationListQuery = z.infer<typeof reservationListQuerySchema>;

/** Sold, collected, or no longer wanted. */
export const releaseReservationSchema = z.object({ reason: z.string().trim().min(1).max(200) });
export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

// ------------------------------------------------------------------ packs and pieces (ADR-0020)

/** A decimal string greater than 1, compared as text (no floating point). */
const moreThanOne = (v: string) => {
  const [whole = '', fraction = ''] = v.split('.');
  const int = whole.replace(/^0+/, '');
  return int.length > 1 || (int.length === 1 && (int > '1' || (int === '1' && /[1-9]/.test(fraction))));
};

export const createPackConversionSchema = z
  .object({
    packVariantId: z.uuid(),
    pieceVariantId: z.uuid(),
    /** How many pieces one pack holds: 20 sticks, 12 sachets, 25 (kg) in a sack. */
    piecesPerPack: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,4})?$/, 'Use a plain decimal string such as "20" or "25.5"')
      .refine(moreThanOne, 'A pack holds more than one piece'),
    autoOpen: z.boolean().default(true),
  })
  .refine((v) => v.packVariantId !== v.pieceVariantId, { message: 'The pack and the piece are different items', path: ['pieceVariantId'] });
export type CreatePackConversionInput = z.infer<typeof createPackConversionSchema>;

export const updatePackConversionSchema = z.object({ autoOpen: z.boolean() });
export type UpdatePackConversionInput = z.infer<typeof updatePackConversionSchema>;

export const packConversionQuerySchema = z.object({ variantId: z.uuid().optional() });
export type PackConversionQuery = z.infer<typeof packConversionQuerySchema>;

export const packOpeningSchema = z.object({
  branchId: z.uuid(),
  conversionId: z.uuid(),
  /** Whole packs only. */
  packs: z.string().trim().regex(/^[1-9]\d{0,5}$/, 'Open whole packs: "1", "2", …'),
  reason: z.string().trim().min(1).max(200),
});
export type PackOpeningInput = z.infer<typeof packOpeningSchema>;

// ------------------------------------------------------------------ expiry lots (ADR-0020 §3)

export const expiringQuerySchema = z.object({
  branchId: z.uuid(),
  /** Expired, and expiring within this many days (default: the branch's alert window, else 30). */
  withinDays: z.coerce.number().int().min(0).max(365).optional(),
});
export type ExpiringQuery = z.infer<typeof expiringQuerySchema>;

export const lotQuerySchema = z.object({ branchId: z.uuid(), variantId: z.uuid() });
export type LotQuery = z.infer<typeof lotQuerySchema>;

// Lot holds (recalls) and the batch trace (ADR-0025 §5, kept for every shop when pharmacies were removed).
const lotText = (max: number) => z.string().trim().min(1).max(max);

export const createLotHoldSchema = z.object({
  variantId: z.uuid(),
  lotCode: lotText(64),
  /** Omitted: every branch. */
  branchId: z.uuid().optional(),
  reason: lotText(200),
  reference: z.string().trim().max(100).nullable().optional(),
});
export type CreateLotHoldInput = z.infer<typeof createLotHoldSchema>;
export const releaseLotHoldSchema = z.object({ reason: lotText(200) });
export type ReleaseLotHoldInput = z.infer<typeof releaseLotHoldSchema>;
export const lotHoldListQuerySchema = z.object({
  variantId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  includeReleased: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
export type LotHoldListQuery = z.infer<typeof lotHoldListQuerySchema>;

export const lotTraceQuerySchema = z.object({ variantId: z.uuid(), lotCode: lotText(64) });
export type LotTraceQuery = z.infer<typeof lotTraceQuerySchema>;
