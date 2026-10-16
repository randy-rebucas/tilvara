import { z } from 'zod';
import { amountSchema } from './catalog.js';
import { quantitySchema } from './tax.js';

const name = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const reason = z.string().trim().min(1).max(200);
/** Zero allowed (a fully rejected line), unlike `quantitySchema`. */
const nonNegativeQuantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1" or "0.250"');

const unique = <T>(items: T[], key: (x: T) => string | undefined, ctx: z.RefinementCtx, field: string, message: string) => {
  const seen = new Set<string>();
  items.forEach((x, i) => {
    const k = key(x);
    if (k === undefined) return;
    if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['lines', i, field], message });
    seen.add(k);
  });
};

// ------------------------------------------------------------------ suppliers

export const createSupplierSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'Use 1–30 letters, digits, - or _'),
  name,
  tin: optionalText(20),
  email: z.email().nullable().optional(),
  phone: optionalText(40),
  address: optionalText(500),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  notes: optionalText(1000),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const supplierListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

// ------------------------------------------------------------------ purchase orders

const poLine = z.object({ variantId: z.uuid(), quantity: quantitySchema, unitCost: amountSchema });

export const createPurchaseOrderSchema = z
  .object({
    branchId: z.uuid(),
    supplierId: z.uuid(),
    expectedOn: z.iso.date().nullable().optional(),
    supplierRef: optionalText(100),
    notes: optionalText(1000),
    lines: z.array(poLine).min(1).max(200),
  })
  .superRefine((v, ctx) => unique(v.lines, (l) => l.variantId, ctx, 'variantId', 'Each item once per order'));
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

/** Draft edits; `lines` replaces all lines. */
export const updatePurchaseOrderSchema = z
  .object({
    supplierId: z.uuid(),
    expectedOn: z.iso.date().nullable(),
    supplierRef: optionalText(100),
    notes: optionalText(1000),
    lines: z.array(poLine).min(1).max(200),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (Object.keys(v).length === 0) ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
    if (v.lines) unique(v.lines, (l) => l.variantId, ctx, 'variantId', 'Each item once per order');
  });
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

export const purchaseOrderListQuerySchema = z.object({
  branchId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  status: z.enum(['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']).optional(),
});
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;

export const endPurchaseOrderSchema = z.object({ reason });
export type EndPurchaseOrderInput = z.infer<typeof endPurchaseOrderSchema>;

// ------------------------------------------------------------------ goods receipts

export const createGoodsReceiptSchema = z
  .object({
    branchId: z.uuid(),
    supplierId: z.uuid(),
    purchaseOrderId: z.uuid().optional(),
    supplierInvoiceRef: optionalText(100),
    supplierDeliveryRef: optionalText(100),
    notes: optionalText(1000),
    lines: z
      .array(
        z.object({
          purchaseOrderLineId: z.uuid().optional(),
          variantId: z.uuid(),
          /** Accepted into stock. */
          quantity: nonNegativeQuantity,
          /** Delivered but refused (damaged, wrong item); recorded, never stocked. */
          rejectedQuantity: nonNegativeQuantity.optional(),
          rejectionReason: z.string().trim().max(200).optional(),
          /** Defaults to the order line's cost; required for a line not on the order. */
          unitCost: amountSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      const rejected = Number(l.rejectedQuantity ?? '0');
      if (Number(l.quantity) + rejected <= 0) ctx.addIssue({ code: 'custom', path: ['lines', i, 'quantity'], message: 'Receive or reject a quantity' });
      if (rejected > 0 && !l.rejectionReason) ctx.addIssue({ code: 'custom', path: ['lines', i, 'rejectionReason'], message: 'Say why it was rejected' });
      if (!l.purchaseOrderLineId && l.unitCost === undefined) ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Cost is required for an item not on the order' });
      if (l.purchaseOrderLineId && !v.purchaseOrderId) ctx.addIssue({ code: 'custom', path: ['lines', i, 'purchaseOrderLineId'], message: 'Order lines need the purchase order' });
    });
    unique(v.lines, (l) => l.purchaseOrderLineId, ctx, 'purchaseOrderLineId', 'Each order line once per receipt');
  });
export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

export const goodsReceiptListQuerySchema = z.object({
  branchId: z.uuid(),
  supplierId: z.uuid().optional(),
  purchaseOrderId: z.uuid().optional(),
});
export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListQuerySchema>;

// ------------------------------------------------------------------ supplier returns

export const createSupplierReturnSchema = z
  .object({
    branchId: z.uuid(),
    supplierId: z.uuid(),
    goodsReceiptId: z.uuid().optional(),
    reason,
    lines: z
      .array(
        z.object({
          goodsReceiptLineId: z.uuid().optional(),
          variantId: z.uuid(),
          quantity: quantitySchema,
          /** What the supplier credits per unit; defaults to the receipt line's cost, else the current average. */
          creditUnitCost: amountSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      if (l.goodsReceiptLineId && !v.goodsReceiptId) ctx.addIssue({ code: 'custom', path: ['lines', i, 'goodsReceiptLineId'], message: 'Receipt lines need the goods receipt' });
    });
    unique(v.lines, (l) => l.goodsReceiptLineId, ctx, 'goodsReceiptLineId', 'Each receipt line once per return');
  });
export type CreateSupplierReturnInput = z.infer<typeof createSupplierReturnSchema>;

export const supplierReturnListQuerySchema = z.object({ branchId: z.uuid(), supplierId: z.uuid().optional() });
export type SupplierReturnListQuery = z.infer<typeof supplierReturnListQuerySchema>;
