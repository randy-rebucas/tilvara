import { z } from 'zod';
import { quantitySchema } from './tax.js';

/**
 * A new recipe version for a sold item (ADR-0014 §4, "supplies used" for a salon's services, ADR-0022 §9): what one unit consumes, in each ingredient's
 * own unit. An empty ingredient list stops consumption from `effectiveFrom` on.
 */
export const createRecipeVersionSchema = z
  .object({
    ingredients: z
      .array(z.object({ variantId: z.uuid(), quantity: quantitySchema }))
      .max(100),
    /** ISO timestamp; omitted = now. Cannot be in the past. */
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.ingredients.forEach((i, idx) => {
      if (seen.has(i.variantId)) ctx.addIssue({ code: 'custom', path: ['ingredients', idx, 'variantId'], message: 'Each ingredient once per recipe' });
      seen.add(i.variantId);
    });
  });
export type CreateRecipeVersionInput = z.infer<typeof createRecipeVersionSchema>;
