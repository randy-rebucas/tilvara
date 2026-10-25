import { expiredStockRule, sellableAt, tillDrugs } from '../pharmacy/drugs.js';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  barcodes,
  branches,
  branchPriceLists,
  eq,
  inArray,
  isNull,
  priceLists,
  productPrices,
  products,
  productVariants,
  sql,
  taxCategories,
  unitsOfMeasure,
  type Database,
  inSequence,
} from '@1pos/database';
import type { AssignPriceListInput, CreatePriceListInput, SetPricesInput, UpdatePriceListInput } from '@1pos/validation';
import { parseScaleLabel } from '@1pos/sync-protocol';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { dbNow, EFFECTIVE_SKEW, effectiveNowSql } from '../common/clock.js';

/** Allowed clock skew for "now" prices; anything earlier is a backdated price and refused. */
const BACKDATE_TOLERANCE_MS = 60_000;

export interface EffectivePrice {
  priceId: string;
  priceListId: string;
  variantId: string;
  amount: string;
  currency: string;
  pricesIncludeTax: boolean;
  effectiveFrom: Date;
}

@Injectable()
export class PricingService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    price_lists_tenant_name_unique: ['NAME_TAKEN', 'A price list with this name already exists'],
    product_prices_version_unique: ['PRICE_VERSION_EXISTS', 'A price for this item already starts at that exact time'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  listPriceLists(auth: AuthContext) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const [lists, assigned] = await inSequence(
        () => db.select().from(priceLists).orderBy(asc(priceLists.name)),
        () => db.select({ branchId: branchPriceLists.branchId, priceListId: branchPriceLists.priceListId }).from(branchPriceLists),
      );
      // Which branches use each list explicitly (a branch with none uses the default list).
      return lists.map((l) => ({ ...l, branchIds: assigned.filter((a) => a.priceListId === l.id).map((a) => a.branchId) }));
    });
  }

  createPriceList(auth: AuthContext, input: CreatePriceListInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      if (input.isDefault) await this.clearDefault(db);
      const [row] = await db.insert(priceLists).values({ ...input, tenantId: tenantOf(auth).tenantId }).returning();
      await this.audit(db, auth, 'price_list.created', 'price_list', row!.id, { isDefault: row!.isDefault });
      return row!;
    });
  }

  updatePriceList(auth: AuthContext, id: string, input: UpdatePriceListInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const list = await this.activeList(db, id);
      if (input.isDefault && !list.isDefault) await this.clearDefault(db);
      const [row] = await db.update(priceLists).set(input).where(eq(priceLists.id, id)).returning();
      await this.audit(db, auth, 'price_list.updated', 'price_list', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  assignBranchPriceList(auth: AuthContext, branchId: string, input: AssignPriceListInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId));
      if (!branch) throw notFound('Branch');
      if (input.priceListId === null) {
        await db.delete(branchPriceLists).where(eq(branchPriceLists.branchId, branchId));
      } else {
        await this.activeList(db, input.priceListId);
        await db
          .insert(branchPriceLists)
          .values({ tenantId: tenantOf(auth).tenantId, branchId, priceListId: input.priceListId })
          .onConflictDoUpdate({
            target: [branchPriceLists.tenantId, branchPriceLists.branchId],
            set: { priceListId: input.priceListId, updatedAt: new Date() },
          });
      }
      await this.audit(db, auth, 'branch.price_list_assigned', 'branch', branchId, { priceListId: input.priceListId });
      return { branchId, priceListId: input.priceListId };
    });
  }

  /** Append new price versions. History is never edited. */
  setPrices(auth: AuthContext, priceListId: string, input: SetPricesInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      await this.activeList(db, priceListId);
      const ids = [...new Set(input.items.map((i) => i.variantId))];
      const found = await db
        .select({ id: productVariants.id, archivedAt: productVariants.archivedAt })
        .from(productVariants)
        .where(inArray(productVariants.id, ids));
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new AppError('NOT_FOUND', 'Variant not found', HttpStatus.NOT_FOUND, { variantIds: missing });
      if (found.some((f) => f.archivedAt)) throw archived('Variant');

      const now = (await dbNow(db)).getTime();
      const rows = input.items.map((i) => {
        const effectiveFrom = i.effectiveFrom ? new Date(i.effectiveFrom) : new Date(now);
        if (effectiveFrom.getTime() < now - BACKDATE_TOLERANCE_MS) {
          throw new AppError('BACKDATED_PRICE', 'Prices cannot take effect in the past', HttpStatus.UNPROCESSABLE_ENTITY, {
            variantId: i.variantId,
          });
        }
        return {
          tenantId: tenantOf(auth).tenantId,
          priceListId,
          variantId: i.variantId,
          amount: i.amount,
          effectiveFrom,
          createdBy: auth.userId,
        };
      });
      const inserted = await db.insert(productPrices).values(rows).returning();
      await this.audit(db, auth, 'prices.set', 'price_list', priceListId, { count: inserted.length });
      return { data: inserted };
    });
  }

  currentPrices(auth: AuthContext, priceListId: string) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const list = await this.listRow(db, priceListId);
      const { rows } = await db.execute<{
        price_id: string;
        variant_id: string;
        sku: string;
        product_name: string;
        variant_name: string | null;
        amount: string;
        effective_from: Date;
        next_amount: string | null;
        next_effective_from: Date | null;
      }>(sql`
        SELECT cur.id AS price_id, cur.variant_id, v.sku, p.name AS product_name, v.name AS variant_name,
               cur.amount, cur.effective_from, nxt.amount AS next_amount, nxt.effective_from AS next_effective_from
          FROM (SELECT DISTINCT ON (variant_id) * FROM product_prices
                 WHERE price_list_id = ${priceListId} AND effective_from <= ${effectiveNowSql}
                 ORDER BY variant_id, effective_from DESC) cur
          JOIN product_variants v ON v.tenant_id = cur.tenant_id AND v.id = cur.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          LEFT JOIN LATERAL (SELECT amount, effective_from FROM product_prices n
                              WHERE n.price_list_id = cur.price_list_id AND n.variant_id = cur.variant_id
                                AND n.effective_from > ${effectiveNowSql}
                              ORDER BY n.effective_from ASC LIMIT 1) nxt ON true
         WHERE v.archived_at IS NULL
         ORDER BY p.name, v.sku`);
      return {
        priceList: list,
        data: rows.map((r) => ({
          priceId: r.price_id,
          variantId: r.variant_id,
          sku: r.sku,
          productName: r.product_name,
          variantName: r.variant_name,
          amount: r.amount,
          effectiveFrom: r.effective_from,
          scheduled: r.next_amount ? { amount: r.next_amount, effectiveFrom: r.next_effective_from } : null,
        })),
      };
    });
  }

  priceHistory(auth: AuthContext, variantId: string) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      // 404 for unknown (incl. other tenants') variants, like every other id-addressed route.
      const [variant] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, variantId));
      if (!variant) throw notFound('Variant');
      return {
        data: await db
          .select()
          .from(productPrices)
          .where(eq(productPrices.variantId, variantId))
          .orderBy(asc(productPrices.priceListId), asc(productPrices.effectiveFrom)),
      };
    });
  }

  /**
   * POS lookup by barcode, then SKU. Returns the item and the price in force for the
   * branch right now (branch's price list, else tenant default). `price` is null when the
   * item has no price — the POS must refuse to sell it rather than default to zero.
   */
  lookup(auth: AuthContext, code: string, branchId: string) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select({ id: branches.id, archivedAt: branches.archivedAt, legalEntityId: branches.legalEntityId }).from(branches).where(eq(branches.id, branchId));
      if (!branch) throw notFound('Branch');
      // The branch's price for its own people: catalog.read where they work (a branch grant counts).
      this.assertCan(auth, 'catalog.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });

      const [byBarcode] = await db
        .select({ variantId: barcodes.variantId })
        .from(barcodes)
        .where(and(eq(barcodes.code, code), isNull(barcodes.archivedAt)));
      let variantId = byBarcode?.variantId;
      if (!variantId) {
        const [bySku] = await db
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(and(sql`lower(${productVariants.sku}) = lower(${code})`, isNull(productVariants.archivedAt)));
        variantId = bySku?.id;
      }
      // A weighing-scale label (session 16): the item by its 6-character scale code, the weight from the label.
      const label = variantId ? null : parseScaleLabel(code);
      if (label) {
        const [byKey] = await db
          .select({ variantId: barcodes.variantId })
          .from(barcodes)
          .where(and(eq(barcodes.code, label.key), isNull(barcodes.archivedAt)));
        variantId = byKey?.variantId;
      }
      if (!variantId) throw notFound('Item');

      const [item] = await db
        .select({
          variant: productVariants,
          product: products,
          vatTreatment: taxCategories.vatTreatment,
          taxCategoryCode: taxCategories.code,
          uomCode: unitsOfMeasure.code,
          allowsFraction: unitsOfMeasure.allowsFraction,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(taxCategories, eq(taxCategories.id, products.taxCategoryId))
        .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.uomId))
        .where(eq(productVariants.id, variantId));
      if (!item || item.product.archivedAt || item.variant.archivedAt) throw notFound('Item');
      if (label && item.product.soldBy !== 'WEIGHT') {
        throw new AppError('SCALE_LABEL_NOT_BY_WEIGHT', `${item.product.name} is not sold by weight; its scale code cannot carry a weight`, HttpStatus.UNPROCESSABLE_ENTITY);
      }

      const price = await this.effectivePrice(db, branchId, variantId);
      return {
        variantId,
        sku: item.variant.sku,
        name: item.variant.name ? `${item.product.name} — ${item.variant.name}` : item.product.name,
        productId: item.product.id,
        soldBy: item.product.soldBy,
        uom: { code: item.uomCode, allowsFraction: item.allowsFraction },
        tax: { categoryCode: item.taxCategoryCode, vatTreatment: item.vatTreatment },
        trackInventory: item.product.trackInventory,
        /** STANDARD, SERVICE or PACKAGE (ADR-0022): a package needs the customer on the sale. */
        productType: item.product.productType,
        /** A medicine (ADR-0025 §3): class, generic name, strength, form; null for an ordinary item. */
        drug: (await tillDrugs(db, [variantId])).get(variantId) ?? null,
        /** Where expired or held lots may not be sold (ADR-0025 §4): what of it is sellable here now. */
        ...(item.product.tracksExpiry && (await expiredStockRule(db, branchId)) === 'BLOCK' && { sellable: await sellableAt(db, branchId, variantId) }),
        price,
        /** From a scale label: the weighed quantity (kg) to sell, as printed. */
        ...(label && { quantity: label.quantity }),
      };
    });
  }

  /**
   * The till's quick keys (ADR-0021 §3): active items with a key, in key order, priced at the branch
   * now. An item without a price there is listed with `price: null` (the till shows it disabled).
   */
  quickKeys(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select({ id: branches.id, legalEntityId: branches.legalEntityId }).from(branches).where(eq(branches.id, branchId));
      if (!branch) throw notFound('Branch');
      this.assertCan(auth, 'catalog.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const rows = await db
        .select({ variantId: productVariants.id, sku: productVariants.sku, variantName: productVariants.name, productName: products.name, position: productVariants.quickKeyPosition, productType: products.productType })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(sql`${productVariants.quickKeyPosition} IS NOT NULL`, isNull(productVariants.archivedAt), isNull(products.archivedAt)))
        .orderBy(asc(productVariants.quickKeyPosition));
      const prices = await this.effectivePrices(db, branchId, rows.map((r) => r.variantId));
      return {
        data: rows.map((r) => ({
          position: r.position!,
          variantId: r.variantId,
          sku: r.sku,
          name: r.variantName ? `${r.productName} — ${r.variantName}` : r.productName,
          productType: r.productType,
          price: prices.get(r.variantId)?.amount ?? null,
        })),
      };
    });
  }

  /** Price in force at `at` for a variant in a branch. Exported for the checkout engine (Phase 2). */
  async effectivePrice(db: Database, branchId: string, variantId: string, at?: Date): Promise<EffectivePrice | null> {
    return (await this.effectivePrices(db, branchId, [variantId], at)).get(variantId) ?? null;
  }

  /**
   * Prices in force at `at` for many variants of one branch, in one query (the cart, the till's snapshot):
   * the branch's price list (else the tenant default), then per variant the newest price effective by
   * `at`. Variants without a price are absent from the map. With `knownAt` (an offline sale re-priced as
   * of its snapshot), price rows created after that instant are ignored even when back-dated up to
   * BACKDATE_TOLERANCE_MS: the till could not have known them (audit 2026-10-21).
   */
  async effectivePrices(db: Database, branchId: string, variantIds: readonly string[], at?: Date, knownAt?: Date): Promise<Map<string, EffectivePrice>> {
    const ids = [...new Set(variantIds)];
    const out = new Map<string, EffectivePrice>();
    if (!ids.length) return out;
    const atSql = at ? sql`${at.toISOString()}::timestamptz` : effectiveNowSql;
    const { rows } = await db.execute<{
      variant_id: string;
      id: string;
      price_list_id: string;
      amount: string;
      currency: string;
      prices_include_tax: boolean;
      effective_from: Date;
    }>(sql`
      WITH list AS (
        SELECT coalesce(
          (SELECT bpl.price_list_id FROM branch_price_lists bpl
             JOIN price_lists pl ON pl.tenant_id = bpl.tenant_id AND pl.id = bpl.price_list_id AND pl.archived_at IS NULL
            WHERE bpl.branch_id = ${branchId}),
          (SELECT id FROM price_lists WHERE is_default AND archived_at IS NULL)
        ) AS id
      )
      SELECT v.variant_id, pp.id, pp.price_list_id, pp.amount, pl.currency, pl.prices_include_tax, pp.effective_from
        FROM list
        JOIN price_lists pl ON pl.id = list.id
        CROSS JOIN (VALUES ${sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `)}) AS v(variant_id)
        JOIN LATERAL (
          SELECT p.id, p.price_list_id, p.amount, p.effective_from FROM product_prices p
           WHERE p.price_list_id = list.id AND p.variant_id = v.variant_id AND p.effective_from <= ${atSql}
             ${knownAt ? sql`AND p.created_at <= ${knownAt.toISOString()}::timestamptz + ${sql.raw(EFFECTIVE_SKEW)}` : sql``}
           ORDER BY p.effective_from DESC
           LIMIT 1
        ) pp ON true`);
    for (const r of rows) {
      out.set(r.variant_id, {
        priceId: r.id,
        priceListId: r.price_list_id,
        variantId: r.variant_id,
        amount: r.amount,
        currency: r.currency,
        pricesIncludeTax: r.prices_include_tax,
        effectiveFrom: r.effective_from,
      });
    }
    return out;
  }

  private async clearDefault(db: Database) {
    await db.update(priceLists).set({ isDefault: false }).where(eq(priceLists.isDefault, true));
  }

  private async listRow(db: Database, id: string) {
    const [row] = await db.select().from(priceLists).where(eq(priceLists.id, id));
    if (!row) throw notFound('Price list');
    return row;
  }

  private async activeList(db: Database, id: string) {
    const row = await this.listRow(db, id);
    if (row.archivedAt) throw archived('Price list');
    return row;
  }
}
