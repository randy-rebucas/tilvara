import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { productVariants } from './catalog.js';

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

// ------------------------------------------------------------------ recipes (ADR-0014 §4; a salon's "supplies used", ADR-0022 §9)
// ------------------------------------------------------------------ recipes (ADR-0014 §4)

/**
 * What one unit of a sold item consumes, as of `effective_from`. Append-only and never backdated
 * (DB triggers), so the version a sale consumed with never changes; the one in force at T is the
 * latest with effective_from <= T. A version without ingredients stops consumption from then on.
 */
export const recipeVersions = pgTable(
  'recipe_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    /** The sold item (does not track inventory itself). */
    variantId: uuid('variant_id').notNull(),
    version: integer('version').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    note: text('note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recipe_versions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('recipe_versions_version_unique').on(t.tenantId, t.variantId, t.version),
    unique('recipe_versions_effective_unique').on(t.tenantId, t.variantId, t.effectiveFrom),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    index('recipe_versions_lookup_idx').on(t.tenantId, t.variantId, t.effectiveFrom.desc()),
    check('recipe_versions_version_check', sql`${t.version} > 0`),
  ],
);

/** One ingredient of a recipe version: quantity per one unit sold, in the ingredient's own unit. */
export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    recipeVersionId: uuid('recipe_version_id').notNull(),
    ingredientVariantId: uuid('ingredient_variant_id').notNull(),
    quantity: qty('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recipe_ingredients_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('recipe_ingredients_ingredient_unique').on(t.tenantId, t.recipeVersionId, t.ingredientVariantId),
    foreignKey({ columns: [t.tenantId, t.recipeVersionId], foreignColumns: [recipeVersions.tenantId, recipeVersions.id] }),
    foreignKey({ columns: [t.tenantId, t.ingredientVariantId], foreignColumns: [productVariants.tenantId, productVariants.id] }),
    check('recipe_ingredients_quantity_check', sql`${t.quantity} > 0`),
  ],
);
