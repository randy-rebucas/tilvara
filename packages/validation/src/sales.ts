import { z } from 'zod';
import { amountSchema, money2Schema } from './catalog.js';
import { isPositiveDecimal } from './decimal.js';
import { oneDiscountRefinement, quantitySchema, rateSchema, taxQuoteLineObject } from './tax.js';

/** A positive amount of money that changes hands: centavos at most (audit 45 #13). */
const positiveMoney = money2Schema.refine(isPositiveDecimal, 'Amount must be greater than zero');
const ref = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use letters, digits, - or _');
/** One tender. */
export const tenderSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CASH'), tendered: money2Schema }),
  z.object({ method: z.literal('INTENT'), paymentIntentId: z.uuid() }),
  /** The sale's customer's store credit (ADR-0018); applied after card/QR, before cash. */
  z.object({ method: z.literal('STORE_CREDIT'), amount: positiveMoney }),
]);
/** Intent tenders (already-authorized non-cash payments) are applied first; cash covers the rest and gives change. */
export const tendersSchema = z
  .array(tenderSchema)
  .min(1)
  .max(10)
  .refine((ts) => ts.filter((t) => t.method === 'STORE_CREDIT').length <= 1, 'Store credit once per sale');
export type TendersInput = z.infer<typeof tendersSchema>;

// ------------------------------------------------------------------ cashier sessions

export const openCashierSessionSchema = z.object({
  registerId: z.uuid(),
  openingFloat: money2Schema,
});
export type OpenCashierSessionInput = z.infer<typeof openCashierSessionSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT']),
  /** Always positive; the type gives the direction. */
  amount: positiveMoney,
  reason: z.string().trim().min(1).max(200),
});
export type CashMovementInput = z.infer<typeof cashMovementSchema>;

export const closeCashierSessionSchema = z.object({
  countedCash: money2Schema,
  note: z.string().trim().max(500).nullable().optional(),
});
export type CloseCashierSessionInput = z.infer<typeof closeCashierSessionSchema>;

export const approveVarianceSchema = z.object({
  note: z.string().trim().min(1).max(500),
});
export type ApproveVarianceInput = z.infer<typeof approveVarianceSchema>;

export const cashierSessionListQuerySchema = z.object({
  registerId: z.uuid().optional(),
  status: z.enum(['OPEN', 'CLOSED', 'RECONCILED']).optional(),
});
export type CashierSessionListQuery = z.infer<typeof cashierSessionListQuerySchema>;

// ------------------------------------------------------------------ sales


export const saleLineSchema = taxQuoteLineObject
  .extend({
    statutory: z
      .object({
        scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
        share: rateSchema.or(z.literal('1')).optional(),
        /** `ref` of an entry in `beneficiaries`. */
        beneficiary: ref,
      })
      .optional(),
  })
  .refine(...oneDiscountRefinement);

/** A counter sale line, with its statutory discount. */
export const counterSaleLineSchema = taxQuoteLineObject
  .extend({
    statutory: z
      .object({
        scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
        share: rateSchema.or(z.literal('1')).optional(),
        beneficiary: ref,
      })
      .optional(),
  })
  .refine(...oneDiscountRefinement);

export const saleBeneficiarySchema = z.object({
  ref,
  scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
  name: z.string().trim().min(1).max(200),
  /** OSCA / PWD ID number. Never capture disability type (data minimisation). */
  idNumber: z.string().trim().min(1).max(64),
  tin: z.string().trim().regex(/^\d{9}(\d{3}|\d{5})?$/, 'TIN is 9 digits (optionally with branch code)').nullable().optional(),
});

