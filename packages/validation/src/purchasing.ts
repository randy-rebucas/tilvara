import { z } from 'zod';
import { isPositiveDecimal } from './decimal.js';
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

/** `unitCost` omitted: the supplier's catalog cost for the item (session 20), else refused. */
const poLine = z.object({ variantId: z.uuid(), quantity: quantitySchema, unitCost: amountSchema.optional() });

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
          /** Expiry date of what was accepted (ADR-0020 §3); required for an item that tracks expiry. */
          expiresOn: z.iso.date().optional(),
          lotCode: z.string().trim().min(1).max(40).optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      const rejected = isPositiveDecimal(l.rejectedQuantity);
      if (!isPositiveDecimal(l.quantity) && !rejected) ctx.addIssue({ code: 'custom', path: ['lines', i, 'quantity'], message: 'Receive or reject a quantity' });
      if (rejected && !l.rejectionReason) ctx.addIssue({ code: 'custom', path: ['lines', i, 'rejectionReason'], message: 'Say why it was rejected' });
      if (!l.purchaseOrderLineId && l.unitCost === undefined) ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Cost is required for an item not on the order' });
      if (l.lotCode && !l.expiresOn) ctx.addIssue({ code: 'custom', path: ['lines', i, 'expiresOn'], message: 'A lot needs its expiry date' });
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
          /**
           * The expiry lot the goods leave from (ADR-0020: a held or expired batch going back). A line from a
           * receipt defaults to the lot that receipt line made; else the oldest stock goes first.
           */
          lotId: z.uuid().optional(),
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

// ------------------------------------------------------------------ supplier invoices and payments (session 16)

/** Pesos with at most two decimals, as printed on an invoice. */
const peso = z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Use pesos such as "1125.60"');

export const createSupplierInvoiceSchema = z
  .object({
    supplierId: z.uuid(),
    /** The supplier's own invoice number. */
    invoiceNumber: z.string().trim().min(1).max(60),
    invoiceDate: z.iso.date(),
    /** Defaults to the invoice date plus the supplier's payment terms. */
    dueDate: z.iso.date().optional(),
    /** Whole goods receipts of one branch, not yet on an open invoice. */
    goodsReceiptIds: z.array(z.uuid()).min(1).max(100),
    netAmount: peso,
    vatAmount: peso,
    notes: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.goodsReceiptIds).size !== v.goodsReceiptIds.length) ctx.addIssue({ code: 'custom', path: ['goodsReceiptIds'], message: 'Each receipt once' });
    if (v.dueDate && v.dueDate < v.invoiceDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Due on or after the invoice date' });
  });
export type CreateSupplierInvoiceInput = z.infer<typeof createSupplierInvoiceSchema>;

export const supplierInvoiceListQuerySchema = z.object({
  legalEntityId: z.uuid(),
  supplierId: z.uuid().optional(),
  /** OPEN = not cancelled and not fully paid; PAID; CANCELLED. */
  status: z.enum(['OPEN', 'PAID', 'CANCELLED']).optional(),
});
export type SupplierInvoiceListQuery = z.infer<typeof supplierInvoiceListQuerySchema>;

export const uninvoicedReceiptsQuerySchema = z.object({ branchId: z.uuid(), supplierId: z.uuid() });
export type UninvoicedReceiptsQuery = z.infer<typeof uninvoicedReceiptsQuerySchema>;

export const cancelSupplierInvoiceSchema = z.object({ reason });
export type CancelSupplierInvoiceInput = z.infer<typeof cancelSupplierInvoiceSchema>;

/**
 * How a supplier is paid. CASH_DRAWER: cash taken from a till's drawer during an open shift (`cashierSessionId`); it is
 * paid today and the drawer's expected cash drops by it (session 36).
 */
export const SUPPLIER_PAYMENT_METHODS = ['BANK_TRANSFER', 'CHECK', 'OTHER', 'CASH_DRAWER'] as const;
const drawerShift = <T extends { method: string; cashierSessionId?: string | undefined }>(v: T, ctx: z.RefinementCtx) => {
  if ((v.method === 'CASH_DRAWER') !== Boolean(v.cashierSessionId)) {
    ctx.addIssue({ code: 'custom', path: ['cashierSessionId'], message: v.method === 'CASH_DRAWER' ? 'Choose the open shift whose drawer pays' : 'Only cash from a drawer names a shift' });
  }
};

export const createSupplierPaymentSchema = z
  .object({
    amount: peso.refine((v) => Number(v) > 0, 'More than zero'),
    paidOn: z.iso.date(),
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    cashierSessionId: z.uuid().optional(),
    reference: optionalText(100),
  })
  .superRefine(drawerShift);
export type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;

/** One payment to a supplier spread over several of its open invoices (session 22); Σ amounts = the payment. */
export const createSupplierBatchPaymentSchema = z
  .object({
    supplierId: z.uuid(),
    paidOn: z.iso.date(),
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    cashierSessionId: z.uuid().optional(),
    reference: optionalText(100),
    allocations: z
      .array(z.object({ supplierInvoiceId: z.uuid(), amount: peso.refine((v) => Number(v) > 0, 'More than zero') }))
      .min(1)
      .max(100),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.allocations.map((a) => a.supplierInvoiceId)).size !== v.allocations.length) {
      ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'Each invoice once' });
    }
    drawerShift(v, ctx);
  });
export type CreateSupplierBatchPaymentInput = z.infer<typeof createSupplierBatchPaymentSchema>;

/** `cashierSessionId`: for a payment made with cash from a drawer, the open shift whose drawer takes the cash back. */
export const voidSupplierPaymentSchema = z.object({ reason, cashierSessionId: z.uuid().optional() });
export type VoidSupplierPaymentInput = z.infer<typeof voidSupplierPaymentSchema>;

/** A supplier's credit note (owed goes down) or debit note (owed goes up) against one invoice (session 22). */
export const createSupplierNoteSchema = z
  .object({
    kind: z.enum(['CREDIT', 'DEBIT']),
    /** The supplier's own number on the note. */
    noteNumber: z.string().trim().min(1).max(60),
    noteDate: z.iso.date(),
    netAmount: peso,
    vatAmount: peso,
    reason: z.string().trim().min(1).max(500),
  })
  .refine((v) => isPositiveDecimal(v.netAmount) || isPositiveDecimal(v.vatAmount), { message: 'More than zero', path: ['netAmount'] });
export type CreateSupplierNoteInput = z.infer<typeof createSupplierNoteSchema>;

export const payablesAgingQuerySchema = z.object({ legalEntityId: z.uuid(), asOf: z.iso.date().optional() });
export type PayablesAgingQuery = z.infer<typeof payablesAgingQuerySchema>;

// ------------------------------------------------------------------ supplier catalog (session 20)

const itemFields = {
  supplierSku: z.string().trim().max(64).nullable().optional(),
  supplierItemName: z.string().trim().max(200).nullable().optional(),
  /** Ex VAT, per unit of the item, as on receipts. */
  unitCost: amountSchema.nullable().optional(),
  /** The supplier to order this item from first (one per item; setting it moves it here). */
  preferred: z.boolean().optional(),
};

export const createSupplierItemSchema = z.object({ variantId: z.uuid(), ...itemFields });
export type CreateSupplierItemInput = z.infer<typeof createSupplierItemSchema>;

export const updateSupplierItemSchema = z.object(itemFields).refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateSupplierItemInput = z.infer<typeof updateSupplierItemSchema>;
