import { ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Category, type CurrentPrice, type Me, type PriceList, type Product, type TaxCategory, type Uom } from '@/lib/api';
import { categoryOptions } from '@/lib/categories';
import { isUuid } from '@/lib/options';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { AddProduct } from './add-product';
import { ProductsTabs } from './tabs';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('products');

type List<T> = { data: T[] };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string; category?: string }> }) {
  const { t } = await getT();
  const { q, cursor, category: rawCategory } = await searchParams;
  const category = rawCategory && isUuid(rawCategory) ? rawCategory : undefined;
  const query = new URLSearchParams({ limit: '50' });
  if (q) query.set('q', q);
  if (category) query.set('categoryId', category);
  if (cursor) query.set('cursor', cursor);

  const [me, products, uoms, taxes, lists, cats] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Product[]; nextCursor: string | null }>(`/products?${query}`),
    apiOrNull<List<Uom>>('/uoms'),
    apiOrNull<List<TaxCategory>>('/tax-categories'),
    apiOrNull<List<PriceList>>('/price-lists'),
    apiOrNull<List<Category>>('/categories'),
  ]);
  // Categories by their full path ("Drinks › Hot drinks"), for the column, the filter and the add form.
  const catOptions = categoryOptions(cats?.data);
  const catName = new Map([...(cats?.data ?? []).map((c) => [c.id, c.name] as const), ...catOptions.map((o) => [o.id, o.label] as const)]);
  const filtered = category ? catName.get(category) : undefined;
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
      <ProductsTabs active="products" />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <form role="search" className="relative w-full max-w-[420px]" action="/products">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <label className="sr-only" htmlFor="q">{t('prod.search')}</label>
          <input id="q" name="q" defaultValue={q} placeholder={t('prod.search')} className="input pl-9" />
          {category && <input type="hidden" name="category" value={category} />}
        </form>
        {canManage && uoms && taxes && <AddProduct uoms={uoms.data.filter((u) => u.code)} taxes={taxes.data} categories={catOptions} />}
      </div>

      {category && (
        <p className="-mt-3 flex flex-wrap items-center gap-2 text-[0.9375rem]" data-testid="category-filter">
          <span>{t('cat.filtered', { name: filtered ?? '—' })}</span>
          <Link href={q ? `/products?${new URLSearchParams({ q })}` : '/products'} className="underline">{t('cat.showAll')}</Link>
        </p>
      )}

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
          <Empty>{!products ? t('common.noAccess') : q ? t('prod.noMatch', { q }) : t('prod.empty')}</Empty>
        )}
      </Note>

      {products?.nextCursor && (
        <Link className="btn self-center" href={`/products?${new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}), cursor: products.nextCursor })}`}>
          {t('common.nextPage')} <ChevronRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}