/** Beneficiary refs and line ids of a cart: unique, used, and matching their lines' scheme. */
function checkSaleRefs(
  v: { lines: z.infer<typeof saleLineSchema>[] | z.infer<typeof counterSaleLineSchema>[]; beneficiaries: z.infer<typeof saleBeneficiarySchema>[] },
  ctx: z.RefinementCtx,
) {
  const refs = new Set<string>();
  for (const [i, b] of v.beneficiaries.entries()) {
    if (refs.has(b.ref)) ctx.addIssue({ code: 'custom', path: ['beneficiaries', i, 'ref'], message: 'Duplicate beneficiary ref' });
    refs.add(b.ref);
  }
  const lineIds = new Set<string>();
  for (const [i, l] of v.lines.entries()) {
    if (l.id) {
      if (lineIds.has(l.id)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'id'], message: 'Duplicate line id' });
      lineIds.add(l.id);
    }
    if (!l.statutory) continue;
    const b = v.beneficiaries.find((x) => x.ref === l.statutory!.beneficiary);
    if (!b) ctx.addIssue({ code: 'custom', path: ['lines', i, 'statutory', 'beneficiary'], message: 'Unknown beneficiary ref' });
    else if (b.scheme !== l.statutory.scheme) {
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'statutory', 'scheme'], message: 'Line scheme does not match the beneficiary' });
    }
  }
  for (const [i, b] of v.beneficiaries.entries()) {
    if (!v.lines.some((l) => l.statutory?.beneficiary === b.ref)) {
      ctx.addIssue({ code: 'custom', path: ['beneficiaries', i, 'ref'], message: 'Beneficiary is not used by any line' });
    }
  }
}

export const createSaleSchema = z
  .object({
    cashierSessionId: z.uuid(),
    /** Generated by the terminal per checkout; a second sale with the same id on the register is refused. */
    clientTransactionId: ref,
    lines: z.array(counterSaleLineSchema).min(1).max(200),
    beneficiaries: z.array(saleBeneficiarySchema).max(20).default([]),
    tenders: tendersSchema,
    /** The total the cashier saw; if the server total differs (price changed), the sale is refused. */
    expectedAmountDue: amountSchema.optional(),
    /** The customer it is rung up for (ADR-0018); required to pay with their store credit. */
    customerId: z.uuid().optional(),
  })
  .superRefine(checkSaleRefs)
  .refine((v) => v.customerId !== undefined || !v.tenders.some((t) => t.method === 'STORE_CREDIT'), { message: 'Store credit needs the customer on the sale', path: ['customerId'] });
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const createPaymentIntentSchema = z.object({
  cashierSessionId: z.uuid(),
  /** The checkout this payment belongs to (same id the sale will carry). */
  clientTransactionId: ref,
  method: z.enum(['CARD', 'QR', 'EWALLET']),
  amount: positiveMoney,
});
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;

/** Void (full reversal in the original session) or return of some quantities, refunded in cash. */
export const createSaleReturnSchema = z
  .object({
    /** Open session whose drawer pays the refund (same branch as the sale). */
    cashierSessionId: z.uuid(),
    kind: z.enum(['VOID', 'RETURN']),
    reason: z.string().trim().min(1).max(200),
    lines: z
      .array(
        z.object({
          saleLineId: z.uuid(),
          quantity: z
            .string()
            .trim()
            .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1"')
            .refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
          disposition: z.enum(['RESTOCK', 'DAMAGED']),
        }),
      )
      .max(200)
      .optional(),
    /** The refund the cashier saw; refused if the server computes a different amount. */
    expectedRefund: amountSchema.optional(),
    /** CASH (the default) or STORE_CREDIT for a customer (ADR-0018): the sale's customer, or `customerId`. */
    refundTo: z.enum(['CASH', 'STORE_CREDIT']).default('CASH'),
    customerId: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.customerId && v.refundTo !== 'STORE_CREDIT') ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'A customer is only named for a refund as store credit' });
    if (v.kind === 'VOID' && v.lines) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'A void reverses the whole sale; do not list lines' });
    if (v.kind === 'RETURN' && !v.lines?.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'List the lines being returned' });
    const ids = new Set<string>();
    for (const [i, l] of (v.lines ?? []).entries()) {
      if (ids.has(l.saleLineId)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'saleLineId'], message: 'Each sale line once per return' });
      ids.add(l.saleLineId);
    }
  });
export type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;

/** What returning these lines would refund, priced like the return itself; records nothing (session 20). */
export const previewSaleReturnSchema = z.object({
  lines: z
    .array(
      z.object({
        saleLineId: z.uuid(),
        quantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1"').refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
        disposition: z.enum(['RESTOCK', 'DAMAGED']).default('RESTOCK'),
      }),
    )
    .min(1)
    .max(200),
});
export type PreviewSaleReturnInput = z.infer<typeof previewSaleReturnSchema>;

