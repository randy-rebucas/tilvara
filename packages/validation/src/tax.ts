import { z } from 'zod';
import { amountSchema } from './catalog.js';

/** Decimal fraction with up to 6 dp, e.g. "0.12". */
export const rateSchema = z
  .string()
  .trim()
  .regex(/^0(\.\d{1,6})?$/, 'Use a decimal fraction such as "0.12"');

/** Positive decimal quantity with up to 4 dp. */
export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1" or "0.250"')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

export const createTaxProfileSchema = z
  .object({
    vatStatus: z.enum(['VAT', 'NON_VAT']),
    /** Defaults: 0.12 for VAT sellers. Must be 0 (or omitted) for non-VAT sellers. */
    vatRate: rateSchema.optional(),
    /** Defaults: 0.03 for non-VAT sellers. Must be 0 (or omitted) for VAT sellers. */
    percentageTaxRate: rateSchema.optional(),
    roundingMode: z.enum(['HALF_UP', 'HALF_EVEN']).default('HALF_UP'),
    /** ISO timestamp; omitted = now. Cannot be in the past. */
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.vatStatus === 'NON_VAT' && v.vatRate !== undefined && Number(v.vatRate) !== 0) {
      ctx.addIssue({ code: 'custom', path: ['vatRate'], message: 'Non-VAT sellers have no VAT rate' });
    }
    if (v.vatStatus === 'VAT' && v.vatRate !== undefined && Number(v.vatRate) === 0) {
      ctx.addIssue({ code: 'custom', path: ['vatRate'], message: 'VAT sellers need a VAT rate above zero' });
    }
    if (v.vatStatus === 'VAT' && v.percentageTaxRate !== undefined && Number(v.percentageTaxRate) !== 0) {
      ctx.addIssue({ code: 'custom', path: ['percentageTaxRate'], message: 'VAT sellers do not pay percentage tax' });
    }
  });
export type CreateTaxProfileInput = z.infer<typeof createTaxProfileSchema>;

export const taxQuoteLineSchema = z.object({
  /** Client line id (echoed back); defaults to the line's position. */
  id: z.string().trim().min(1).max(64).optional(),
  variantId: z.uuid(),
  quantity: quantitySchema,
  /** Ordinary discount for the whole line, on the price-list basis. */
  discount: amountSchema.optional(),
  statutory: z
    .object({
      scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
      /** Beneficiary's share of the line, (0, 1]. */
      share: rateSchema.or(z.literal('1')).optional(),
    })
    .optional(),
});

export const taxQuoteSchema = z.object({
  branchId: z.uuid(),
  lines: z.array(taxQuoteLineSchema).min(1).max(200),
});
export type TaxQuoteInput = z.infer<typeof taxQuoteSchema>;
