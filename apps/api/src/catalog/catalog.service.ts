import { randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ean13CheckDigit } from '@1pos/sync-protocol';
import {
  and,
  asc,
  barcodes,
  branches,
  categories,
  rooms,
  roomTypes,
  laundryMachines,
  laundrySettings,
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
  DrugDetailsInput,
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
import { assertPackages, assertPharmacy, businessType } from '../billing/entitlements.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { emitEvent } from '../outbox/outbox.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof productVariants.$inferSelect;

export interface ProductView extends ProductRow {
  variants: (VariantRow & { barcodes: string[]; barcodeIds: { id: string; code: string }[] })[];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The trial's sample sets (ADR-0016 slice 6), VAT-inclusive prices on the default list: a small café
 * counter for a restaurant or a business that does both, a neighbourhood shop for retail (session 22).
 * Both sets have the same length, so the trial card reads the same.
 */
const CAFE_ITEMS: readonly { name: string; price: string }[] = [
  { name: 'Iced coffee 16oz', price: '120.00' },
  { name: 'Hot chocolate', price: '95.00' },
  { name: 'Ensaymada', price: '45.00' },
  { name: 'Pandesal (6 pcs)', price: '30.00' },
  { name: 'Ham and cheese sandwich', price: '135.00' },
  { name: 'Bottled water 500ml', price: '25.00' },
  { name: 'Banana cake slice', price: '60.00' },
  { name: 'Tote bag', price: '250.00' },
];
const SHOP_ITEMS: readonly { name: string; price: string }[] = [
  { name: 'Rice 5 kg', price: '275.00' },
  { name: 'Instant noodles', price: '16.00' },
  { name: 'Canned sardines 155g', price: '28.00' },
  { name: 'Laundry soap bar', price: '35.00' },
  { name: 'Cooking oil 1 L', price: '115.00' },
  { name: 'Bottled water 500ml', price: '25.00' },
  { name: 'Ballpen (blue)', price: '12.00' },
  { name: 'AA batteries (2 pcs)', price: '70.00' },
];
/** A sari-sari store's shelf (ADR-0020): sachets and pieces next to the packs they come from. */
const GROCERY_ITEMS: readonly { name: string; price: string }[] = [
  { name: '3-in-1 coffee sachet', price: '9.00' },
  { name: '3-in-1 coffee (tie of 10)', price: '85.00' },
  { name: 'Shampoo sachet', price: '8.00' },
  { name: 'Instant noodles', price: '16.00' },
  { name: 'Canned sardines 155g', price: '28.00' },
  { name: 'Rice per kilo', price: '55.00' },
  { name: 'Cooking oil (small bottle)', price: '25.00' },
  { name: 'Softdrink 290ml', price: '20.00' },
];
/** A salon's list (ADR-0022): services with their durations, and two retail items. */
const SALON_ITEMS: readonly { name: string; price: string; minutes?: number }[] = [
  { name: 'Haircut', price: '250.00', minutes: 30 },
  { name: 'Hair colour', price: '1200.00', minutes: 90 },
  { name: 'Manicure', price: '200.00', minutes: 45 },
  { name: 'Foot spa', price: '350.00', minutes: 60 },
  { name: 'Full body massage', price: '600.00', minutes: 60 },
  { name: 'Shampoo 250ml', price: '180.00' },
  { name: 'Hair wax', price: '220.00' },
];
/** A hotel's or resort's list (ADR-0023 §1): two room nights (their room types come with them), a minibar item, laundry and breakfast. */
type SampleItem = {
  name: string;
  price: string;
  minutes?: number;
  service?: true;
  roomType?: { code: string; base: number; max: number; rooms: string[] };
  /** A laundry's service (ADR-0024 §2): by the kilo (sold by weight), per load or piece, an add-on, a machine cycle. */
  laundry?: { unit?: 'KG' | 'LOAD' | 'PIECE'; min?: string; kgPerLoad?: string; addon?: true; machine?: { kind: 'WASHER' | 'DRYER'; minutes: number }; role?: 'express' | 'delivery' };
  /** A pharmacy's medicine (ADR-0025 §1): its class, generic name, strength and form. */
  drug?: DrugDetailsInput;
};
const LODGING_ITEMS: readonly SampleItem[] = [
  { name: 'Standard room night', price: '2500.00', service: true, roomType: { code: 'STD', base: 2, max: 3, rooms: ['101', '102', '103'] } },
  { name: 'Family room night', price: '4200.00', service: true, roomType: { code: 'FAM', base: 4, max: 6, rooms: ['201', '202'] } },
  { name: 'Minibar soft drink', price: '80.00' },
  { name: 'Laundry (per kilo)', price: '150.00', service: true },
  { name: 'Breakfast buffet', price: '450.00', service: true },
];
/**
 * A laundry's list (ADR-0024 §1): wash-dry-fold by the kilo, washing and drying per load, ironing per
 * piece, the express and delivery charges, two add-on sachets and the self-service cycles; two washers
 * and two dryers come with them. The sachets are untracked like every sample (trying them never touches stock).
 */
const LAUNDRY_ITEMS: readonly SampleItem[] = [
  { name: 'Wash-dry-fold (per kilo)', price: '35.00', service: true, laundry: { unit: 'KG', min: '3' } },
  { name: 'Wash only (per load)', price: '70.00', service: true, laundry: { unit: 'LOAD', kgPerLoad: '8' } },
  { name: 'Dry only (per load)', price: '70.00', service: true, laundry: { unit: 'LOAD', kgPerLoad: '8' } },
  { name: 'Ironing (per piece)', price: '20.00', service: true, laundry: { unit: 'PIECE' } },
  { name: 'Express service', price: '50.00', service: true, laundry: { role: 'express' } },
  { name: 'Pickup and delivery', price: '60.00', service: true, laundry: { role: 'delivery' } },
  { name: 'Detergent sachet', price: '15.00', laundry: { addon: true } },
  { name: 'Fabric conditioner sachet', price: '12.00', laundry: { addon: true } },
  { name: 'Self-service wash (30 min)', price: '60.00', service: true, laundry: { machine: { kind: 'WASHER', minutes: 30 } } },
  { name: 'Self-service dry (10 min)', price: '20.00', service: true, laundry: { machine: { kind: 'DRYER', minutes: 10 } } },
];
/**
 * A drugstore's list (ADR-0025 §1): over-the-counter and prescription medicines named by their generic,
 * one antibiotic, a syrup and a supply. Untracked like every sample set, so no box and strip links (a pack
 * link needs counted stock); selling the prescription ones shows the prescription panel.
 */
const PHARMACY_ITEMS: readonly SampleItem[] = [
  { name: 'Paracetamol 500 mg tablet', price: '5.50', drug: { drugClass: 'OTC', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET' } },
  { name: 'Cetirizine 10 mg tablet', price: '8.00', drug: { drugClass: 'OTC', genericName: 'Cetirizine', strength: '10 mg', dosageForm: 'TABLET' } },
  { name: 'Ascorbic acid 100 mg/5 mL syrup 120 mL', price: '95.00', drug: { drugClass: 'OTC', genericName: 'Ascorbic acid', strength: '100 mg/5 mL', dosageForm: 'SYRUP' } },
  { name: 'Amoxicillin 500 mg capsule', price: '9.00', drug: { drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: '500 mg', dosageForm: 'CAPSULE' } },
  { name: 'Losartan 50 mg tablet', price: '12.00', drug: { drugClass: 'RX', genericName: 'Losartan', strength: '50 mg', dosageForm: 'TABLET' } },
  { name: 'Metformin 500 mg tablet', price: '4.50', drug: { drugClass: 'RX', genericName: 'Metformin', strength: '500 mg', dosageForm: 'TABLET' } },
  { name: 'Face mask (box of 50)', price: '150.00' },
];
const sampleItems = (type: Awaited<ReturnType<typeof businessType>>): readonly SampleItem[] =>
  type === 'GROCERY' ? GROCERY_ITEMS : type === 'RETAIL' ? SHOP_ITEMS : type === 'SALON' ? SALON_ITEMS : type === 'LODGING' ? LODGING_ITEMS : type === 'LAUNDRY' ? LAUNDRY_ITEMS
    : type === 'PHARMACY' ? PHARMACY_ITEMS : CAFE_ITEMS;

const SAMPLE_REFUSALS = {
  SAMPLE_DATA_LOADED: 'The sample items are already on your list',
  NOT_TRIAL: 'Sample items are for businesses on a trial',
  HAS_SALES: 'Sample items can only be added before the first sale',
} as const;

/** EAN-13 in the in-store range 200…, so a sample code never belongs to a real product. */
export function inStoreEan13(n: number): string {
  const body = `200000${String(n).padStart(6, '0')}`;
  const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + ((10 - (sum % 10)) % 10);
}

/** A store barcode (ADR-0021 §4): EAN-13 `29` + the 10-digit number + check digit. */
export function storeEan13(n: number): string {
  const body = `29${String(n).padStart(10, '0')}`;
  return body + ean13CheckDigit(body);
}

/** A product's medicine columns from its details (ADR-0025 §2); null clears them. */
function drugColumns(d: DrugDetailsInput | null) {
  return {
    drugClass: d?.drugClass ?? null,
    genericName: d?.genericName ?? null,
    strength: d?.strength ?? null,
    dosageForm: d?.dosageForm ?? null,
    fdaRegistrationNo: d?.fdaRegistrationNo ?? null,
  };
}

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
    this.assertHolds(auth, 'catalog.read');
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
    this.assertHolds(auth, 'catalog.read');
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
    this.assertHolds(auth, 'catalog.read');
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
      // A restaurant sells dishes, not goods off a scale (the screens hide it; session 25 closes the API).
      if (input.soldBy === 'WEIGHT' && (await businessType(db)) === 'RESTAURANT') {
        throw new AppError('BUSINESS_TYPE_EXCLUDES_FEATURE', 'A restaurant does not sell by weight. Change the business type to Both (a shop and a restaurant) to sell by weight.', HttpStatus.UNPROCESSABLE_ENTITY, { feature: 'sold_by_weight', businessType: 'RESTAURANT' });
      }
      if (input.categoryId) await this.activeCategory(db, input.categoryId);
      // Prepaid packages are a salon's (ADR-0022 §6).
      if (input.productType === 'PACKAGE') await assertPackages(db);
      // Prescription medicines are a pharmacy's (ADR-0025 §1); an OTC medicine may be sold anywhere.
      if (input.drug && input.drug.drugClass !== 'OTC') await assertPharmacy(db);

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
          trackInventory: input.trackInventory ?? input.productType === 'STANDARD',
          tracksExpiry: input.tracksExpiry,
          ...drugColumns(input.drug ?? null),
        })
        .returning();
      for (const v of input.variants) {
        await this.assertTypeFields(db, product!.id, v);
        await this.insertVariant(db, auth, product!.id, v);
      }
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
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, (db) => this.productView(db, id));
  }

  listProducts(auth: AuthContext, q: ProductListQuery) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const conds = [];
      if (!q.includeArchived) conds.push(isNull(products.archivedAt));
      if (q.categoryId) conds.push(eq(products.categoryId, q.categoryId));
      if (q.productType) conds.push(eq(products.productType, q.productType));
      if (q.cursor) conds.push(sql`${products.id} > ${q.cursor}`);
      if (q.q) {
        const like = `%${escapeLike(q.q)}%`;
        conds.push(sql`(
          ${products.name} ILIKE ${like}
          OR ${products.genericName} ILIKE ${like}
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
    this.assertHolds(auth, 'catalog.read');
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
      if (input.trackInventory && current.productType !== 'STANDARD') {
        throw new AppError('INVALID_STATE', 'Services and packages cannot track inventory', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      // Expiry dates are kept on counted stock only (ADR-0020 §3).
      if ((input.tracksExpiry ?? current.tracksExpiry) && !(input.trackInventory ?? current.trackInventory)) {
        throw new AppError('EXPIRY_NEEDS_STOCK', 'Expiry dates need stock that is counted', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const { drug, ...fields } = input;
      if (drug && drug.drugClass !== 'OTC') await assertPharmacy(db);
      // Pack links are checked under the lock that creating one takes (packs.service createConversion).
      if (drug !== undefined) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':pack-links'))`);
      await db.update(products).set({ ...fields, ...(drug !== undefined && drugColumns(drug)) }).where(eq(products.id, id));
      if (drug !== undefined) {
        // A box and its strips stay the same medicine (ADR-0025 §6): a change here may not leave a linked pack or piece apart.
        const { rows: [apart] } = await db.execute<{ id: string }>(sql`
          SELECT pc.id FROM pack_conversions pc
            JOIN product_variants pv ON pv.id = pc.pack_variant_id JOIN products pp ON pp.id = pv.product_id
            JOIN product_variants sv ON sv.id = pc.piece_variant_id JOIN products sp ON sp.id = sv.product_id
           WHERE pc.archived_at IS NULL AND (pp.id = ${id} OR sp.id = ${id})
             AND (pp.drug_class IS DISTINCT FROM sp.drug_class OR (pp.drug_class IS NOT NULL AND pp.generic_key IS DISTINCT FROM sp.generic_key))
           LIMIT 1`);
        if (apart) {
          throw new AppError('PACK_DRUG_MISMATCH', 'This item is a pack or piece of another with other medicine details; remove the pack link, change both items, then link them again', HttpStatus.UNPROCESSABLE_ENTITY, { packLinkId: apart.id });
        }
      }
      await this.audit(db, auth, 'product.updated', 'product', id, {
        fields: Object.keys(input),
        // A change of class changes what a sale needs from then on (ADR-0025 §2).
        ...(drug !== undefined && (drug?.drugClass ?? null) !== current.drugClass && { drugClass: { from: current.drugClass, to: drug?.drugClass ?? null } }),
      });
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
      await this.assertTypeFields(db, productId, input);
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
      await this.assertTypeFields(db, v.productId, input, v);
      if (input.quickKeyPosition) {
        // One item per quick key (ADR-0021 §3).
        const [taken] = await db
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(and(eq(productVariants.quickKeyPosition, input.quickKeyPosition), isNull(productVariants.archivedAt), sql`${productVariants.id} <> ${id}`));
        if (taken) throw new AppError('QUICK_KEY_TAKEN', 'Another item already has this quick key', HttpStatus.CONFLICT, { variantId: taken.id });
      }
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

  /**
   * A store barcode for a variant (ADR-0021 §4): an in-store EAN-13, `29` + 10 random digits + check
   * digit, for items that came without one. Exact barcodes are looked up before scale labels, so it
   * never reads as a weight.
   */
  generateBarcode(auth: AuthContext, variantId: string) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const v = await this.variantRow(db, variantId);
      if (v.archivedAt) throw archived('Variant');
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = storeEan13(randomInt(0, 10_000_000_000));
        const [clash] = await db.select({ id: barcodes.id }).from(barcodes).where(eq(barcodes.code, code));
        if (clash) continue;
        const [row] = await db.insert(barcodes).values({ tenantId: tenantOf(auth).tenantId, variantId, code }).returning();
        await this.audit(db, auth, 'barcode.added', 'barcode', row!.id, { variantId, code, generated: true });
        return row!;
      }
      throw new AppError('BARCODE_TAKEN', 'Could not find a free store barcode; try again', HttpStatus.CONFLICT);
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

  // ---------------------------------------------------------------- sample items (ADR-0016 slice 6)
  /** Whether this business can load the trial's sample items, and how many are on its list now. */
  sampleData(auth: AuthContext) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const s = await this.sampleState(db);
      return { loaded: s.loaded, canLoad: s.refusal === null, reason: s.refusal, items: sampleItems(await businessType(db)).length };
    });
  }

  /**
   * Load a labelled set of sample items into a trial business that has not sold anything yet: a
   * "Sample items" category and products named "… (sample)", priced on the default list and not
   * stock-tracked (trying them never touches stock). Barcodes are in the in-store range (200…), so
   * they never clash with a real product's code.
   */
  loadSampleData(auth: AuthContext) {
    this.assertCan(auth, 'catalog.manage');
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      // One at a time per business, so two clicks cannot load the set twice.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':sample-data'))`);
      const s = await this.sampleState(db);
      if (s.refusal) throw new AppError(s.refusal, SAMPLE_REFUSALS[s.refusal], HttpStatus.CONFLICT);
      const [vat] = await db.select({ id: taxCategories.id }).from(taxCategories).where(and(eq(taxCategories.code, 'VAT'), isNull(taxCategories.archivedAt)));
      const [pc] = await db.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(and(eq(unitsOfMeasure.code, 'PC'), isNull(unitsOfMeasure.archivedAt)));
      const [kg] = await db.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(and(eq(unitsOfMeasure.code, 'KG'), isNull(unitsOfMeasure.archivedAt)));
      if (!vat || !pc) throw new AppError('SAMPLE_DATA_UNAVAILABLE', 'The default VAT category or the piece unit is missing', HttpStatus.UNPROCESSABLE_ENTITY);
      const [category] = await db.insert(categories).values({ tenantId, name: 'Sample items', isSample: true, sortOrder: 999 }).returning();
      const ids: string[] = [];
      const [firstBranch] = await db.select({ id: branches.id }).from(branches).where(isNull(branches.archivedAt)).orderBy(asc(branches.createdAt)).limit(1);
      for (const [i, item] of sampleItems(await businessType(db)).entries()) {
        const [product] = await db
          .insert(products)
          .values({
            tenantId, name: `${item.name} (sample)`, categoryId: category!.id, taxCategoryId: vat.id, uomId: item.laundry?.unit === 'KG' && kg ? kg.id : pc.id, trackInventory: false, isSample: true,
            // A salon's samples are bookable services (ADR-0022 §3).
            ...((item.minutes || item.service) && { productType: 'SERVICE' as const }),
            ...(item.laundry?.unit === 'KG' && { soldBy: 'WEIGHT' as const }),
            ...(item.drug && drugColumns(item.drug)),
          })
          .returning({ id: products.id });
        const variantId = await this.insertVariant(db, auth, product!.id, {
          sku: `SAMPLE-${String(i + 1).padStart(2, '0')}`,
          price: item.price,
          barcodes: [inStoreEan13(i + 1)],
          attributes: {},
          ...(item.minutes && { serviceMinutes: item.minutes }),
          ...(item.laundry && {
            laundryUnit: item.laundry.unit ?? null, laundryMinQuantity: item.laundry.min ?? null, laundryKgPerLoad: item.laundry.kgPerLoad ?? null,
            laundryAddon: item.laundry.addon ?? false, machineKind: item.laundry.machine?.kind ?? null, machineMinutes: item.laundry.machine?.minutes ?? null,
          }),
        } as VariantInput);
        // The express and delivery charges become the first branch's (ADR-0024 §3, §8).
        if (item.laundry?.role && firstBranch) {
          const set = item.laundry.role === 'express' ? { expressVariantId: variantId } : { deliveryVariantId: variantId };
          await db.insert(laundrySettings).values({ tenantId, branchId: firstBranch.id, ...set, updatedBy: auth.userId }).onConflictDoUpdate({ target: [laundrySettings.tenantId, laundrySettings.branchId], set });
        }
        ids.push(product!.id);
        // A room night brings its room type, and a few rooms at the first branch (ADR-0023 §1).
        if (item.roomType) {
          const [type] = await db.insert(roomTypes).values({
            tenantId, code: item.roomType.code, name: item.name.replace(/ room night$/, ''), baseOccupancy: item.roomType.base, maxOccupancy: item.roomType.max, nightVariantId: variantId, isSample: true,
          }).onConflictDoNothing().returning({ id: roomTypes.id });
          if (type && firstBranch) {
            await db.insert(rooms).values(item.roomType.rooms.map((number) => ({ tenantId, branchId: firstBranch.id, roomTypeId: type.id, number, isSample: true }))).onConflictDoNothing();
          }
        }
      }
      // A laundry's washers and dryers come with its samples (ADR-0024 §1).
      if ((await businessType(db)) === 'LAUNDRY' && firstBranch) {
        await db.insert(laundryMachines).values([
          { tenantId, branchId: firstBranch.id, kind: 'WASHER', label: 'Washer 1', capacityKg: '8', cycleMinutes: 30, isSample: true },
          { tenantId, branchId: firstBranch.id, kind: 'WASHER', label: 'Washer 2', capacityKg: '8', cycleMinutes: 30, isSample: true },
          { tenantId, branchId: firstBranch.id, kind: 'DRYER', label: 'Dryer 1', capacityKg: '8', cycleMinutes: 10, isSample: true },
          { tenantId, branchId: firstBranch.id, kind: 'DRYER', label: 'Dryer 2', capacityKg: '8', cycleMinutes: 10, isSample: true },
        ]).onConflictDoNothing();
      }
      await this.audit(db, auth, 'sample_data.loaded', 'category', category!.id, { products: ids.length });
      return { loaded: ids.length, categoryId: category!.id, productIds: ids };
    });
  }

  /** Archive every sample item (codes freed). Anything already rung up keeps its history. */
  removeSampleData(auth: AuthContext) {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      const live = await db.select({ id: products.id }).from(products).where(and(eq(products.isSample, true), isNull(products.archivedAt)));
      const now = new Date();
      const ids = live.map((p) => p.id);
      if (ids.length) {
        await db.update(products).set({ archivedAt: now }).where(inArray(products.id, ids));
        const variants = await db
          .update(productVariants)
          .set({ archivedAt: now })
          .where(and(inArray(productVariants.productId, ids), isNull(productVariants.archivedAt)))
          .returning({ id: productVariants.id });
        if (variants.length) {
          await db.update(barcodes).set({ archivedAt: now }).where(and(inArray(barcodes.variantId, variants.map((v) => v.id)), isNull(barcodes.archivedAt)));
        }
      }
      // Sample rooms and room types go with them (stays that used them keep their history).
      await db.update(rooms).set({ archivedAt: now }).where(and(eq(rooms.isSample, true), isNull(rooms.archivedAt)));
      await db.update(roomTypes).set({ archivedAt: now }).where(and(eq(roomTypes.isSample, true), isNull(roomTypes.archivedAt)));
      await db.update(laundryMachines).set({ archivedAt: now }).where(and(eq(laundryMachines.isSample, true), isNull(laundryMachines.archivedAt)));
      const cats = await db
        .update(categories)
        .set({ archivedAt: now })
        .where(and(eq(categories.isSample, true), isNull(categories.archivedAt)))
        .returning({ id: categories.id });
      if (ids.length || cats.length) await this.audit(db, auth, 'sample_data.removed', 'category', cats[0]?.id ?? ids[0]!, { products: ids.length });
      return { removed: ids.length };
    });
  }

  private async sampleState(db: Database): Promise<{ loaded: number; refusal: keyof typeof SAMPLE_REFUSALS | null }> {
    const { rows: [r] } = await db.execute<{ loaded: number; trial: boolean; sold: boolean }>(sql`
      SELECT (SELECT count(*)::int FROM products WHERE is_sample AND archived_at IS NULL) AS loaded,
             EXISTS (SELECT 1 FROM subscriptions WHERE status = 'TRIALING') AS trial,
             EXISTS (SELECT 1 FROM sales) AS sold`);
    const refusal = r!.loaded > 0 ? 'SAMPLE_DATA_LOADED' : !r!.trial ? 'NOT_TRIAL' : r!.sold ? 'HAS_SALES' : null;
    return { loaded: r!.loaded, refusal };
  }

  // ---------------------------------------------------------------- helpers
  /**
   * A duration belongs to a service, a validity to a package (ADR-0022 §3, §6); a laundry unit to an item
   * sold by the kilo when it is KG, a machine cycle to a service, with both kind and minutes (ADR-0024 §2, §7).
   */
  private async assertTypeFields(
    db: Database,
    productId: string,
    v: Partial<Pick<VariantInput, 'serviceMinutes' | 'packageValidDays' | 'laundryUnit' | 'laundryMinQuantity' | 'laundryKgPerLoad' | 'machineKind' | 'machineMinutes'>>,
    current?: { laundryUnit: string | null; machineKind: string | null; machineMinutes: number | null },
  ) {
    const laundry = v.laundryUnit != null || v.laundryMinQuantity != null || v.laundryKgPerLoad != null || v.machineKind != null || v.machineMinutes != null;
    if (v.serviceMinutes == null && v.packageValidDays == null && !laundry) return;
    const { productType, soldBy } = await this.productRow(db, productId);
    if (v.serviceMinutes != null && productType !== 'SERVICE') throw new AppError('INVALID_STATE', 'Only a service has a duration', HttpStatus.UNPROCESSABLE_ENTITY);
    if (v.packageValidDays != null && productType !== 'PACKAGE') throw new AppError('INVALID_STATE', 'Only a package has a validity', HttpStatus.UNPROCESSABLE_ENTITY);
    const unit = v.laundryUnit !== undefined ? v.laundryUnit : (current?.laundryUnit ?? null);
    if (unit === 'KG' && soldBy !== 'WEIGHT') throw new AppError('INVALID_STATE', 'A per-kilo laundry service is sold by weight', HttpStatus.UNPROCESSABLE_ENTITY);
    if (unit !== null && productType === 'PACKAGE') throw new AppError('INVALID_STATE', 'A package is not a laundry service', HttpStatus.UNPROCESSABLE_ENTITY);
    if ((v.laundryMinQuantity != null || v.laundryKgPerLoad != null) && unit === null) throw new AppError('INVALID_STATE', 'Give the laundry unit first', HttpStatus.UNPROCESSABLE_ENTITY);
    if (v.laundryKgPerLoad != null && unit !== 'LOAD') throw new AppError('INVALID_STATE', 'Kilos per load are for a per-load service', HttpStatus.UNPROCESSABLE_ENTITY);
    const kind = v.machineKind !== undefined ? v.machineKind : (current?.machineKind ?? null);
    const minutes = v.machineMinutes !== undefined ? v.machineMinutes : (current?.machineMinutes ?? null);
    if ((kind === null) !== (minutes === null)) throw new AppError('INVALID_STATE', 'A machine cycle needs both the machine kind and its minutes', HttpStatus.UNPROCESSABLE_ENTITY);
    if (kind !== null && productType !== 'SERVICE') throw new AppError('INVALID_STATE', 'Only a service runs on a machine', HttpStatus.UNPROCESSABLE_ENTITY);
  }

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
        serviceMinutes: v.serviceMinutes ?? null,
        packageValidDays: v.packageValidDays ?? null,
        laundryUnit: v.laundryUnit ?? null,
        laundryMinQuantity: v.laundryMinQuantity ?? null,
        laundryKgPerLoad: v.laundryKgPerLoad ?? null,
        laundryAddon: v.laundryAddon ?? false,
        machineKind: v.machineKind ?? null,
        machineMinutes: v.machineMinutes ?? null,
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
