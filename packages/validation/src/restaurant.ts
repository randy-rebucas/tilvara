import { z } from 'zod';
import { amountSchema } from './catalog.js';
import { clientRefSchema, saleBeneficiarySchema, tendersSchema } from './sales.js';
import { quantitySchema, rateSchema } from './tax.js';

const name = z.string().trim().min(1).max(100);
const sortOrder = z.number().int().min(0).max(100_000);
/** Kitchen route, e.g. "GRILL", "BAR". */
export const stationCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,15}$/, 'Use up to 16 letters, digits or underscores, starting with a letter');
const nonEmpty = <T extends z.ZodObject>(s: T) => s.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// ------------------------------------------------------------------ stations, areas, tables (ADR-0014 §5)

export const createKitchenStationSchema = z.object({ branchId: z.uuid(), code: stationCodeSchema, name, isDefault: z.boolean().default(false) });
export type CreateKitchenStationInput = z.infer<typeof createKitchenStationSchema>;
export const updateKitchenStationSchema = nonEmpty(z.object({ name, isDefault: z.boolean() }));
export type UpdateKitchenStationInput = z.infer<typeof updateKitchenStationSchema>;

export const createDiningAreaSchema = z.object({ branchId: z.uuid(), name, sortOrder: sortOrder.default(0) });
export type CreateDiningAreaInput = z.infer<typeof createDiningAreaSchema>;
export const updateDiningAreaSchema = nonEmpty(z.object({ name, sortOrder }));
export type UpdateDiningAreaInput = z.infer<typeof updateDiningAreaSchema>;

const tableFields = {
  code: z.string().trim().min(1).max(20),
  seats: z.number().int().min(1).max(99),
  /** Floor-plan placement in grid units; both or neither. */
  position: z.object({ x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) }).nullable(),
  shape: z.enum(['SQUARE', 'ROUND', 'RECT']).nullable(),
};
export const createRestaurantTableSchema = z.object({
  areaId: z.uuid(),
  code: tableFields.code,
  seats: tableFields.seats.default(2),
  position: tableFields.position.optional(),
  shape: tableFields.shape.optional(),
});
export type CreateRestaurantTableInput = z.infer<typeof createRestaurantTableSchema>;
export const updateRestaurantTableSchema = nonEmpty(z.object({ areaId: z.uuid(), ...tableFields }));
export type UpdateRestaurantTableInput = z.infer<typeof updateRestaurantTableSchema>;

// ------------------------------------------------------------------ modifiers (ADR-0014 §3)

const modifierOption = z.object({
  name,
  /** A priced option points to an item (its branch price is the charge); free options have none. */
  variantId: z.uuid().nullable().optional(),
  sortOrder: sortOrder.optional(),
});
export const createModifierOptionSchema = modifierOption;
export type CreateModifierOptionInput = z.infer<typeof createModifierOptionSchema>;

const selectBounds = <T extends { minSelect?: number; maxSelect?: number }>(v: T, ctx: z.RefinementCtx) => {
  if (v.minSelect !== undefined && v.maxSelect !== undefined && v.maxSelect < v.minSelect) {
    ctx.addIssue({ code: 'custom', path: ['maxSelect'], message: 'Maximum must be at least the minimum' });
  }
};
export const createModifierGroupSchema = z
  .object({
    name,
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    options: z.array(modifierOption).min(1).max(50),
  })
  .superRefine((v, ctx) => {
    selectBounds(v, ctx);
    if (v.minSelect > v.options.length) ctx.addIssue({ code: 'custom', path: ['minSelect'], message: 'More required choices than options' });
    const seen = new Set<string>();
    v.options.forEach((o, i) => {
      const k = o.name.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['options', i, 'name'], message: 'Each option name once per group' });
      seen.add(k);
    });
  });
