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

/** One discount form per line (the amount or the rate). */
export const oneDiscountForm = <T extends { discount?: string | undefined; discountRate?: string | undefined }>(l: T) =>
  !(l.discount !== undefined && l.discountRate !== undefined);
const oneDiscountMessage = { message: 'Give the discount as an amount or a rate, not both', path: ['discountRate'] };

/** A cart line before refinements (extended by checkout lines). */
export const taxQuoteLineObject = z.object({
  /** Client line id (echoed back); defaults to the line's position. */
  id: z.string().trim().min(1).max(64).optional(),
  variantId: z.uuid(),
  quantity: quantitySchema,
  /** Ordinary discount for the whole line, on the price-list basis. Needs `sales.discount`. */
  discount: amountSchema.optional(),
  /** Ordinary discount as a fraction of the line (e.g. "0.10" = 10 %), computed on the server. Needs `sales.discount`. */
  discountRate: rateSchema.refine((v) => Number(v) > 0, 'Discount must be above zero').or(z.literal('1')).optional(),
  /** An approved price for this item (`POST /v1/price-overrides`), used instead of the list price. */
  priceOverrideId: z.uuid().optional(),
  statutory: z
    .object({
      scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
      /** Beneficiary's share of the line, (0, 1]. */
      share: rateSchema.or(z.literal('1')).optional(),
    })
    .optional(),
});
export const taxQuoteLineSchema = taxQuoteLineObject.refine(oneDiscountForm, oneDiscountMessage);
export const oneDiscountRefinement = [oneDiscountForm, oneDiscountMessage] as const;

export const taxQuoteSchema = z.object({
  branchId: z.uuid(),
  lines: z.array(taxQuoteLineSchema).min(1).max(200),
});
export type TaxQuoteInput = z.infer<typeof taxQuoteSchema>;
