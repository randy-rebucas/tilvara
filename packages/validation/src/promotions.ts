import { z } from 'zod';
import { amountSchema } from './catalog.js';
import { quantitySchema, rateSchema } from './tax.js';

/** A fraction off in (0, 1]: "0.1" is 10 %, "1" is free. */
const offRate = rateSchema.refine((v) => Number(v) > 0, 'Use a rate above zero').or(z.literal('1')).or(z.literal('1.0'));
const units = z.number().int().min(1).max(1000);

/**
 * A promotion (ADR-0021 §1). `branchIds` absent or empty: every branch. `startsAt` absent: now; it can
 * not be in the past. Only the fields of its kind may be given.
 */
export const createPromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['MULTI_BUY', 'BUY_X_GET_Y', 'QUANTITY_BREAK']),
    variantIds: z.array(z.uuid()).min(1).max(500),
    branchIds: z.array(z.uuid()).max(200).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    quantity: units.optional(),
    price: amountSchema.optional(),
    buyQuantity: units.optional(),
    getQuantity: units.optional(),
    getRate: offRate.optional(),
    tiers: z.array(z.object({ minQuantity: quantitySchema, rate: offRate })).min(1).max(5).optional(),
  })
  .superRefine((p, ctx) => {
    const fields = { MULTI_BUY: ['quantity', 'price'], BUY_X_GET_Y: ['buyQuantity', 'getQuantity', 'getRate'], QUANTITY_BREAK: ['tiers'] } as const;
    const all = ['quantity', 'price', 'buyQuantity', 'getQuantity', 'getRate', 'tiers'] as const;
    const own: readonly string[] = fields[p.kind];
    for (const f of all) {
      if (own.includes(f) && p[f] === undefined) ctx.addIssue({ code: 'custom', path: [f], message: 'Required for this kind of promotion' });
      if (!own.includes(f) && p[f] !== undefined) ctx.addIssue({ code: 'custom', path: [f], message: 'Not used by this kind of promotion' });
    }
    if (p.kind === 'MULTI_BUY' && p.quantity !== undefined && p.quantity < 2) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'A multi-buy needs at least 2 items' });
    if (p.tiers) {
      const mins = p.tiers.map((t) => Number(t.minQuantity));
      if (mins.some((m, i) => i > 0 && m <= mins[i - 1]!)) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tiers go up in quantity' });
    }
    if (new Set(p.variantIds).size !== p.variantIds.length) ctx.addIssue({ code: 'custom', path: ['variantIds'], message: 'An item is listed twice' });
    if (p.branchIds && new Set(p.branchIds).size !== p.branchIds.length) ctx.addIssue({ code: 'custom', path: ['branchIds'], message: 'A branch is listed twice' });
    if (p.startsAt && p.endsAt && Date.parse(p.endsAt) <= Date.parse(p.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Ends after it starts' });
  });
export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

/** Only the name, or ending it (now, or at a later moment while it runs). */
export const updatePromotionSchema = z
  .object({ name: z.string().trim().min(1).max(80), endsAt: z.union([z.literal('now'), z.iso.datetime({ offset: true })]) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdatePromotionInput = z.infer<typeof updatePromotionSchema>;

export const promotionListQuerySchema = z.object({
  state: z.enum(['CURRENT', 'ENDED', 'ALL']).default('CURRENT'),
});
export type PromotionListQuery = z.infer<typeof promotionListQuerySchema>;

/** An attribute of the variants sold, e.g. "Size" (report "Sales by size and colour"). */
export const attributeQuerySchema = z.object({ attribute: z.string().trim().min(1).max(50).optional() });
export type AttributeQuery = z.infer<typeof attributeQuerySchema>;
