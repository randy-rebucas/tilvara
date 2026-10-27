import { isUuid } from './options';

/**
 * The products list's filters, as the page's URL carries them (`/products?status=archived&price=false`)
 * and as `GET /v1/products` takes them. The page, its next-page link and the CSV export read the same
 * parameters, so an export holds exactly what the list shows.
 */
export interface ProductFilters {
  q?: string;
  category?: string;
  status?: 'active' | 'archived' | 'all';
  type?: 'STANDARD' | 'SERVICE';
  soldBy?: 'UNIT' | 'WEIGHT';
  tax?: string;
  stock?: 'true' | 'false';
  expiry?: 'true' | 'false';
  barcode?: 'true' | 'false';
  price?: 'true' | 'false';
  variants?: 'true' | 'false';
  sort?: 'oldest' | 'newest' | 'name';
}

/** Filters that narrow the list (the search box and the sort are not counted). */
export const FILTER_KEYS = ['category', 'status', 'type', 'soldBy', 'tax', 'stock', 'expiry', 'barcode', 'price', 'variants'] as const;

const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
const flag = (v: string | undefined) => pick(v, ['true', 'false'] as const);

/** The filters from a page's search params; anything unknown or malformed is dropped. */
export function readProductFilters(sp: Record<string, string | string[] | undefined>): ProductFilters {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string).trim() : undefined);
  const q = one('q')?.slice(0, 100);
  const category = one('category');
  const tax = one('tax');
  const f: ProductFilters = {
    q: q || undefined,
    category: category === 'none' || (category && isUuid(category)) ? category : undefined,
    status: pick(one('status'), ['active', 'archived', 'all'] as const),
    type: pick(one('type'), ['STANDARD', 'SERVICE'] as const),
    soldBy: pick(one('soldBy'), ['UNIT', 'WEIGHT'] as const),
    tax: tax && isUuid(tax) ? tax : undefined,
    stock: flag(one('stock')),
    expiry: flag(one('expiry')),
    barcode: flag(one('barcode')),
    price: flag(one('price')),
    variants: flag(one('variants')),
    sort: pick(one('sort'), ['oldest', 'newest', 'name'] as const),
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as ProductFilters;
}

/** How many filters narrow the list. */
export const activeFilterCount = (f: ProductFilters) => FILTER_KEYS.filter((k) => f[k] !== undefined).length;

/** The page's own URL for these filters (for links: next page, clear one filter). */
export function filtersToSearch(f: ProductFilters, extra: Record<string, string> = {}): URLSearchParams {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined) s.set(k, v);
  for (const [k, v] of Object.entries(extra)) s.set(k, v);
  return s;
}

/** `GET /v1/products` query for these filters. A category includes its sub-categories. */
export function productApiQuery(f: ProductFilters, page: { limit: number; cursor?: string }): URLSearchParams {
  const s = new URLSearchParams({ limit: String(page.limit) });
  if (f.q) s.set('q', f.q);
  if (f.category) {
    s.set('categoryId', f.category);
    if (f.category !== 'none') s.set('withSubcategories', 'true');
  }
  if (f.status) s.set('status', f.status);
  if (f.type) s.set('productType', f.type);
  if (f.soldBy) s.set('soldBy', f.soldBy);
  if (f.tax) s.set('taxCategoryId', f.tax);
  if (f.stock) s.set('trackInventory', f.stock);
  if (f.expiry) s.set('tracksExpiry', f.expiry);
  if (f.barcode) s.set('hasBarcode', f.barcode);
  if (f.price) s.set('hasPrice', f.price);
  if (f.variants) s.set('hasVariants', f.variants);
  if (f.sort) s.set('sort', f.sort);
  if (page.cursor) s.set('cursor', page.cursor);
  return s;
}
