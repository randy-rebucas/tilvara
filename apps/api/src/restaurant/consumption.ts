import { stockChangePosting } from '@1pos/accounting';
import { and, desc, inArray, lte, recipeIngredients, recipeVersions, stockAdjustments, stockMovements, type Database } from '@1pos/database';
import { Dec, quantity as qty4, toDec } from '@1pos/money';
import { post } from '../accounting/ledger.js';
import { effectiveNowSql } from '../common/clock.js';
import { openPacksForSale } from '../inventory/packs.service.js';

export interface ConsumingLine {
  saleLineId: string;
  /** The sold item (does not track stock itself). */
  variantId: string;
  quantity: string;
  /**
   * A check's share of a bill line (ADR-0014 §8): how much of the line earlier checks sold. The share
   * consumes the rounded running total less what was rounded before, so the shares of a split dish
   * consume exactly what the whole dish would (a trace amount is not lost to rounding on each share).
   */
  soldBefore?: string;
  /**
   * Set when a check of this bill line was voided (audit 2026-10-21): how much of the line was consumed
   * by every check so far, voided ones included (cooked food is never restocked). A share paid again
   * consumes only what goes beyond it.
   */
  consumedBefore?: string;
}

export interface PlannedConsumption {
  saleLineId: string;
  variantId: string;
  /** Negative: stock leaving for the dish. */
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

/** A share's consumption: rounded (before + share) × recipe less rounded before × recipe; null when nothing. */
const consumedShare = (before: string, share: string, perUnit: string) => {
  const q = qty4(toDec(before).plus(share).times(perUnit)).minus(qty4(toDec(before).times(perUnit)));
  return q.isZero() ? null : q.negated().toString();
};

/** A share paid again after a voided check: rounded max(consumed, before + share) × recipe less rounded consumed × recipe. */
const consumedAgain = (consumedSoFar: string, before: string, share: string, perUnit: string) => {
  const upTo = Dec.max(toDec(consumedSoFar), toDec(before).plus(share));
  const q = qty4(upTo.times(perUnit)).minus(qty4(toDec(consumedSoFar).times(perUnit)));
  return q.lte(0) ? null : q.negated().toString();
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
      const quantity = line.consumedBefore
        ? consumedAgain(line.consumedBefore, line.soldBefore ?? '0', line.quantity, i.quantity)
        : line.soldBefore ? consumedShare(line.soldBefore, line.quantity, i.quantity) : consumed(line.quantity, i.quantity);
      return quantity ? [{ saleLineId: line.saleLineId, variantId: i.variantId, quantity, recipeVersionId: recipe.recipeVersionId }] : [];
    });
  });
}

/**
 * Stock thrown away for prepared items (ADR-0014 §6: a void after preparation started), and goods
 * returned damaged at the counter (ADR-0011 amendment): tracked
 * items leave as themselves, recipe items as their ingredients. Writes one WASTE stock adjustment
 * with its movements (costed by the ledger trigger) and posts it to Spoilage and waste, in the
 * caller's transaction. Returns null when nothing tracked was involved.
 */
export async function recordPreparedWaste(
  db: Database,
  p: {
    tenantId: string; branchId: string; legalEntityId: string; reason: string; userId: string; items: { variantId: string; quantity: string; tracked: boolean }[];
    /** Waste taken from the shelf (a void after preparation): pieces short come out of packs, as a sale's would (ADR-0020 §2). */
    openPacks?: boolean;
  },
): Promise<string | null> {
  const recipes = await recipesInForce(db, p.items.filter((i) => !i.tracked).map((i) => i.variantId));
  const out = new Map<string, Dec>();
  const add = (variantId: string, q: string | null) => {
    if (q) out.set(variantId, (out.get(variantId) ?? new Dec(0)).plus(q));
  };
  for (const i of p.items) {
    if (i.tracked) add(i.variantId, toDec(i.quantity).negated().toString());
    else for (const ing of recipes.get(i.variantId)?.ingredients ?? []) add(ing.variantId, consumed(i.quantity, ing.quantity));
  }
  if (!out.size) return null;
  // Opening locks every balance involved in variant order first, as the movements below then do.
  if (p.openPacks) {
    await openPacksForSale(
      db,
      { tenantId: p.tenantId, branchId: p.branchId, legalEntityId: p.legalEntityId, userId: p.userId, reason: p.reason },
      [...out.entries()].map(([variantId, quantity]) => ({ variantId, quantity: quantity.negated().toString() })),
    );
  }
  const [doc] = await db.insert(stockAdjustments).values({ tenantId: p.tenantId, branchId: p.branchId, kind: 'WASTE', reason: p.reason, createdBy: p.userId }).returning({ id: stockAdjustments.id });
  const rows = await db
    .insert(stockMovements)
    .values(
      [...out.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // lock order (ADR-0012 §7)
        .map(([variantId, quantity]) => ({ tenantId: p.tenantId, branchId: p.branchId, variantId, quantity: quantity.toString(), type: 'WASTE', reason: p.reason, stockAdjustmentId: doc!.id, createdBy: p.userId })),
    )
    .returning({ value: stockMovements.value });
  await post(db, {
    tenantId: p.tenantId,
    legalEntityId: p.legalEntityId,
    branchId: p.branchId,
    sourceType: 'STOCK_ADJUSTMENT',
    sourceId: doc!.id,
    memo: `Waste: ${p.reason}`,
    lines: stockChangePosting('WASTE', rows.reduce((a, r) => a.plus(r.value), new Dec(0)), p.branchId),
    createdBy: p.userId,
  });
  return doc!.id;
}
