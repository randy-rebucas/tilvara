import { and, desc, inArray, lte, recipeIngredients, recipeVersions, type Database } from '@1pos/database';
import { quantity as qty4, toDec } from '@1pos/money';
import { effectiveNowSql } from '../common/clock.js';

export interface ConsumingLine {
  saleLineId: string;
  /** The sold item (does not track stock itself). */
  variantId: string;
  quantity: string;
}

export interface PlannedConsumption {
  saleLineId: string;
  variantId: string;
  /** Negative: stock leaving for the sold item. */
  quantity: string;
  recipeVersionId: string;
}

/** For each item with a recipe version in force now (DB clock): that version and its ingredients. */
export async function recipesInForce(db: Database, variantIds: string[]) {
  const out = new Map<string, { recipeVersionId: string; ingredients: { variantId: string; quantity: string }[] }>();
  const items = [...new Set(variantIds)];
  if (!items.length) return out;
  const versions = await db
    .selectDistinctOn([recipeVersions.variantId], { id: recipeVersions.id, variantId: recipeVersions.variantId })
    .from(recipeVersions)
    .where(and(inArray(recipeVersions.variantId, items), lte(recipeVersions.effectiveFrom, effectiveNowSql)))
    .orderBy(recipeVersions.variantId, desc(recipeVersions.effectiveFrom));
  if (!versions.length) return out;
  const ingredients = await db.select().from(recipeIngredients).where(inArray(recipeIngredients.recipeVersionId, versions.map((v) => v.id)));
  for (const v of versions) {
    out.set(v.variantId, {
      recipeVersionId: v.id,
      ingredients: ingredients.filter((i) => i.recipeVersionId === v.id).map((i) => ({ variantId: i.ingredientVariantId, quantity: i.quantity })),
    });
  }
  return out;
}

/** Sold quantity × recipe quantity at the ledger's 4 dp, negated; null when it rounds to nothing. */
const consumed = (sold: string, perUnit: string) => {
  const q = qty4(toDec(sold).times(perUnit));
  return q.isZero() ? null : q.negated().toString();
};

/**
 * Ingredient movements for sold lines (ADR-0014 §4): for each line whose item has a recipe version
 * in force (DB clock), one CONSUMPTION per ingredient = sold quantity × recipe quantity, rounded to
 * the ledger's 4 dp. Lines without a recipe consume nothing. The caller inserts them, sorted by
 * variant together with the sale's other movements (lock order, ADR-0012 §7).
 */
export async function planConsumption(db: Database, lines: ConsumingLine[]): Promise<PlannedConsumption[]> {
  const recipes = await recipesInForce(db, lines.map((l) => l.variantId));
  return lines.flatMap((line) => {
    const recipe = recipes.get(line.variantId);
    if (!recipe) return [];
    // A trace amount that rounds to 0 at 4 dp moves nothing (the ledger refuses zero rows).
    return recipe.ingredients.flatMap((i) => {
      const quantity = consumed(line.quantity, i.quantity);
      return quantity ? [{ saleLineId: line.saleLineId, variantId: i.variantId, quantity, recipeVersionId: recipe.recipeVersionId }] : [];
    });
  });
}
