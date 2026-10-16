import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  desc,
  eq,
  inArray,
  products,
  productVariants,
  recipeIngredients,
  recipeVersions,
  sql,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CreateRecipeVersionInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { dbNow, effectiveNow } from '../common/clock.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';

/** Clock-skew tolerance for "effective now"; the DB trigger allows 5 minutes. */
const BACKDATE_TOLERANCE_MS = 60_000;

/** Versioned recipes (ADR-0014 §4). Consumption itself happens in checkout (`planConsumption`). */
@Injectable()
export class RecipesService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    recipe_versions_effective_unique: ['RECIPE_VERSION_EXISTS', 'A recipe version already starts at this moment for this item'],
    recipe_versions_version_unique: ['RECIPE_VERSION_EXISTS', 'Another recipe version was saved at the same time; reload and try again'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  history(auth: AuthContext, variantId: string) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      await this.item(db, variantId);
      const versions = await db.select().from(recipeVersions).where(eq(recipeVersions.variantId, variantId)).orderBy(desc(recipeVersions.effectiveFrom));
      const ingredients = versions.length
        ? await db
            .select({ row: recipeIngredients, sku: productVariants.sku, name: productVariants.name })
            .from(recipeIngredients)
            .innerJoin(productVariants, eq(productVariants.id, recipeIngredients.ingredientVariantId))
            .where(inArray(recipeIngredients.recipeVersionId, versions.map((v) => v.id)))
            .orderBy(productVariants.sku)
        : [];
      const now = (await effectiveNow(db)).getTime();
      const inForce = versions.find((v) => v.effectiveFrom.getTime() <= now)?.id ?? null;
      return {
        data: versions.map((v) => ({
          ...v,
          state: v.id === inForce ? 'IN_FORCE' : v.effectiveFrom.getTime() > now ? 'SCHEDULED' : 'SUPERSEDED',
          ingredients: ingredients
            .filter((i) => i.row.recipeVersionId === v.id)
            .map((i) => ({ variantId: i.row.ingredientVariantId, sku: i.sku, name: i.name, quantity: toDec(i.row.quantity).toString() })),
        })),
      };
    });
  }

  create(auth: AuthContext, variantId: string, input: CreateRecipeVersionInput) {
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      const item = await this.item(db, variantId);
      this.assertCan(auth, 'restaurant.manage');
      await assertFeature(db, 'restaurant');
      if (item.archivedAt) throw archived('Item');
      if (item.trackInventory) {
        throw unprocessable('RECIPE_ITEM_TRACKS_STOCK', 'This item tracks its own stock; a recipe is for items made from stocked ingredients');
      }
      const ids = input.ingredients.map((i) => i.variantId);
      const found = ids.length
        ? await db
            .select({ id: productVariants.id, archivedAt: productVariants.archivedAt, trackInventory: products.trackInventory })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(inArray(productVariants.id, ids))
        : [];
      input.ingredients.forEach((ing, idx) => {
        const v = found.find((f) => f.id === ing.variantId);
        if (!v) throw new AppError('NOT_FOUND', 'Ingredient not found', HttpStatus.NOT_FOUND, { path: ['ingredients', idx, 'variantId'] });
        if (v.archivedAt) throw unprocessable('ARCHIVED', 'This ingredient is archived', { path: ['ingredients', idx, 'variantId'] });
        if (!v.trackInventory) throw unprocessable('INGREDIENT_NOT_STOCKED', 'An ingredient must be an item that tracks stock', { path: ['ingredients', idx, 'variantId'] });
      });
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : undefined;
      if (effectiveFrom && effectiveFrom.getTime() < (await dbNow(db)).getTime() - BACKDATE_TOLERANCE_MS) {
        throw unprocessable('RECIPE_BACKDATED', 'A recipe can only take effect now or in the future; past sales keep the recipe they consumed with');
      }

      // One writer per item at a time, so version numbers stay 1, 2, 3, …
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'recipe:' + variantId}, 0))`);
      const [{ next }] = (await db.execute<{ next: number }>(
        sql`SELECT coalesce(max(version), 0) + 1 AS next FROM recipe_versions WHERE variant_id = ${variantId}`,
      )).rows as [{ next: number }];
      const [version] = await db
        .insert(recipeVersions)
        .values({ tenantId, variantId, version: Number(next), effectiveFrom: effectiveFrom ?? sql`now()`, note: input.note ?? null, createdBy: auth.userId })
        .returning();
      if (input.ingredients.length) {
        await db.insert(recipeIngredients).values(
          input.ingredients.map((i) => ({ tenantId, recipeVersionId: version!.id, ingredientVariantId: i.variantId, quantity: i.quantity })),
        );
      }
      await this.audit(db, auth, 'recipe.versioned', 'variant', variantId, {
        recipeVersionId: version!.id,
        version: version!.version,
        effectiveFrom: version!.effectiveFrom,
        ingredients: input.ingredients.length,
      });
      return {
        ...version!,
        ingredients: input.ingredients.map((i) => ({ variantId: i.variantId, quantity: toDec(i.quantity).toString() })),
      };
    });
  }

  private async item(db: Database, variantId: string) {
    const [row] = await db
      .select({ id: productVariants.id, archivedAt: productVariants.archivedAt, trackInventory: products.trackInventory })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, variantId));
    if (!row) throw notFound('Item');
    return row;
  }
}
