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