export type CreateModifierGroupInput = z.infer<typeof createModifierGroupSchema>;
export const updateModifierGroupSchema = z
  .object({ name, minSelect: z.number().int().min(0).max(20), maxSelect: z.number().int().min(1).max(20) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .superRefine(selectBounds);
export type UpdateModifierGroupInput = z.infer<typeof updateModifierGroupSchema>;

// ------------------------------------------------------------------ menus (ADR-0014 §2)

export const createMenuSchema = z.object({ name });
export type CreateMenuInput = z.infer<typeof createMenuSchema>;
export const updateMenuSchema = z.object({ name });
export type UpdateMenuInput = z.infer<typeof updateMenuSchema>;

/** The whole content of a draft version, replaced at once (order = display order). */
export const menuContentSchema = z
  .object({
    sections: z
      .array(
        z.object({
          name,
          items: z
            .array(
              z.object({
                variantId: z.uuid(),
                displayName: z.string().trim().min(1).max(100).nullable().optional(),
                stationCode: stationCodeSchema.nullable().optional(),
                modifierGroupIds: z.array(z.uuid()).max(10).default([]),
              }),
            )
            .max(300),
        }),
      )
      .max(50),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.sections.forEach((s, si) =>
      s.items.forEach((it, ii) => {
        if (seen.has(it.variantId)) ctx.addIssue({ code: 'custom', path: ['sections', si, 'items', ii, 'variantId'], message: 'Each item once per menu' });
        seen.add(it.variantId);
        if (new Set(it.modifierGroupIds).size !== it.modifierGroupIds.length) {
          ctx.addIssue({ code: 'custom', path: ['sections', si, 'items', ii, 'modifierGroupIds'], message: 'Each modifier group once per item' });
        }
      }),
    );
  });
export type MenuContentInput = z.infer<typeof menuContentSchema>;

// ------------------------------------------------------------------ per-branch settings and 86

export const restaurantSettingsSchema = z.object({
  dineInMenuId: z.uuid().nullable(),
  takeawayMenuId: z.uuid().nullable(),
  /** Fraction, e.g. "0.10"; "0" turns the service charge off. At most 30 %. */
  serviceChargeRate: rateSchema.refine((v) => Number(v) <= 0.3, 'At most 30 %'),
  serviceChargeDineIn: z.boolean(),
  serviceChargeTakeaway: z.boolean(),
  serviceChargeVatTreatment: z.enum(['VATABLE', 'VAT_EXEMPT']),
});
export type RestaurantSettingsInput = z.infer<typeof restaurantSettingsSchema>;

export const soldOutSchema = z.object({
  variantId: z.uuid(),
  soldOut: z.boolean(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type SoldOutInput = z.infer<typeof soldOutSchema>;

export const branchMenuQuerySchema = z.object({ orderType: z.enum(['DINE_IN', 'TAKEAWAY']).default('DINE_IN') });
export type BranchMenuQuery = z.infer<typeof branchMenuQuerySchema>;

// ------------------------------------------------------------------ orders (ADR-0014 §6)

const reason = z.string().trim().min(1).max(200);
const course = z.number().int().min(1).max(9);
const seat = z.number().int().min(1).max(500);

export const openOrderSchema = z
  .object({
    branchId: z.uuid(),
    orderType: z.enum(['DINE_IN', 'TAKEAWAY']),
    tableId: z.uuid().optional(),
    guestCount: z.number().int().min(1).max(500).optional(),
    customerName: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.orderType === 'DINE_IN' && !v.tableId) ctx.addIssue({ code: 'custom', path: ['tableId'], message: 'Dine-in orders need a table' });
    if (v.orderType === 'TAKEAWAY' && v.tableId) ctx.addIssue({ code: 'custom', path: ['tableId'], message: 'Takeaway orders have no table' });
  });
export type OpenOrderInput = z.infer<typeof openOrderSchema>;

export const orderListQuerySchema = z.object({ branchId: z.uuid(), status: z.enum(['LIVE', 'ALL']).default('LIVE') });
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const addOrderItemsSchema = z.object({
  items: z
    .array(
      z.object({
        /** The menu item's variant on the branch's published menu for this order type. */
        variantId: z.uuid(),
        quantity: quantitySchema,
        course: course.default(1),
        seat: seat.optional(),
        note: z.string().trim().min(1).max(200).optional(),
        modifierOptionIds: z.array(z.uuid()).max(30).default([]),
      }),
    )
    .min(1)
    .max(50),
});
export type AddOrderItemsInput = z.infer<typeof addOrderItemsSchema>;

export const updateOrderItemSchema = z
  .object({ quantity: quantitySchema, course, seat: seat.nullable(), note: z.string().trim().min(1).max(200).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateOrderItemInput = z.infer<typeof updateOrderItemSchema>;

export const voidOrderItemSchema = z.object({
  reason,
  /** Preparation had started and the food is thrown away: its stock is written off as waste. */
  wasted: z.boolean().default(false),
});
export type VoidOrderItemInput = z.infer<typeof voidOrderItemSchema>;

/** A note for one course of an order; `note: null` removes it. Copied onto the course's tickets when fired. */
export const courseNoteSchema = z.object({ course, note: z.string().trim().min(1).max(200).nullable() });
export type CourseNoteInput = z.infer<typeof courseNoteSchema>;

export const fireOrderSchema = z.object({
  /** Courses to send now; omitted = every pending item. */
  courses: z.array(course).min(1).max(9).optional(),
});
export type FireOrderInput = z.infer<typeof fireOrderSchema>;

export const transferOrderSchema = z.object({ tableId: z.uuid() });
export type TransferOrderInput = z.infer<typeof transferOrderSchema>;

export const mergeOrderSchema = z.object({ intoOrderId: z.uuid() });
export type MergeOrderInput = z.infer<typeof mergeOrderSchema>;

export const moveOrderItemsSchema = z
  .object({
    itemIds: z.array(z.uuid()).min(1).max(100),
    /** Into an existing open order of the same branch … */
    toOrderId: z.uuid().optional(),
    /** … or into a new dine-in order on this free table. */
    toTableId: z.uuid().optional(),
  })
  .refine((v) => (v.toOrderId ? 1 : 0) + (v.toTableId ? 1 : 0) === 1, { message: 'Give either toOrderId or toTableId', path: ['toOrderId'] });
export type MoveOrderItemsInput = z.infer<typeof moveOrderItemsSchema>;

export const cancelOrderSchema = z.object({ reason });
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

// ------------------------------------------------------------------ bills and checks (ADR-0014 §8)

export const createBillSchema = z
  .object({
    /** Order-level discount on every line without a statutory discount, e.g. "0.10". Needs sales.discount. */
    discountRate: rateSchema.refine((v) => Number(v) > 0, 'Discount must be above zero').optional(),
    beneficiaries: z.array(saleBeneficiarySchema).max(20).default([]),
    /** SC/PWD diners' items: the whole item (itemized) or a share of a shared item (headcount, e.g. "0.25"). */
    statutory: z
      .array(z.object({ orderItemId: z.uuid(), beneficiary: clientRefSchema, share: rateSchema.or(z.literal('1')).optional() }))
      .max(200)
      .default([]),
    /**
     * Per-item discounts and comps (rate "1" = on the house), each with its reason; an item's priced
     * choices follow it. An item's own rate replaces the order-level one (no stacking), and an item
     * with an SC/PWD discount takes no other. Needs sales.discount (session 22).
     */
    itemDiscounts: z
      .array(z.object({
        orderItemId: z.uuid(),
        rate: rateSchema.refine((v) => Number(v) > 0, 'Discount must be above zero').or(z.literal('1')),
        reason: z.string().trim().min(1).max(200),
      }))
      .max(200)
      .default([]),
    /** The total shown before printing; if the server total differs, the bill is refused. */
    expectedAmountDue: amountSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const discounted = new Set<string>();
    v.itemDiscounts.forEach((d, i) => {
      if (discounted.has(d.orderItemId)) ctx.addIssue({ code: 'custom', path: ['itemDiscounts', i, 'orderItemId'], message: 'One discount per item' });
      discounted.add(d.orderItemId);
      if (v.statutory.some((s) => s.orderItemId === d.orderItemId)) {
        ctx.addIssue({ code: 'custom', path: ['itemDiscounts', i, 'orderItemId'], message: 'An item with an SC/PWD discount takes no other discount' });
      }
    });
    const refs = new Set(v.beneficiaries.map((b) => b.ref));
    if (refs.size !== v.beneficiaries.length) ctx.addIssue({ code: 'custom', path: ['beneficiaries'], message: 'Duplicate beneficiary ref' });
    const items = new Set<string>();
    v.statutory.forEach((s, i) => {
      if (!refs.has(s.beneficiary)) ctx.addIssue({ code: 'custom', path: ['statutory', i, 'beneficiary'], message: 'Unknown beneficiary ref' });
      if (items.has(s.orderItemId)) ctx.addIssue({ code: 'custom', path: ['statutory', i, 'orderItemId'], message: 'One statutory discount per item' });
      items.add(s.orderItemId);
    });
    v.beneficiaries.forEach((b, i) => {
      if (!v.statutory.some((s) => s.beneficiary === b.ref)) ctx.addIssue({ code: 'custom', path: ['beneficiaries', i, 'ref'], message: 'Beneficiary is not used by any item' });
    });
  });
export type CreateBillInput = z.infer<typeof createBillSchema>;

export const voidBillSchema = z.object({ reason });
export type VoidBillInput = z.infer<typeof voidBillSchema>;

/** A share of a bill line: whole units of it, or an even part (n of d, e.g. 1 of 3). */
export const billAllocationSchema = z
  .object({
    billLineId: z.uuid(),
    quantity: quantitySchema.optional(),
    share: z.object({ num: z.number().int().min(1).max(999), den: z.number().int().min(1).max(999) }).refine((s) => s.num <= s.den, 'A share is at most the whole line').optional(),
  })
  .refine((a) => (a.quantity ? 1 : 0) + (a.share ? 1 : 0) <= 1, 'Give quantity or share, not both');

export const createCheckSchema = z.object({
  cashierSessionId: z.uuid(),
  clientTransactionId: clientRefSchema,
  /** Which bill lines (and how much of each) this check pays; omitted = everything still unpaid. */
  allocations: z.array(billAllocationSchema).min(1).max(200).optional(),
  tenders: tendersSchema,
  expectedAmountDue: amountSchema.optional(),
});
export type CreateCheckInput = z.infer<typeof createCheckSchema>;

/** What a check would pay (same allocations, nothing recorded): the till shows it before taking money. */
export const previewCheckSchema = z.object({ allocations: createCheckSchema.shape.allocations });
export type PreviewCheckInput = z.infer<typeof previewCheckSchema>;

// ------------------------------------------------------------------ kitchen (ADR-0014 §7)

export const itemStatusSchema = z.object({ status: z.enum(['IN_PREP', 'READY', 'SERVED']) });
export type ItemStatusInput = z.infer<typeof itemStatusSchema>;

export const kitchenTicketQuerySchema = z.object({ branchId: z.uuid(), stationId: z.uuid().optional(), status: z.enum(['OPEN', 'ALL']).default('OPEN') });
export type KitchenTicketQuery = z.infer<typeof kitchenTicketQuerySchema>;

/**
 * A new recipe version for a sold item (ADR-0014 §4): what one unit consumes, in each ingredient's
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
