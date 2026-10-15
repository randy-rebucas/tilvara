import { ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { api, apiOrNull, type CurrentPrice, type Me, type PriceList, type Product, type TaxCategory, type Uom } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { AddProduct } from './add-product';

export const metadata = { title: 'Products' };

type List<T> = { data: T[] };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
  const { t } = await getT();
  const { q, cursor } = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (q) query.set('q', q);
  if (cursor) query.set('cursor', cursor);

  const [me, products, uoms, taxes, lists] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Product[]; nextCursor: string | null }>(`/products?${query}`),
    apiOrNull<List<Uom>>('/uoms'),
    apiOrNull<List<TaxCategory>>('/tax-categories'),
    apiOrNull<List<PriceList>>('/price-lists'),
  ]);
  const defaultList = lists?.data.find((l) => l.isDefault);
  const prices = defaultList ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;
  const priceOf = new Map(prices?.data.map((p) => [p.variantId, p.amount]));
  const canManage = me.activeTenant?.permissions.includes('catalog.manage') ?? false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('prod.title')} lede={t('prod.lede')} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <form role="search" className="relative w-full max-w-[420px]" action="/products">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <label className="sr-only" htmlFor="q">{t('prod.search')}</label>
          <input id="q" name="q" defaultValue={q} placeholder={t('prod.search')} className="input pl-9" />
        </form>
        {canManage && uoms && taxes && <AddProduct uoms={uoms.data.filter((u) => u.code)} taxes={taxes.data} />}
      </div>

      <Note denom="blue" className="overflow-x-auto pr-2">
        {products && products.data.length > 0 ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('prod.name')}</th>
                <th>{t('prod.sku')}</th>
                <th>{t('prod.barcodeCol')}</th>
                <th>{t('prod.soldBy')}</th>
                <th className="num">{t('price.current')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {products.data.map((p) => {
                const v = p.variants.filter((x) => !x.archivedAt);
                const first = v[0] ?? p.variants[0];
                return (
                  <tr key={p.id} className={p.archivedAt ? 'text-muted' : ''}>
                    <td>
                      <span className="block font-semibold">{p.name}</span>
                      {v.length > 1 && <span className="text-[0.8125rem] text-muted">{t('prod.variants', { n: v.length })}</span>}
                    </td>
                    <td><Serial className="text-ink">{first?.sku}</Serial></td>
                    <td><Serial>{first?.barcodes[0] ?? '—'}</Serial></td>
                    <td>{p.soldBy === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit')}</td>
                    <td className="num money font-semibold">{first ? peso(priceOf.get(first.id)) : '—'}</td>
                    <td>{p.archivedAt ? <span className="tag">{t('prod.archived')}</span> : <span className="tag">{t('common.active')}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>{!products ? t('common.noAccess') : q ? t('prod.noMatch', { q }) : t('prod.empty')}</Empty>
        )}
      </Note>

      {products?.nextCursor && (
        <Link className="btn self-center" href={`/products?${new URLSearchParams({ ...(q ? { q } : {}), cursor: products.nextCursor })}`}>
          {t('common.nextPage')} <ChevronRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}
