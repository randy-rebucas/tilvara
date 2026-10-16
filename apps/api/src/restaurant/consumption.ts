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
  /** Negative: stock leaving for the dish. */
  quantity: string;
  recipeVersionId: string;
}

/**
 * Ingredient movements for sold lines (ADR-0014 §4): for each line whose item has a recipe version
 * in force (DB clock), one CONSUMPTION per ingredient = sold quantity × recipe quantity, rounded to
 * the ledger's 4 dp. Lines without a recipe consume nothing. The caller inserts them, sorted by
 * variant together with the sale's other movements (lock order, ADR-0012 §7).
 */
export async function planConsumption(db: Database, lines: ConsumingLine[]): Promise<PlannedConsumption[]> {
  if (!lines.length) return [];
  const items = [...new Set(lines.map((l) => l.variantId))];
  const versions = await db
    .selectDistinctOn([recipeVersions.variantId], { id: recipeVersions.id, variantId: recipeVersions.variantId })
    .from(recipeVersions)
    .where(and(inArray(recipeVersions.variantId, items), lte(recipeVersions.effectiveFrom, effectiveNowSql)))
    .orderBy(recipeVersions.variantId, desc(recipeVersions.effectiveFrom));
  if (!versions.length) return [];
  const ingredients = await db
    .select()
    .from(recipeIngredients)
    .where(inArray(recipeIngredients.recipeVersionId, versions.map((v) => v.id)));

  return lines.flatMap((line) => {
    const version = versions.find((v) => v.variantId === line.variantId);
    if (!version) return [];
    return ingredients
      .filter((i) => i.recipeVersionId === version.id)
      .map((i) => ({
        saleLineId: line.saleLineId,
        variantId: i.ingredientVariantId,
        quantity: qty4(toDec(line.quantity).times(i.quantity)).negated().toString(),
        recipeVersionId: version.id,
      }))
      // A trace amount that rounds to 0 at 4 dp moves nothing (the ledger refuses zero rows).
      .filter((m) => !toDec(m.quantity).isZero());
  });
}