// ------------------------------------------------------------------ counter controls (session 20)

/**
 * Ask for a price change on one item at the counter. Without `email`, the person asking must hold
 * `sales.price_override` at the branch (they approve it themself). With it, a manager who holds it
 * approves on the spot with their own email and password (and their 6-digit code when they use
 * two-step sign-in). `email` is top-level so the per-account rate limit counts the approver.
 */
export const createPriceOverrideSchema = z
  .object({
    branchId: z.uuid(),
    variantId: z.uuid(),
    /** The new unit price, on the same basis as the list price (VAT-inclusive or not). */
    unitPrice: amountSchema,
    /** How many the price is approved for: the line it prices may not sell more at it. */
    quantity: quantitySchema,
    reason: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    password: z.string().min(1).max(128).optional(),
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
  })
  .refine((v) => (v.email === undefined) === (v.password === undefined), { message: 'Give the approver email and password together', path: ['password'] })
  .refine((v) => v.code === undefined || v.email !== undefined, { message: 'A code goes with the approver email', path: ['code'] });
export type CreatePriceOverrideInput = z.infer<typeof createPriceOverrideSchema>;

/** A parked cart: its lines as the counter holds them; nothing is priced or reserved until it is resumed. */
export const createHeldCartSchema = z
  .object({
    cashierSessionId: z.uuid(),
    /** What the cashier calls it ("Lady in blue", a phone number's last digits…). */
    label: z.string().trim().min(1).max(60),
    lines: z
      .array(
        saleLineSchema.and(
          z.object({
            /** Shown in the list of held carts; the price comes back from the server on resume. */
            name: z.string().trim().min(1).max(300),
            sku: z.string().trim().min(1).max(64),
            /** The counter steps the quantity by whole units (+/−) rather than typing a weight. */
            wholeUnits: z.boolean().optional(),
          }),
        ),
      )
      .min(1)
      .max(200),
    beneficiaries: z.array(saleBeneficiarySchema).max(20).default([]),
    amountDue: amountSchema.optional(),
  })
  .superRefine((v, ctx) => {
    for (const [i, l] of v.lines.entries()) {
      if (l.statutory && !v.beneficiaries.some((b) => b.ref === l.statutory!.beneficiary)) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'statutory', 'beneficiary'], message: 'Unknown beneficiary ref' });
      }
    }
  });
export type CreateHeldCartInput = z.infer<typeof createHeldCartSchema>;

export const heldCartListQuerySchema = z.object({ registerId: z.uuid() });
export type HeldCartListQuery = z.infer<typeof heldCartListQuerySchema>;

/** Resume onto the cashier's own open shift on the cart's register. */
export const resumeHeldCartSchema = z.object({ cashierSessionId: z.uuid() });
export type ResumeHeldCartInput = z.infer<typeof resumeHeldCartSchema>;

/**
 * An exchange (SPEC §6.3): return some lines of an earlier sale and sell new items in one go, on
 * the cashier's own shift. The refund pays for the new sale first; the customer pays any rest with
 * `sale.tenders`, or gets the difference back in cash when the new items cost less.
 */
export const createExchangeSchema = z.object({
  cashierSessionId: z.uuid(),
  /** The earlier sale the items come back from (same branch). */
  saleId: z.uuid(),
  reason: z.string().trim().min(1).max(200),
  returnLines: z
    .array(
      z.object({
        saleLineId: z.uuid(),
        quantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use a plain decimal string such as "1"').refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
        disposition: z.enum(['RESTOCK', 'DAMAGED']),
      }),
    )
    .min(1)
    .max(200),
  expectedRefund: amountSchema.optional(),
  sale: z.object({
    clientTransactionId: ref,
    lines: z.array(saleLineSchema).min(1).max(200),
    beneficiaries: z.array(saleBeneficiarySchema).max(20).default([]),
    /** What the customer pays on top of the refund (none when the refund covers the new items). */
    tenders: z
      .array(
        z.discriminatedUnion('method', [
          z.object({ method: z.literal('CASH'), tendered: money2Schema }),
          z.object({ method: z.literal('INTENT'), paymentIntentId: z.uuid() }),
        ]),
      )
      .max(10)
      .default([]),
    expectedAmountDue: amountSchema.optional(),
    customerId: z.uuid().optional(),
  }).superRefine(checkSaleRefs),
}).superRefine((v, ctx) => {
  // Like a return: each sale line once (a repeat hit the unique constraint as a 500, retried forever; audit 45 #31).
  const ids = new Set<string>();
  for (const [i, l] of v.returnLines.entries()) {
    if (ids.has(l.saleLineId)) ctx.addIssue({ code: 'custom', path: ['returnLines', i, 'saleLineId'], message: 'Each sale line once per return' });
    ids.add(l.saleLineId);
  }
});
export type CreateExchangeInput = z.infer<typeof createExchangeSchema>;

