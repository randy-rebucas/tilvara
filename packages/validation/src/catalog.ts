import { z } from 'zod';

/** Non-negative decimal string, up to 16 integer digits and 4 decimals (NUMERIC(20,4)). Never a JS number. */
export const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/, 'Use a plain decimal string such as "49.75"');

const name = z.string().trim().min(1).max(200);
const code = (max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^[A-Z][A-Z0-9_]{0,${max - 1}}$`), `Use up to ${max} letters, digits or underscores, starting with a letter`);

export const barcodeSchema = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'Barcode may contain letters, digits and hyphens');
export const skuSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'SKU may contain letters, digits and . _ / -');

/** Matches the DB check `units_of_measure_code_format` (0006): letters and digits only, no underscore. */
const uomCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use up to 10 letters or digits, starting with a letter');

export const createUomSchema = z.object({ code: uomCode, name, allowsFraction: z.boolean().default(false) });
export type CreateUomInput = z.infer<typeof createUomSchema>;

export const createTaxCategorySchema = z.object({
  code: code(30),
  name,
  vatTreatment: z.enum(['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']),
});
export type CreateTaxCategoryInput = z.infer<typeof createTaxCategorySchema>;

export const createCategorySchema = z.object({
  name,
  parentId: z.uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({ name, parentId: z.uuid().nullable(), sortOrder: z.number().int().min(0).max(100_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

const attributes = z.record(z.string().trim().min(1).max(50), z.string().trim().min(1).max(100)).refine(
  (r) => Object.keys(r).length <= 10,
  'At most 10 attributes',
);

export const variantInputSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1).max(200).nullable().optional(),
  attributes: attributes.default({}),
  referenceCost: amountSchema.nullable().optional(),
  barcodes: z.array(barcodeSchema).max(20).default([]),
  /** Optional initial price in the tenant's default price list, effective now. */
  price: amountSchema.optional(),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

export const createProductSchema = z
  .object({
    name,
    description: z.string().trim().max(2000).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    taxCategoryId: z.uuid(),
    uomId: z.uuid(),
    productType: z.enum(['STANDARD', 'SERVICE']).default('STANDARD'),
    soldBy: z.enum(['UNIT', 'WEIGHT']).default('UNIT'),
    trackInventory: z.boolean().optional(),
    /** Stock comes in with expiry dates (ADR-0020 §3); needs tracked stock. */
    tracksExpiry: z.boolean().default(false),
    variants: z.array(variantInputSchema).min(1).max(100),
  })
  .superRefine((p, ctx) => {
    const skus = p.variants.map((v) => v.sku.toLowerCase());
    if (new Set(skus).size !== skus.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Duplicate SKU' });
    const codes = p.variants.flatMap((v) => v.barcodes);
    if (new Set(codes).size !== codes.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Duplicate barcode' });
    if (p.productType !== 'STANDARD' && p.trackInventory) {
      ctx.addIssue({ code: 'custom', path: ['trackInventory'], message: 'Services cannot track inventory' });
    }
    if (p.tracksExpiry && (p.productType !== 'STANDARD' || p.trackInventory === false)) {
      ctx.addIssue({ code: 'custom', path: ['tracksExpiry'], message: 'Expiry dates need stock that is counted' });
    }
  });
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name,
    description: z.string().trim().max(2000).nullable(),
    categoryId: z.uuid().nullable(),
    taxCategoryId: z.uuid(),
    trackInventory: z.boolean(),
    tracksExpiry: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const addVariantSchema = variantInputSchema;
export const updateVariantSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable(),
    attributes,
    referenceCost: amountSchema.nullable(),
    /** Its button on the till's quick keys (ADR-0021 §3); null takes it off. */
    quickKeyPosition: z.number().int().min(1).max(48).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

export const addBarcodeSchema = z.object({ code: barcodeSchema });

export const productListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: z.uuid().optional(),
  /** Only this kind of item. */
  productType: z.enum(['STANDARD', 'SERVICE']).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

/** Names for document lines that carry only variant ids (archived ones included): `?ids=a,b,c`. */
export const variantLookupQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1).max(200)),
});
export type VariantLookupQuery = z.infer<typeof variantLookupQuerySchema>;

export const lookupQuerySchema = z.object({
  code: z.string().trim().min(1).max(64),
  branchId: z.uuid(),
});
export type LookupQuery = z.infer<typeof lookupQuerySchema>;

export const createPriceListSchema = z.object({
  name,
  currency: z.enum(['PHP', 'USD', 'JPY']).default('PHP'),
  pricesIncludeTax: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z
  .object({ name, pricesIncludeTax: z.boolean(), isDefault: z.literal(true) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const setPricesSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        amount: amountSchema,
        /** Defaults to now. Future dates schedule a price change; backdating is refused. */
        effectiveFrom: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type SetPricesInput = z.infer<typeof setPricesSchema>;

export const assignPriceListSchema = z.object({ priceListId: z.uuid().nullable() });
export type AssignPriceListInput = z.infer<typeof assignPriceListSchema>;
