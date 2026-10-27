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

const queryFlag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** The next page after a product listed by name: its name and id, base64url JSON (opaque to callers). */
export function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}

function decodeNameCursor(cursor: string): { name: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || !z.uuid().safeParse(v[1]).success) return null;
    return { name: v[0], id: v[1] as string };
  } catch {
    return null;
  }
}

export const productListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    /** A category id, or `none` for products without one. */
    categoryId: z.union([z.uuid(), z.literal('none')]).optional(),
    /** With `categoryId`: its sub-categories too (Drinks finds Drinks › Hot drinks). */
    withSubcategories: queryFlag,
    /** Only this kind of item. */
    productType: z.enum(['STANDARD', 'SERVICE']).optional(),
    soldBy: z.enum(['UNIT', 'WEIGHT']).optional(),
    taxCategoryId: z.uuid().optional(),
    trackInventory: queryFlag,
    tracksExpiry: queryFlag,
    /** At least one active barcode on an active variant (false: none). */
    hasBarcode: queryFlag,
    /** A price in force now on the default price list for every active variant (false: one has none). */
    hasPrice: queryFlag,
    /** More than one active variant (sizes, colours). */
    hasVariants: queryFlag,
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Overrides `includeArchived`. */
    status: z.enum(['active', 'archived', 'all']).optional(),
    /** `oldest` (the default) and `newest` page by id; `name` pages by name then id. */
    sort: z.enum(['oldest', 'newest', 'name']).default('oldest'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(1200).optional(),
  })
  .transform((q, ctx) => {
    const status = q.status ?? (q.includeArchived ? 'all' : 'active');
    let after: { name?: string; id: string } | undefined;
    if (q.cursor) {
      const decoded = q.sort === 'name' ? decodeNameCursor(q.cursor) : z.uuid().safeParse(q.cursor).success ? { id: q.cursor } : null;
      if (!decoded) {
        ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'Use the nextCursor of the previous page, with the same sort' });
        return z.NEVER;
      }
      after = decoded;
    }
    return { ...q, status, after };
  });
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

/** Rows in one product import (a CSV file read by the admin). */
export const PRODUCT_IMPORT_MAX_ROWS = 2000;

/**
 * One line of a product import: one variant (SKU) and its product's details. A row whose SKU is
 * already an active variant updates it; a new SKU joins the product of the same name in the file
 * that already exists, or makes a new product. A field left out leaves that detail as it is (or
 * takes the default for a new product: unit PC, tax VAT, sold by unit, stock tracked).
 */
export const productImportRowSchema = z.object({
  /** Line in the file, for the messages. */
  line: z.number().int().min(1).max(1_000_000),
  name,
  sku: skuSchema,
  variantName: z.string().trim().min(1).max(200).optional(),
  /** Added to the variant's barcodes; none is ever removed. */
  barcodes: z.array(barcodeSchema).max(20).default([]),
  /** A name, or a path such as "Drinks › Hot drinks" (› or >); missing categories are made. */
  category: z.string().trim().min(1).max(500).optional(),
  /** A unit code (PC, KG). */
  unit: z.string().trim().min(1).max(10).optional(),
  /** A tax category's code or name. */
  tax: z.string().trim().min(1).max(200).optional(),
  productType: z.enum(['STANDARD', 'SERVICE']).optional(),
  soldBy: z.enum(['UNIT', 'WEIGHT']).optional(),
  trackInventory: z.boolean().optional(),
  tracksExpiry: z.boolean().optional(),
  /** The price on the default price list, from now. */
  price: amountSchema.optional(),
  referenceCost: amountSchema.optional(),
  /** Replaces the variant's sizes and colours. */
  attributes: attributes.optional(),
});
export type ProductImportRow = z.infer<typeof productImportRowSchema>;

export const productImportSchema = z.object({
  rows: z.array(productImportRowSchema).min(1).max(PRODUCT_IMPORT_MAX_ROWS),
});
export type ProductImportInput = z.infer<typeof productImportSchema>;

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