export const saleListQuerySchema = z.object({
  cashierSessionId: z.uuid().optional(),
  registerId: z.uuid().optional(),
  /** The number printed on the receipt; numbers are per register, so pair it with `registerId`. */
  saleNumber: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

// ------------------------------------------------------------------ stock

const signedQuantity = z
  .string()
  .trim()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'Use a decimal string such as "12" or "-1.5"')
  .refine((v) => Number(v) !== 0, 'Quantity must not be zero');

export const stockAdjustmentSchema = z
  .object({
    branchId: z.uuid(),
    /** WASTE = spoiled/expired/damaged stock written off (removals only); ADJUSTMENT = any correction. */
    kind: z.enum(['ADJUSTMENT', 'WASTE']).default('ADJUSTMENT'),
    reason: z.string().trim().min(1).max(200),
    items: z
      .array(
        z.object({
          variantId: z.uuid(),
          quantity: signedQuantity,
          /** Cost of stock coming in (ADR-0012); ignored for removals, which leave at the average. Default: the last average, else the reference cost. */
          unitCost: amountSchema.optional(),
          /** Stock coming in: its expiry date and lot (ADR-0020 §3). */
          expiresOn: z.iso.date().optional(),
          lotCode: z.string().trim().min(1).max(40).optional(),
          /** A removal: the lot it takes first (e.g. writing off expired stock). */
          lotId: z.uuid().optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .superRefine((v, ctx) => {
    v.items.forEach((i, n) => {
      const out = i.quantity.startsWith('-');
      if (out && i.expiresOn) ctx.addIssue({ code: 'custom', path: ['items', n, 'expiresOn'], message: 'Only stock coming in takes an expiry date' });
      if (!out && i.lotId) ctx.addIssue({ code: 'custom', path: ['items', n, 'lotId'], message: 'Only a removal names a lot' });
      if (i.lotCode && !i.expiresOn) ctx.addIssue({ code: 'custom', path: ['items', n, 'expiresOn'], message: 'A lot needs its expiry date' });
    });
    if (v.kind !== 'WASTE') return;
    v.items.forEach((i, n) => {
      if (!i.quantity.startsWith('-')) ctx.addIssue({ code: 'custom', path: ['items', n, 'quantity'], message: 'Waste removes stock: use a negative quantity' });
    });
  });
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export const stockQuerySchema = z.object({
  branchId: z.uuid(),
  variantId: z.uuid().optional(),
});
export type StockQuery = z.infer<typeof stockQuerySchema>;

// ------------------------------------------------------------------ reports

const localDate = z.iso.date();

export const reportRangeSchema = z
  .object({
    branchId: z.uuid(),
    /** Inclusive local dates in the branch's timezone. */
    from: localDate,
    to: localDate,
    scheme: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/).optional(),
  })
  .refine((v) => v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'At most 366 days per report', path: ['to'] });
export type ReportRangeQuery = z.infer<typeof reportRangeSchema>;

/** Every branch the person may report on, each in its own local days; optionally one legal entity (session 20). */
export const consolidatedRangeSchema = z
  .object({ from: localDate, to: localDate, legalEntityId: z.uuid().optional() })
  .refine((v) => v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'At most 366 days per report', path: ['to'] });
export type ConsolidatedRangeQuery = z.infer<typeof consolidatedRangeSchema>;

/** Take the Z-reading of a register for one local business day (session 16). */
export const zReadingSchema = z.object({ day: z.iso.date() });
export type ZReadingInput = z.infer<typeof zReadingSchema>;
