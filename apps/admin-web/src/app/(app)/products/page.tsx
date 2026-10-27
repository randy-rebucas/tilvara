import { ChevronRight, Download, Search } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Category, type CurrentPrice, type Me, type PriceList, type Product, type TaxCategory, type Uom } from '@/lib/api';
import { categoryOptions } from '@/lib/categories';
import { activeFilterCount, filtersToSearch, FILTER_KEYS, productApiQuery, readProductFilters, type ProductFilters } from '@/lib/product-filters';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import type { MessageKey } from '@/i18n/messages';
import { AddProduct } from './add-product';
import { FilterSheet } from './filter-sheet';
import { ImportProducts } from './import-products';
import { ProductsTabs } from './tabs';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('products');

type List<T> = { data: T[] };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const filters = readProductFilters(sp);
  const cursor = typeof sp.cursor === 'string' ? sp.cursor.slice(0, 1200) : undefined;
  const { q } = filters;

  const [me, products, uoms, taxes, lists, cats] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Product[]; nextCursor: string | null }>(`/products?${productApiQuery(filters, { limit: 50, cursor })}`),
    apiOrNull<List<Uom>>('/uoms'),
    apiOrNull<List<TaxCategory>>('/tax-categories'),
    apiOrNull<List<PriceList>>('/price-lists'),
    apiOrNull<List<Category>>('/categories'),
  ]);
  // Categories by their full path ("Drinks › Hot drinks"), for the column, the filter and the add form.
  const catOptions = categoryOptions(cats?.data);
  const catName = new Map([...(cats?.data ?? []).map((c) => [c.id, c.name] as const), ...catOptions.map((o) => [o.id, o.label] as const)]);
  const defaultList = lists?.data.find((l) => l.isDefault);
  const prices = defaultList ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;
  const priceOf = new Map(prices?.data.map((p) => [p.variantId, p.amount]));
  const canManage = me.activeTenant?.permissions.includes('catalog.manage') ?? false;
  const live = (p: Product) => p.variants.filter((x) => !x.archivedAt);
  const first = (p: Product) => live(p)[0] ?? p.variants[0];
  const nameLink = (p: Product) => <Link href={`/products/${p.id}`} className="block font-semibold underline">{p.name}</Link>;
  const tags = (p: Product) => (
    <>
      {p.archivedAt ? <span className="tag">{t('prod.archived')}</span> : <span className="tag">{t('common.active')}</span>}
      {p.productType === 'SERVICE' && <span className="tag ml-1.5">{t('prod.kind.SERVICE')}</span>}
      {p.isSample && <span className="tag ml-1.5 border-blue/40 text-blue!">{t('sample.tag')}</span>}
    </>
  );

  // Each filter in force, in words, with a link that takes only that one off.
  const taxName = (id: string) => taxes?.data.find((x) => x.id === id)?.name ?? '—';
  const filterWords: Record<(typeof FILTER_KEYS)[number], (v: string) => string> = {
    category: (v) => t('cat.filtered', { name: v === 'none' ? t('prod.noCategory') : (catName.get(v) ?? '—') }),
    status: (v) => t(`pf.status.${v}` as MessageKey),
    type: (v) => t(`pf.type.${v}` as MessageKey),
    soldBy: (v) => `${t('prod.soldBy')}: ${v === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit')}`,
    tax: (v) => `${t('prod.tax')}: ${taxName(v)}`,
    stock: (v) => `${t('pf.stock')}: ${t(`pf.stock.${v}` as MessageKey)}`,
    expiry: (v) => `${t('pf.expiry')}: ${t(`pf.expiry.${v}` as MessageKey)}`,
    barcode: (v) => t(`pf.barcode.${v}` as MessageKey),
    price: (v) => t(`pf.price.${v}` as MessageKey),
    variants: (v) => `${t('pf.variants')}: ${t(`pf.variants.${v}` as MessageKey)}`,
  };
  const inForce = FILTER_KEYS.filter((k) => filters[k] !== undefined);
  const without = (k: keyof ProductFilters) => {
    const s = filtersToSearch({ ...filters, [k]: undefined });
    return s.size ? `/products?${s}` : '/products';
  };
  const count = activeFilterCount(filters);
  const exportHref = `/products/export${filtersToSearch(filters).size ? `?${filtersToSearch(filters)}` : ''}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
      <ProductsTabs active="products" />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex w-full max-w-[560px] gap-2">
            <form role="search" className="relative min-w-0 flex-1" action="/products">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <label className="sr-only" htmlFor="q">{t('prod.search')}</label>
              <input id="q" name="q" defaultValue={q} placeholder={t('prod.search')} className="input pl-9" />
              {/* A new search keeps the filters and the sort in force. */}
              {[...filtersToSearch({ ...filters, q: undefined })].map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            </form>
            <FilterSheet
              filters={filters}
              categories={catOptions.map((o): [string, string] => [o.id, o.label])}
              taxes={(taxes?.data ?? []).filter((x) => !x.archivedAt).map((x): [string, string] => [x.id, x.name])}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {products && (
              <a href={exportHref} download className="btn">
                <Download aria-hidden className="size-4" /> {t('pio.export')}
              </a>
            )}
            {canManage && <ImportProducts />}
            {canManage && uoms && taxes && <AddProduct uoms={uoms.data.filter((u) => u.code)} taxes={taxes.data} categories={catOptions} />}
          </div>
        </div>


        {inForce.length > 0 && (
          <ul className="flex flex-wrap items-center gap-2 text-[0.875rem]" data-testid="category-filter" aria-label={t('pf.filters')}>
            {inForce.map((k) => (
              <li key={k} className="tag inline-flex items-center gap-1.5">
                {filterWords[k](filters[k]!)}
                <Link href={without(k)} className="underline" aria-label={`${t('audit.clear')}: ${filterWords[k](filters[k]!)}`}>×</Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Note denom="blue" className="pr-2">
        {products && products.data.length > 0 ? (
          <RecordTable
            rows={products.data}
            rowKey={(p) => p.id}
            dimmed={(p) => !!p.archivedAt}
            columns={[
              { header: t('prod.name'), cell: (p) => <>{nameLink(p)}{live(p).length > 1 && <span className="text-[0.8125rem] text-muted">{t('prod.variants', { n: live(p).length })}</span>}</> },
              { header: t('prod.sku'), cell: (p) => <Serial className="text-ink">{first(p)?.sku}</Serial> },
              { header: t('prod.barcodeCol'), cell: (p) => <Serial>{first(p)?.barcodes[0] ?? '—'}</Serial> },
              { header: t('prod.category'), cell: (p) => <span className="text-[0.875rem]">{p.categoryId ? (catName.get(p.categoryId) ?? '—') : <span className="text-muted">—</span>}</span> },
              { header: t('prod.soldBy'), cell: (p) => (p.soldBy === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit')) },
              { header: t('price.current'), num: true, cell: (p) => <span className="money font-semibold">{first(p) ? peso(priceOf.get(first(p)!.id)) : '—'}</span> },
              { header: t('common.status'), cell: (p) => <span className="whitespace-nowrap">{tags(p)}</span> },
            ]}
            stacked={{
              title: (p) => nameLink(p),
              meta: (p) => (
                <>
                  <Serial>
                    {first(p)?.sku}
                    {first(p)?.barcodes[0] ? ` · ${first(p)!.barcodes[0]}` : ''}
                    {p.categoryId && catName.get(p.categoryId) ? ` · ${catName.get(p.categoryId)}` : ''}
                    {live(p).length > 1 ? ` · ${t('prod.variants', { n: live(p).length })}` : ''}
                  </Serial>
                  <span className="mt-1 block">{tags(p)}</span>
                </>
              ),
              figure: (p) => <span className="money font-semibold">{first(p) ? peso(priceOf.get(first(p)!.id)) : '—'}</span>,
            }}
          />
        ) : (
          <Empty>{!products ? t('common.noAccess') : q ? t('prod.noMatch', { q }) : count ? t('pf.noMatch') : t('prod.empty')}</Empty>
        )}
      </Note>

      {products?.nextCursor && (
        <Link className="btn self-center" href={`/products?${filtersToSearch(filters, { cursor: products.nextCursor })}`}>
          {t('common.nextPage')} <ChevronRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}
