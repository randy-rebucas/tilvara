import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, productVariants, products, sql, supplierItems, suppliers, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CreatePurchaseOrderInput, CreateSupplierItemInput, UpdateSupplierItemInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { activeSupplier } from './suppliers.service.js';

type ItemRow = typeof supplierItems.$inferSelect;

/**
 * Purchase order lines with the cost filled in from the supplier's catalog where a line gives none
 * (session 20). A line with no cost and no catalog cost is refused, naming the line.
 */
export async function withCatalogCosts(db: Database, supplierId: string, lines: CreatePurchaseOrderInput['lines']) {
  if (lines.every((l) => l.unitCost !== undefined)) return lines.map((l) => ({ ...l, unitCost: l.unitCost! }));
  const items = await db
    .select({ variantId: supplierItems.variantId, unitCost: supplierItems.unitCost })
    .from(supplierItems)
    .where(and(eq(supplierItems.supplierId, supplierId), isNull(supplierItems.archivedAt), inArray(supplierItems.variantId, lines.map((l) => l.variantId))));
  return lines.map((l, i) => {
    const unitCost = l.unitCost ?? items.find((x) => x.variantId === l.variantId)?.unitCost ?? null;
    if (unitCost === null) throw unprocessable('UNIT_COST_REQUIRED', 'Give the cost: this supplier has no cost on file for the item', { path: ['lines', i, 'unitCost'] });
    return { ...l, unitCost: toDec(unitCost).toString() };
  });
}

/**
 * The supplier catalog (session 20): each supplier's SKU, name and cost for the items they supply,
 * and one preferred supplier per item. Maintained with `purchasing.manage`; read like suppliers.
 */
@Injectable()
export class SupplierItemsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    supplier_items_active_unique: ['SUPPLIER_ITEM_EXISTS', 'This supplier already has this item in its catalog'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private assertCanRead(auth: AuthContext) {
    const ok = tenantOf(auth).grants.some((g) => g.permission === 'purchasing.manage' || g.permission === 'inventory.read');
    if (!ok) this.assertCan(auth, 'purchasing.manage');
  }

  list(auth: AuthContext, supplierId: string) {
    return this.read(auth, async (db) => {
      const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId));
      if (!supplier) throw notFound('Supplier');
      this.assertCanRead(auth);
      return { data: await this.rows(db, eq(supplierItems.supplierId, supplierId)) };
    });
  }

  /** Who supplies this item, preferred first (the purchase order form fills cost and SKU from it). */
  forVariant(auth: AuthContext, variantId: string) {
    return this.read(auth, async (db) => {
      const [variant] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, variantId));
      if (!variant) throw notFound('Variant');
      this.assertCanRead(auth);
      return { data: await this.rows(db, eq(supplierItems.variantId, variantId)) };
    });
  }

  create(auth: AuthContext, supplierId: string, input: CreateSupplierItemInput) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'purchasing.manage');
      await activeSupplier(db, supplierId);
      const [variant] = await db.select({ id: productVariants.id, archivedAt: productVariants.archivedAt }).from(productVariants).where(eq(productVariants.id, input.variantId));
      if (!variant) throw notFound('Variant');
      if (variant.archivedAt) throw archived('Item');
      if (input.preferred) await this.clearPreferred(db, input.variantId);
      const [row] = await db.insert(supplierItems).values({ tenantId: tenantOf(auth).tenantId, supplierId, ...input, preferred: input.preferred ?? false }).returning();
      await this.audit(db, auth, 'supplier_item.created', 'supplier', supplierId, { supplierItemId: row!.id, variantId: input.variantId, unitCost: input.unitCost ?? null, preferred: row!.preferred });
      return this.one(db, row!);
    });
  }

  update(auth: AuthContext, id: string, input: UpdateSupplierItemInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertCan(auth, 'purchasing.manage');
      if (current.archivedAt) throw archived('Supplier item');
      if (input.preferred) await this.clearPreferred(db, current.variantId, id);
      const [row] = await db.update(supplierItems).set({ ...input, updatedAt: sql`now()` }).where(eq(supplierItems.id, id)).returning();
      await this.audit(db, auth, 'supplier_item.updated', 'supplier', current.supplierId, { supplierItemId: id, fields: Object.keys(input), ...(input.unitCost !== undefined && { unitCost: input.unitCost }) });
      return this.one(db, row!);
    });
  }

  archive(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertCan(auth, 'purchasing.manage');
      if (current.archivedAt) return this.one(db, current);
      const [row] = await db.update(supplierItems).set({ archivedAt: sql`now()`, preferred: false, updatedAt: sql`now()` }).where(eq(supplierItems.id, id)).returning();
      await this.audit(db, auth, 'supplier_item.archived', 'supplier', current.supplierId, { supplierItemId: id });
      return this.one(db, row!);
    });
  }

  private async load(db: Database, id: string) {
    const [row] = await db.select().from(supplierItems).where(eq(supplierItems.id, id));
    if (!row) throw new AppError('NOT_FOUND', 'Supplier item not found', HttpStatus.NOT_FOUND);
    return row;
  }

  /** One preferred supplier per item: setting it here clears it elsewhere first. */
  private async clearPreferred(db: Database, variantId: string, except?: string) {
    await db
      .update(supplierItems)
      .set({ preferred: false, updatedAt: sql`now()` })
      .where(and(eq(supplierItems.variantId, variantId), eq(supplierItems.preferred, true), isNull(supplierItems.archivedAt), except ? sql`${supplierItems.id} <> ${except}` : undefined));
  }

  private async rows(db: Database, where: ReturnType<typeof eq>) {
    const rows = await db
      .select({ item: supplierItems, sku: productVariants.sku, name: products.name, variantName: productVariants.name, supplierCode: suppliers.code, supplierName: suppliers.name })
      .from(supplierItems)
      .innerJoin(productVariants, eq(productVariants.id, supplierItems.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
      .where(and(where, isNull(supplierItems.archivedAt)))
      .orderBy(sql`${supplierItems.preferred} DESC`, asc(productVariants.sku));
    return rows.map((r) => this.shape(r.item, { sku: r.sku, name: r.variantName ? `${r.name} — ${r.variantName}` : r.name, supplierCode: r.supplierCode, supplierName: r.supplierName }));
  }

  private async one(db: Database, item: ItemRow) {
    const [r] = (await this.rows(db, eq(supplierItems.id, item.id)));
    return r ?? this.shape(item, {});
  }

  private shape(i: ItemRow, extra: Record<string, string>) {
    return {
      id: i.id, supplierId: i.supplierId, variantId: i.variantId, supplierSku: i.supplierSku, supplierItemName: i.supplierItemName,
      unitCost: i.unitCost === null ? null : toDec(i.unitCost).toFixed(4), preferred: i.preferred, archivedAt: i.archivedAt, updatedAt: i.updatedAt, ...extra,
    };
  }
}
