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
