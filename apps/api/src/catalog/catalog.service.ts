import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  barcodes,
  categories,
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
} from '@1pos/database';
import type {
  CreateCategoryInput,
  CreateProductInput,
  CreateTaxCategoryInput,
  CreateUomInput,
  ProductListQuery,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { emitEvent } from '../outbox/outbox.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof productVariants.$inferSelect;

export interface ProductView extends ProductRow {
  variants: (VariantRow & { barcodes: string[]; barcodeIds: { id: string; code: string }[] })[];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class CatalogService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    units_of_measure_tenant_code_unique: ['CODE_TAKEN', 'A unit with this code already exists'],
    tax_categories_tenant_code_unique: ['CODE_TAKEN', 'A tax category with this code already exists'],
    product_variants_tenant_sku_unique: ['SKU_TAKEN', 'Another active variant already uses this SKU'],
    barcodes_tenant_code_active_unique: ['BARCODE_TAKEN', 'Another active item already uses this barcode'],
    product_prices_version_unique: ['PRICE_VERSION_EXISTS', 'A price already starts at that exact time'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- units & tax categories
  listUoms(auth: AuthContext) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, (db) => db.select().from(unitsOfMeasure).orderBy(asc(unitsOfMeasure.code)));
  }

  createUom(auth: AuthContext, input: CreateUomInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const [row] = await db.insert(unitsOfMeasure).values({ ...input, tenantId: tenantOf(auth).tenantId }).returning();
      await this.audit(db, auth, 'uom.created', 'uom', row!.id, { code: row!.code });
      return row!;
    });
  }

  listTaxCategories(auth: AuthContext) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, (db) => db.select().from(taxCategories).orderBy(asc(taxCategories.code)));
  }

  createTaxCategory(auth: AuthContext, input: CreateTaxCategoryInput) {
    this.assertCan(auth, 'tax.manage');
    return this.mutate(auth, async (db) => {
      const [row] = await db.insert(taxCategories).values({ ...input, tenantId: tenantOf(auth).tenantId }).returning();
      await this.audit(db, auth, 'tax_category.created', 'tax_category', row!.id, { code: row!.code, vatTreatment: row!.vatTreatment });
      return row!;
    });
  }

  // ---------------------------------------------------------------- categories
  listCategories(auth: AuthContext) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, (db) =>
      db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name)),
    );
  }

  createCategory(auth: AuthContext, input: CreateCategoryInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      if (input.parentId) await this.activeCategory(db, input.parentId);
      const [row] = await db
        .insert(categories)
        .values({ tenantId: tenantOf(auth).tenantId, name: input.name, parentId: input.parentId ?? null, sortOrder: input.sortOrder })
        .returning();
      await this.audit(db, auth, 'category.created', 'category', row!.id);
      return row!;
    });
  }

  updateCategory(auth: AuthContext, id: string, input: UpdateCategoryInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      await this.activeCategory(db, id);
      if (input.parentId) await this.activeCategory(db, input.parentId);
      const [row] = await db.update(categories).set(input).where(eq(categories.id, id)).returning();
      await this.audit(db, auth, 'category.updated', 'category', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  archiveCategory(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      await this.activeCategory(db, id);
      const [child] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.parentId, id), isNull(categories.archivedAt)))
        .limit(1);
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.categoryId, id), isNull(products.archivedAt)))
        .limit(1);
      if (child || product) {
        throw new AppError('HAS_ACTIVE_CHILDREN', 'Move or archive its sub-categories and products first', HttpStatus.CONFLICT);
      }
      const [row] = await db.update(categories).set({ archivedAt: new Date() }).where(eq(categories.id, id)).returning();
      await this.audit(db, auth, 'category.archived', 'category', id);
      return row!;
    });
  }

  // ---------------------------------------------------------------- products
  createProduct(auth: AuthContext, input: CreateProductInput) {
    this.assertCan(auth, 'catalog.manage');
    if (input.variants.some((v) => v.price !== undefined)) this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      await this.activeTaxCategory(db, input.taxCategoryId);
      const uom = await this.activeUom(db, input.uomId);
      if (input.soldBy === 'WEIGHT' && !uom.allowsFraction) {
        throw new AppError('UOM_NOT_FRACTIONAL', 'Weighted products need a unit that allows fractions (e.g. KG)', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (input.categoryId) await this.activeCategory(db, input.categoryId);

      const [product] = await db
        .insert(products)
        .values({
          tenantId,
          name: input.name,
          description: input.description ?? null,
          categoryId: input.categoryId ?? null,
          taxCategoryId: input.taxCategoryId,
          uomId: input.uomId,
          productType: input.productType,
          soldBy: input.soldBy,
          trackInventory: input.trackInventory ?? input.productType !== 'SERVICE',
        })
        .returning();
      for (const v of input.variants) await this.insertVariant(db, auth, product!.id, v);
      await this.audit(db, auth, 'product.created', 'product', product!.id, { variants: input.variants.length });
      await emitEvent(db, {
        tenantId: tenantOf(auth).tenantId,
        topic: 'catalog.product_created',
        payload: { productId: product!.id },
        correlationId: auth.correlationId,
      });
      return this.productView(db, product!.id);
    });
  }

  getProduct(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, (db) => this.productView(db, id));
  }

  listProducts(auth: AuthContext, q: ProductListQuery) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const conds = [];
      if (!q.includeArchived) conds.push(isNull(products.archivedAt));
      if (q.categoryId) conds.push(eq(products.categoryId, q.categoryId));
      if (q.cursor) conds.push(sql`${products.id} > ${q.cursor}`);
      if (q.q) {
        const like = `%${escapeLike(q.q)}%`;
        conds.push(sql`(
          ${products.name} ILIKE ${like}
          OR ${products.id} IN (SELECT product_id FROM product_variants WHERE sku ILIKE ${like} AND archived_at IS NULL)
          OR ${products.id} IN (SELECT v.product_id FROM barcodes b JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
                               WHERE b.code = ${q.q} AND b.archived_at IS NULL)
        )`);
      }
      const rows = await db
        .select()
        .from(products)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(products.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const views = await this.attachVariants(db, page);
      return { data: views, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
    });
  }

  /** sku and display name per variant id ("Product — Variant"), archived included, for document lines. */
  lookupVariants(auth: AuthContext, ids: string[]) {
    this.assertCan(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const rows = await db
        .select({
          id: productVariants.id,
          productId: products.id,
          sku: productVariants.sku,
          variantName: productVariants.name,
          productName: products.name,
          trackInventory: products.trackInventory,
          archivedAt: sql<string | null>`coalesce(${productVariants.archivedAt}, ${products.archivedAt})`,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, ids));
      return {
        data: rows.map(({ variantName, productName, ...r }) => ({ ...r, productName, name: variantName ? `${productName} — ${variantName}` : productName })),
      };
    });
  }

  updateProduct(auth: AuthContext, id: string, input: UpdateProductInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const current = await this.productRow(db, id);
      if (current.archivedAt) throw archived('Product');
      if (input.taxCategoryId) await this.activeTaxCategory(db, input.taxCategoryId);
      if (input.categoryId) await this.activeCategory(db, input.categoryId);
      if (input.trackInventory && current.productType === 'SERVICE') {
        throw new AppError('INVALID_STATE', 'Services cannot track inventory', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      await db.update(products).set(input).where(eq(products.id, id));
      await this.audit(db, auth, 'product.updated', 'product', id, { fields: Object.keys(input) });
      return this.productView(db, id);
    });
  }

  archiveProduct(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const current = await this.productRow(db, id);
      if (!current.archivedAt) {
        const now = new Date();
        await db.update(products).set({ archivedAt: now }).where(eq(products.id, id));
        await db
          .update(productVariants)
          .set({ archivedAt: now })
          .where(and(eq(productVariants.productId, id), isNull(productVariants.archivedAt)));
        // Release barcodes so they can be reused by a replacement product.
        const variantIds = (await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, id))).map(
          (v) => v.id,
        );
        if (variantIds.length) {
          await db
            .update(barcodes)
            .set({ archivedAt: now })
            .where(and(inArray(barcodes.variantId, variantIds), isNull(barcodes.archivedAt)));
        }
        await this.audit(db, auth, 'product.archived', 'product', id);
      }
      return this.productView(db, id);
    });
  }

  // ---------------------------------------------------------------- variants & barcodes
  addVariant(auth: AuthContext, productId: string, input: VariantInput) {
    this.assertCan(auth, 'catalog.manage');
    if (input.price !== undefined) this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const product = await this.productRow(db, productId);
      if (product.archivedAt) throw archived('Product');
      const variantId = await this.insertVariant(db, auth, productId, input);
      await this.audit(db, auth, 'variant.created', 'variant', variantId, { productId, sku: input.sku });
      return this.productView(db, productId);
    });
  }

  updateVariant(auth: AuthContext, id: string, input: UpdateVariantInput) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const v = await this.variantRow(db, id);
      if (v.archivedAt) throw archived('Variant');
      await db.update(productVariants).set(input).where(eq(productVariants.id, id));
      await this.audit(db, auth, 'variant.updated', 'variant', id, { fields: Object.keys(input) });
      return this.productView(db, v.productId);
    });
  }

  archiveVariant(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const v = await this.variantRow(db, id);
      if (!v.archivedAt) {
        const [{ active } = { active: 0 }] = await db
          .select({ active: sql<number>`count(*)::int` })
          .from(productVariants)
          .where(and(eq(productVariants.productId, v.productId), isNull(productVariants.archivedAt)));
        if (active <= 1) {
          throw new AppError('LAST_VARIANT', 'A product needs at least one active variant; archive the product instead', HttpStatus.CONFLICT);
        }
        const now = new Date();
        await db.update(productVariants).set({ archivedAt: now }).where(eq(productVariants.id, id));
        await db.update(barcodes).set({ archivedAt: now }).where(and(eq(barcodes.variantId, id), isNull(barcodes.archivedAt)));
        await this.audit(db, auth, 'variant.archived', 'variant', id);
      }
      return this.productView(db, v.productId);
    });
  }

  addBarcode(auth: AuthContext, variantId: string, code: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const v = await this.variantRow(db, variantId);
      if (v.archivedAt) throw archived('Variant');
      const [row] = await db.insert(barcodes).values({ tenantId: tenantOf(auth).tenantId, variantId, code }).returning();
      await this.audit(db, auth, 'barcode.added', 'barcode', row!.id, { variantId, code });
      return row!;
    });
  }

  archiveBarcode(auth: AuthContext, id: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const [row] = await db.select().from(barcodes).where(eq(barcodes.id, id));
      if (!row) throw notFound('Barcode');
      if (row.archivedAt) return row;
      const [updated] = await db.update(barcodes).set({ archivedAt: new Date() }).where(eq(barcodes.id, id)).returning();
      await this.audit(db, auth, 'barcode.archived', 'barcode', id, { code: row.code });
      return updated!;
    });
  }

  // ---------------------------------------------------------------- helpers
  private async insertVariant(db: Database, auth: AuthContext, productId: string, v: VariantInput): Promise<string> {
    const tenantId = tenantOf(auth).tenantId;
    const [variant] = await db
      .insert(productVariants)
      .values({
        tenantId,
        productId,
        sku: v.sku,
        name: v.name ?? null,
        attributes: v.attributes,
        referenceCost: v.referenceCost ?? null,
      })
      .returning({ id: productVariants.id });
    if (v.barcodes.length) {
      await db.insert(barcodes).values(v.barcodes.map((code) => ({ tenantId, variantId: variant!.id, code })));
    }
    if (v.price !== undefined) {
      const [list] = await db
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.isDefault, true), isNull(priceLists.archivedAt)));
      if (!list) throw new AppError('NO_DEFAULT_PRICE_LIST', 'Create a default price list first', HttpStatus.UNPROCESSABLE_ENTITY);
      await db.insert(productPrices).values({
        tenantId,
        priceListId: list.id,
        variantId: variant!.id,
        amount: v.price,
        // DB clock, the same one prices are resolved against (common/clock.ts).
        effectiveFrom: sql`now()`,
        createdBy: auth.userId,
      });
    }
    return variant!.id;
  }

  private async productView(db: Database, id: string): Promise<ProductView> {
    const row = await this.productRow(db, id);
    return (await this.attachVariants(db, [row]))[0]!;
  }

  private async attachVariants(db: Database, rows: ProductRow[]): Promise<ProductView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const variants = await db
      .select()
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
      .orderBy(asc(productVariants.createdAt));
    const codes = variants.length
      ? await db
          .select({ id: barcodes.id, variantId: barcodes.variantId, code: barcodes.code })
          .from(barcodes)
          .where(and(inArray(barcodes.variantId, variants.map((v) => v.id)), isNull(barcodes.archivedAt)))
      : [];
    return rows.map((p) => ({
      ...p,
      variants: variants
        .filter((v) => v.productId === p.id)
        .map((v) => {
          const mine = codes.filter((c) => c.variantId === v.id);
          // `barcodeIds` sits beside the plain codes so an editor can archive one (POST /barcodes/:id/archive).
          return { ...v, barcodes: mine.map((c) => c.code), barcodeIds: mine.map(({ id, code }) => ({ id, code })) };
        }),
    }));
  }

  private async productRow(db: Database, id: string) {
    const [row] = await db.select().from(products).where(eq(products.id, id));
    if (!row) throw notFound('Product');
    return row;
  }

  private async variantRow(db: Database, id: string) {
    const [row] = await db.select().from(productVariants).where(eq(productVariants.id, id));
    if (!row) throw notFound('Variant');
    return row;
  }

  private async activeCategory(db: Database, id: string) {
    const [row] = await db.select().from(categories).where(eq(categories.id, id));
    if (!row) throw notFound('Category');
    if (row.archivedAt) throw archived('Category');
    return row;
  }

  private async activeTaxCategory(db: Database, id: string) {
    const [row] = await db.select().from(taxCategories).where(eq(taxCategories.id, id));
    if (!row) throw notFound('Tax category');
    if (row.archivedAt) throw archived('Tax category');
    return row;
  }

  private async activeUom(db: Database, id: string) {
    const [row] = await db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, id));
    if (!row) throw notFound('Unit of measure');
    if (row.archivedAt) throw archived('Unit of measure');
    return row;
  }
}
