import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
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
import { toDec } from '@1pos/money';
import type { ProductImportInput, ProductImportRow } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { effectiveNowSql } from '../common/clock.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';

export type ImportAction = 'CREATE' | 'ADD_VARIANT' | 'UPDATE' | 'UNCHANGED' | 'ERROR';

export interface ImportRowResult {
  line: number;
  sku: string;
  action: ImportAction;
  /** What the row changes: product fields (name, category, …) and variant fields (price, barcodes, …). */
  changes: string[];
  errors: { code: string; message: string }[];
  /** Before and after, for the changes a person checks by eye: the name, the category path and the price. */
  values: Partial<Record<'name' | 'category' | 'price', { before: string | null; after: string }>>;
  /** Not refused, but worth a look (e.g. a spreadsheet that dropped leading zeros); `vars` fill the admin's words. */
  warnings: { code: string; message: string; vars: Record<string, string> }[];
}

export interface ImportPlanView {
  rows: ImportRowResult[];
  summary: { products: number; variants: number; updated: number; unchanged: number; errors: number };
  /** Categories the import makes, as paths ("Drinks › Hot drinks"). */
  newCategories: string[];
}

type ProductField = 'name' | 'category' | 'tax' | 'unit' | 'soldBy' | 'productType' | 'trackInventory' | 'tracksExpiry';
type VariantRow = typeof productVariants.$inferSelect;
type ProductRow = typeof products.$inferSelect;
/** A category by id, or one the import makes (by its lower-case path). */
type CategoryRef = { id: string } | { path: string[] };

interface Target {
  key: string;
  existing: ProductRow | null;
  /** Rows of the file for this product, in file order. */
  rows: { row: ProductImportRow; result: ImportRowResult; variant: VariantRow | null }[];
  /** Product fields as the file gives them, with the line that gave each. */
  wanted: Partial<{ name: string; category: CategoryRef; taxId: string; uomId: string; soldBy: 'UNIT' | 'WEIGHT'; productType: 'STANDARD' | 'SERVICE'; trackInventory: boolean; tracksExpiry: boolean }>;
  givenOn: Partial<Record<ProductField, number>>;
}

interface Plan {
  view: ImportPlanView;
  targets: Target[];
  defaultListId: string | null;
  newCategoryPaths: string[][];
  currentPrice: Map<string, string>;
  currentCodes: Map<string, Set<string>>;
}

const SEP = /\s*[›>]\s*/;
/** The category tree's limits (trigger app_category_tree_guard, 0007; the category form's name). */
const CATEGORY_MAX_DEPTH = 5;
const CATEGORY_NAME_MAX = 200;
const lower = (s: string) => s.trim().toLocaleLowerCase('en');
const sameAttributes = (a: Record<string, string> | null | undefined, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());
/** Two rows agree on a product field when they differ only in letter case. */
const caseless = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'string' ? lower(x) : x));
const sameAmount =(a: string | null | undefined, b: string) => a != null && toDec(a).eq(toDec(b));

/**
 * Products from a file (the admin reads the CSV): every row checked first, then all of it applied in
 * one transaction, or nothing. It never archives an item or removes a barcode, and it never changes
 * stock: quantities come in through a stock count or a goods receipt.
 */
