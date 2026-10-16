import { z } from 'zod';
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