@Injectable()
export class ProductImportService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    product_variants_tenant_sku_unique: ['SKU_TAKEN', 'Another active variant already uses this SKU'],
    barcodes_tenant_code_active_unique: ['BARCODE_TAKEN', 'Another active item already uses this barcode'],
    product_prices_version_unique: ['PRICE_VERSION_EXISTS', 'A price already starts at that exact time'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /** What the import would do, row by row, without changing anything. */
  preview(auth: AuthContext, input: ProductImportInput): Promise<ImportPlanView> {
    this.assertCan(auth, 'catalog.manage');
    return this.read(auth, async (db) => (await this.plan(db, auth, input.rows)).view);
  }

  /** Apply the whole file, or refuse it (422 `IMPORT_INVALID` with the rows in error) and change nothing. */
  commit(auth: AuthContext, input: ProductImportInput): Promise<ImportPlanView> {
    this.assertCan(auth, 'catalog.manage');
    return this.mutate(auth, async (db) => {
      // One import at a time per business, so two files cannot both make the same SKU's product.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(app_current_tenant_id()::text || ':product-import'))`);
      const plan = await this.plan(db, auth, input.rows);
      if (plan.view.summary.errors > 0) {
        throw new AppError('IMPORT_INVALID', 'Some rows cannot be imported; nothing was changed', HttpStatus.UNPROCESSABLE_ENTITY, {
          rows: plan.view.rows.filter((r) => r.action === 'ERROR'),
          summary: plan.view.summary,
        });
      }
      await this.apply(db, auth, plan);
      return plan.view;
    });
  }

  // ---------------------------------------------------------------- planning
  private async plan(db: Database, auth: AuthContext, rows: ProductImportRow[]): Promise<Plan> {
    const skus = [...new Set(rows.map((r) => lower(r.sku)))];
    const codes = [...new Set(rows.flatMap((r) => r.barcodes))];
    const uoms = await db.select().from(unitsOfMeasure).where(isNull(unitsOfMeasure.archivedAt));
    const taxes = await db.select().from(taxCategories).where(isNull(taxCategories.archivedAt));
    const cats = await db.select().from(categories).where(isNull(categories.archivedAt));
    const [defaultList] = await db.select({ id: priceLists.id }).from(priceLists).where(and(eq(priceLists.isDefault, true), isNull(priceLists.archivedAt)));
    const matched = await db
      .select({ variant: productVariants, product: products })
      .from(productVariants)
      .innerJoin(products, and(eq(products.tenantId, productVariants.tenantId), eq(products.id, productVariants.productId)))
      .where(and(isNull(productVariants.archivedAt), inArray(sql`lower(${productVariants.sku})`, skus)));
    const bySku = new Map(matched.map((m) => [lower(m.variant.sku), m]));
    const matchedIds = matched.map((m) => m.variant.id);
    const taken = codes.length
      ? await db.select({ code: barcodes.code, variantId: barcodes.variantId }).from(barcodes).where(and(isNull(barcodes.archivedAt), inArray(barcodes.code, codes)))
      : [];
    const codeOwner = new Map(taken.map((b) => [b.code, b.variantId]));
    const currentCodes = new Map<string, Set<string>>();
    if (matchedIds.length) {
      const own = await db.select({ code: barcodes.code, variantId: barcodes.variantId }).from(barcodes).where(and(isNull(barcodes.archivedAt), inArray(barcodes.variantId, matchedIds)));
      for (const b of own) currentCodes.set(b.variantId, (currentCodes.get(b.variantId) ?? new Set()).add(b.code));
    }
    const currentPrice = new Map<string, string>();
    if (defaultList && matchedIds.length) {
      const { rows: prices } = await db.execute<{ variant_id: string; amount: string }>(sql`
        SELECT DISTINCT ON (variant_id) variant_id, amount FROM product_prices
         WHERE price_list_id = ${defaultList.id} AND effective_from <= ${effectiveNowSql}
           AND variant_id IN (${sql.join(matchedIds.map((id) => sql`${id}::uuid`), sql`, `)})
         ORDER BY variant_id, effective_from DESC`);
      for (const p of prices) currentPrice.set(p.variant_id, p.amount);
    }
    // New SKUs join the one active product of the same name, when there is exactly one.
    const newNames = [...new Set(rows.filter((r) => !bySku.has(lower(r.sku))).map((r) => lower(r.name)))];
    const sameName = newNames.length
      ? await db.select().from(products).where(and(isNull(products.archivedAt), inArray(sql`lower(${products.name})`, newNames)))
      : [];

    const resolveCategory = categoryResolver(cats);
    const canPrice = this.can(auth, 'prices.manage');
    const targets = new Map<string, Target>();
    const nameTarget = new Map<string, string>();
    const skuLine = new Map<string, number>();
    const codeLine = new Map<string, number>();
    const results: ImportRowResult[] = [];

    // Existing products named in the file by one of their SKUs come first, so a new SKU under the same name joins them.
    for (const r of rows) {
      const m = bySku.get(lower(r.sku));
      if (m && !nameTarget.has(lower(r.name))) nameTarget.set(lower(r.name), `p:${m.product.id}`);
    }

    for (const row of rows) {
      const result: ImportRowResult = { line: row.line, sku: row.sku, action: 'UNCHANGED', changes: [], errors: [], values: {}, warnings: [] };
      results.push(result);
      const fail = (code: string, message: string) => result.errors.push({ code, message });

      const seen = skuLine.get(lower(row.sku));
      if (seen !== undefined) fail('DUPLICATE_SKU', `This SKU is also on line ${seen}`);
      else skuLine.set(lower(row.sku), row.line);

      const m = bySku.get(lower(row.sku));
      for (const code of new Set(row.barcodes)) {
        const other = codeLine.get(code);
        if (other !== undefined) fail('DUPLICATE_BARCODE', `Barcode ${code} is also on line ${other}`);
        else codeLine.set(code, row.line);
        const owner = codeOwner.get(code);
        if (owner && owner !== m?.variant.id) fail('BARCODE_TAKEN', `Barcode ${code} belongs to another item`);
      }

      let key: string;
      let existing: ProductRow | null = null;
      if (m) {
        key = `p:${m.product.id}`;
        existing = m.product;
      } else {
        const joined = nameTarget.get(lower(row.name));
        const named = sameName.filter((p) => lower(p.name) === lower(row.name));
        if (joined) key = joined;
        else if (named.length > 1) {
          fail('AMBIGUOUS_PRODUCT', `Several products are called “${row.name}”: add a row with one of its SKUs, or give the new item another name`);
          key = `n:${lower(row.name)}`;
        } else if (named.length === 1) key = `p:${named[0]!.id}`;
        else key = `n:${lower(row.name)}`;
        nameTarget.set(lower(row.name), key);
        existing = key.startsWith('p:') ? ([...matched.map((x) => x.product), ...sameName].find((p) => `p:${p.id}` === key) ?? null) : null;
      }
      const target = targets.get(key) ?? { key, existing, rows: [], wanted: {}, givenOn: {} };
      targets.set(key, target);
      target.rows.push({ row, result, variant: m?.variant ?? null });

      // Product fields: every row of one product must agree with the first that gives each.
      const want = <K extends keyof Target['wanted']>(field: ProductField, prop: K, value: NonNullable<Target['wanted'][K]>) => {
        const before = target.wanted[prop];
        if (before === undefined) {
          target.wanted[prop] = value;
          target.givenOn[field] = row.line;
        } else if (caseless(before) !== caseless(value)) {
          fail('PRODUCT_DISAGREES', `Line ${target.givenOn[field]} gives this product another ${FIELD_WORDS[field]}`);
        }
      };
      want('name', 'name', row.name);
      if (row.category !== undefined) {
        const c = resolveCategory(row.category);
        if ('error' in c) fail('AMBIGUOUS_CATEGORY', c.error);
        else if ('path' in c && c.path.length > CATEGORY_MAX_DEPTH) {
          fail('CATEGORY_TOO_DEEP', `Categories go ${CATEGORY_MAX_DEPTH} levels deep at most; “${c.path.join(' › ')}” has ${c.path.length}`);
        } else if ('path' in c && c.path.some((part) => part.length > CATEGORY_NAME_MAX)) {
          fail('CATEGORY_NAME_TOO_LONG', `A category name has ${CATEGORY_NAME_MAX} characters at most`);
        } else want('category', 'category', c);
      }
      if (row.tax !== undefined) {
        const tax = taxes.find((x) => lower(x.code) === lower(row.tax!)) ?? taxes.find((x) => lower(x.name) === lower(row.tax!));
        if (!tax) fail('UNKNOWN_TAX', `No tax category “${row.tax}”`);
        else want('tax', 'taxId', tax.id);
      }
      if (row.unit !== undefined) {
        const uom = uoms.find((u) => lower(u.code) === lower(row.unit!));
        if (!uom) fail('UNKNOWN_UNIT', `No unit “${row.unit}”`);
        else want('unit', 'uomId', uom.id);
      }
      if (row.soldBy !== undefined) want('soldBy', 'soldBy', row.soldBy);
      if (row.productType !== undefined) want('productType', 'productType', row.productType);
      if (row.trackInventory !== undefined) want('trackInventory', 'trackInventory', row.trackInventory);
      if (row.tracksExpiry !== undefined) want('tracksExpiry', 'tracksExpiry', row.tracksExpiry);

      // Variant fields.
      if (row.price !== undefined && (!m || !sameAmount(currentPrice.get(m.variant.id), row.price))) {
        if (!canPrice) fail('FORBIDDEN', 'You do not have permission to set prices');
        else if (!defaultList) fail('NO_DEFAULT_PRICE_LIST', 'Create a default price list first');
        else {
          result.changes.push('price');
          if (m) result.values.price = { before: currentPrice.get(m.variant.id) ?? null, after: row.price };
        }
      }
      if (m) {
        if (row.variantName !== undefined && row.variantName !== m.variant.name) result.changes.push('variantName');
        if (row.referenceCost !== undefined && !sameAmount(m.variant.referenceCost, row.referenceCost)) result.changes.push('referenceCost');
        if (row.attributes !== undefined && !sameAttributes(m.variant.attributes as Record<string, string> | null, row.attributes)) result.changes.push('attributes');
        const mine = currentCodes.get(m.variant.id) ?? new Set();
        if (row.barcodes.some((c) => !mine.has(c))) result.changes.push('barcodes');
      }
    }

    await this.leadingZeroWarnings(db, rows, results, bySku);

    // Each product as a whole: the fields an existing one cannot change, and the rules a new one must follow.
    const newCategoryPaths = new Map<string, string[]>();
    for (const target of targets.values()) {
      const first = target.rows[0]!;
      const w = target.wanted;
      const p = target.existing;
      const at = (field: ProductField) => target.rows.find((r) => r.row.line === target.givenOn[field]) ?? first;
      if (p) {
        if (w.uomId && w.uomId !== p.uomId) at('unit').result.errors.push({ code: 'UNIT_FIXED', message: 'The unit of an existing product cannot change: make a new product' });
        if (w.soldBy && w.soldBy !== p.soldBy) at('soldBy').result.errors.push({ code: 'SOLD_BY_FIXED', message: '“Sold by” of an existing product cannot change: make a new product' });
        if (w.productType && w.productType !== p.productType) at('productType').result.errors.push({ code: 'TYPE_FIXED', message: 'An existing product cannot become a service, or stop being one' });
        const changed: [ProductField, boolean][] = [
          // A new SKU joins a product by its name in any case: only a row found by its SKU renames it.
          ['name', !!w.name && w.name !== p.name && (at('name').variant !== null || lower(w.name) !== lower(p.name))],
          ['category', !!w.category && !('id' in w.category && w.category.id === p.categoryId)],
          ['tax', !!w.taxId && w.taxId !== p.taxCategoryId],
          ['trackInventory', w.trackInventory !== undefined && w.trackInventory !== p.trackInventory],
          ['tracksExpiry', w.tracksExpiry !== undefined && w.tracksExpiry !== p.tracksExpiry],
        ];
        for (const [field, yes] of changed) if (yes) at(field).result.changes.unshift(field);
        if (changed[0]![1]) at('name').result.values.name = { before: p.name, after: w.name! };
        if (changed[1]![1]) {
          const c = w.category!;
          at('category').result.values.category = {
            before: p.categoryId ? pathNames(cats, p.categoryId).join(' › ') || null : null,
            after: 'id' in c ? pathNames(cats, c.id).join(' › ') : c.path.join(' › '),
          };
        }
      }
      const productType = p?.productType ?? w.productType ?? 'STANDARD';
      const trackInventory = w.trackInventory ?? p?.trackInventory ?? productType === 'STANDARD';
      const tracksExpiry = w.tracksExpiry ?? p?.tracksExpiry ?? false;
      if (productType !== 'STANDARD' && trackInventory) at('trackInventory').result.errors.push({ code: 'INVALID_STATE', message: 'Services cannot track inventory' });
      if (tracksExpiry && !trackInventory) at('tracksExpiry').result.errors.push({ code: 'EXPIRY_NEEDS_STOCK', message: 'Expiry dates need stock that is counted' });
      if (!p) {
        const uom = w.uomId ? uoms.find((u) => u.id === w.uomId) : uoms.find((u) => u.code === 'PC');
        if (!uom) first.result.errors.push({ code: 'UNKNOWN_UNIT', message: 'Give the unit (there is no PC unit)' });
        if (!w.taxId && !taxes.some((x) => x.code === 'VAT')) first.result.errors.push({ code: 'UNKNOWN_TAX', message: 'Give the tax category (there is no VAT category)' });
        if ((w.soldBy ?? 'UNIT') === 'WEIGHT' && uom && !uom.allowsFraction) {
          at('soldBy').result.errors.push({ code: 'UOM_NOT_FRACTIONAL', message: 'Weighted products need a unit that allows fractions (e.g. KG)' });
        }
      }
      if (w.category && 'path' in w.category) newCategoryPaths.set(w.category.path.map(lower).join('\u0000'), w.category.path);
      for (const [i, r] of target.rows.entries()) {
        if (r.result.errors.length) r.result.action = 'ERROR';
        else if (!r.variant) r.result.action = !p && i === 0 ? 'CREATE' : 'ADD_VARIANT';
        else r.result.action = r.result.changes.length ? 'UPDATE' : 'UNCHANGED';
      }
    }

    const count = (a: ImportAction) => results.filter((r) => r.action === a).length;
    return {
      view: {
        rows: results,
        summary: { products: count('CREATE'), variants: count('ADD_VARIANT'), updated: count('UPDATE'), unchanged: count('UNCHANGED'), errors: count('ERROR') },
        newCategories: [...newCategoryPaths.values()].map((p) => p.join(' › ')),
      },
      targets: [...targets.values()],
      defaultListId: defaultList?.id ?? null,
      newCategoryPaths: [...newCategoryPaths.values()],
      currentPrice,
      currentCodes,
    };
  }

  /**
   * A spreadsheet drops the leading zeros of a number-like cell: SKU 00123 comes back as 123 and
   * barcode 0012345678905 as 12345678905. Such a row is not wrong in itself (it would add a variant or
   * a barcode), so it is flagged, not refused: a new SKU that equals an existing one but for leading
   * zeros, and a new all-digit barcode that an active barcode equals with zeros in front.
   */
  private async leadingZeroWarnings(db: Database, rows: ProductImportRow[], results: ImportRowResult[], bySku: Map<string, unknown>): Promise<void> {
    const strip = (s: string) => s.replace(/^0+/, '');
    const newSkus = rows.filter((r) => !bySku.has(lower(r.sku)) && strip(r.sku) !== '');
    const fileSkus = new Set(rows.map((r) => lower(r.sku)));
    if (newSkus.length) {
      const { rows: near } = await db.execute<{ sku: string }>(sql`
        SELECT sku FROM product_variants
         WHERE archived_at IS NULL
           AND ltrim(lower(sku), '0') IN (SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(newSkus.map((r) => strip(lower(r.sku))))])}::jsonb))`);
      for (const r of newSkus) {
        const other = near.find((n) => lower(n.sku) !== lower(r.sku) && !fileSkus.has(lower(n.sku)) && strip(lower(n.sku)) === strip(lower(r.sku)));
        if (other) {
          results.find((x) => x.line === r.line)!.warnings.push({
            code: 'SKU_LEADING_ZEROS',
            message: `SKU ${other.sku} already exists: did the spreadsheet drop its leading zeros?`,
            vars: { sku: other.sku },
          });
        }
      }
    }
    // EAN-13 at most: a code of 6 to 12 digits that may have lost its zeros.
    const padded = (code: string) => (/^\d{6,12}$/.test(code) ? Array.from({ length: 13 - code.length }, (_, k) => '0'.repeat(k + 1) + code) : []);
    const candidates = [...new Set(rows.flatMap((r) => r.barcodes.flatMap(padded)))];
    if (candidates.length) {
      const { rows: near } = await db.execute<{ code: string }>(sql`
        SELECT code FROM barcodes
         WHERE archived_at IS NULL AND code IN (SELECT jsonb_array_elements_text(${JSON.stringify(candidates)}::jsonb))`);
      const found = new Set(near.map((n) => n.code));
      const inFile = new Set(rows.flatMap((r) => r.barcodes));
      for (const r of rows) {
        for (const code of new Set(r.barcodes)) {
          const other = padded(code).find((c) => found.has(c) && !inFile.has(c));
          if (other) {
            results.find((x) => x.line === r.line)!.warnings.push({
              code: 'BARCODE_LEADING_ZEROS',
              message: `Barcode ${other} already exists: did the spreadsheet drop the leading zeros of ${code}?`,
              vars: { code, existing: other },
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- applying
  private async apply(db: Database, auth: AuthContext, plan: Plan): Promise<void> {
    const tenantId = tenantOf(auth).tenantId;
    const imported = { imported: true };
    // Categories the file names that do not exist yet, parents first.
    const madeCategory = new Map<string, string>();
    const cats = await db.select().from(categories).where(isNull(categories.archivedAt));
    for (const path of plan.newCategoryPaths) {
      let parentId: string | null = null;
      for (const [depth, part] of path.entries()) {
        const key = path.slice(0, depth + 1).map(lower).join('\u0000');
        const existing = madeCategory.get(key) ?? cats.find((c) => c.parentId === parentId && lower(c.name) === lower(part))?.id;
        if (existing) {
          parentId = existing;
          continue;
        }
        const [made]: { id: string }[] = await db.insert(categories).values({ tenantId, name: part, parentId }).returning({ id: categories.id });
        await this.audit(db, auth, 'category.created', 'category', made!.id, imported);
        madeCategory.set(key, made!.id);
        parentId = made!.id;
      }
    }
    const categoryId = (c: CategoryRef) => ('id' in c ? c.id : madeCategory.get(c.path.map(lower).join('\u0000'))!);
    const vat = (await db.select({ id: taxCategories.id }).from(taxCategories).where(and(eq(taxCategories.code, 'VAT'), isNull(taxCategories.archivedAt))))[0];
    const pc = (await db.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(and(eq(unitsOfMeasure.code, 'PC'), isNull(unitsOfMeasure.archivedAt))))[0];

    const prices: { variantId: string; amount: string }[] = [];
    for (const target of plan.targets) {
      const w = target.wanted;
      let productId: string;
      if (!target.existing) {
        const productType = w.productType ?? 'STANDARD';
        const [product] = await db
          .insert(products)
          .values({
            tenantId,
            name: w.name!,
            categoryId: w.category ? categoryId(w.category) : null,
            taxCategoryId: w.taxId ?? vat!.id,
            uomId: w.uomId ?? pc!.id,
            productType,
            soldBy: w.soldBy ?? 'UNIT',
            trackInventory: w.trackInventory ?? productType === 'STANDARD',
            tracksExpiry: w.tracksExpiry ?? false,
          })
          .returning({ id: products.id });
        productId = product!.id;
        await this.audit(db, auth, 'product.created', 'product', productId, { variants: target.rows.length, ...imported });
        await emitEvent(db, { tenantId, topic: 'catalog.product_created', payload: { productId }, correlationId: auth.correlationId });
      } else {
        productId = target.existing.id;
        const fields = [...new Set(target.rows.flatMap((r) => r.result.changes))].filter((f) => ['name', 'category', 'tax', 'trackInventory', 'tracksExpiry'].includes(f));
        if (fields.length) {
          await db
            .update(products)
            .set({
              ...(fields.includes('name') && { name: w.name! }),
              ...(fields.includes('category') && { categoryId: categoryId(w.category!) }),
              ...(fields.includes('tax') && { taxCategoryId: w.taxId! }),
              ...(fields.includes('trackInventory') && { trackInventory: w.trackInventory! }),
              ...(fields.includes('tracksExpiry') && { tracksExpiry: w.tracksExpiry! }),
            })
            .where(eq(products.id, productId));
          await this.audit(db, auth, 'product.updated', 'product', productId, { fields: fields.map((f) => PRODUCT_COLUMNS[f]), ...imported });
        }
      }

      for (const { row, result, variant } of target.rows) {
        let variantId: string;
        if (!variant) {
          const [made] = await db
            .insert(productVariants)
            .values({ tenantId, productId, sku: row.sku, name: row.variantName ?? null, attributes: row.attributes ?? {}, referenceCost: row.referenceCost ?? null })
            .returning({ id: productVariants.id });
          variantId = made!.id;
          if (target.existing) await this.audit(db, auth, 'variant.created', 'variant', variantId, { productId, sku: row.sku, ...imported });
        } else {
          variantId = variant.id;
          const set = {
            ...(result.changes.includes('variantName') && { name: row.variantName! }),
            ...(result.changes.includes('referenceCost') && { referenceCost: row.referenceCost! }),
            ...(result.changes.includes('attributes') && { attributes: row.attributes! }),
          };
          if (Object.keys(set).length) {
            await db.update(productVariants).set(set).where(eq(productVariants.id, variantId));
            await this.audit(db, auth, 'variant.updated', 'variant', variantId, { fields: Object.keys(set), ...imported });
          }
        }
        const have = plan.currentCodes.get(variantId) ?? new Set<string>();
        const add = [...new Set(row.barcodes)].filter((c) => !have.has(c));
        if (add.length) {
          const made = await db.insert(barcodes).values(add.map((code) => ({ tenantId, variantId, code }))).returning({ id: barcodes.id, code: barcodes.code });
          for (const b of made) await this.audit(db, auth, 'barcode.added', 'barcode', b.id, { variantId, code: b.code, ...imported });
        }
        if (row.price !== undefined && result.changes.includes('price')) prices.push({ variantId, amount: row.price });
      }
    }
    if (prices.length) {
      // DB clock, the same one prices are resolved against (common/clock.ts).
      await db.insert(productPrices).values(prices.map((p) => ({ tenantId, priceListId: plan.defaultListId!, variantId: p.variantId, amount: p.amount, effectiveFrom: sql`now()`, createdBy: auth.userId })));
      await this.audit(db, auth, 'prices.set', 'price_list', plan.defaultListId!, { count: prices.length, ...imported });
    }
  }
}

const FIELD_WORDS: Record<ProductField, string> = {
  name: 'name',
  category: 'category',
  tax: 'tax category',
  unit: 'unit',
  soldBy: '“sold by”',
  productType: 'type',
  trackInventory: 'stock tracking',
  tracksExpiry: 'expiry setting',
};

/** The product columns behind the import's field names, as `product.updated` audit rows name them. */
const PRODUCT_COLUMNS: Record<string, string> = { name: 'name', category: 'categoryId', tax: 'taxCategoryId', trackInventory: 'trackInventory', tracksExpiry: 'tracksExpiry' };

/**
 * A category by its name, or by a path from the top ("Drinks › Hot drinks", › or >). A single name
 * matches a category at any depth when only one has it. What is not found becomes a path to make.
 */
function categoryResolver(cats: (typeof categories.$inferSelect)[]) {
  return (text: string): CategoryRef | { error: string } => {
    const parts = text.split(SEP).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      const named = cats.filter((c) => lower(c.name) === lower(parts[0]!));
      if (named.length === 1) return { id: named[0]!.id };
      if (named.length > 1) return { error: `Several categories are called “${parts[0]}”: write its full path, such as Parent › ${parts[0]}` };
      return { path: parts };
    }
    let parentId: string | null = null;
    for (const [i, part] of parts.entries()) {
      const found = cats.find((c) => c.parentId === parentId && lower(c.name) === lower(part));
      if (!found) {
        // The part that exists is kept as named in the shop; the rest is made.
        return { path: [...pathNames(cats, parentId), ...parts.slice(i)] };
      }
      parentId = found.id;
    }
    return { id: parentId! };
  };
}

function pathNames(cats: (typeof categories.$inferSelect)[], id: string | null): string[] {
  const names: string[] = [];
  for (let c = cats.find((x) => x.id === id); c; c = cats.find((x) => x.id === c!.parentId)) names.unshift(c.name);
  return names;
}
