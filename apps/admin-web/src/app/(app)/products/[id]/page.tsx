import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Note, Serial } from '@/components/note';
import { api, apiOrNull, type CurrentPrice, type Me, type PriceList, type ProductDetail, type TaxCategory, type Uom } from '@/lib/api';
import { peso } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { AddBarcode, AddVariant, EditProduct, EditVariant, RemoveBarcode } from './forms';

export const metadata = { title: 'Product' };

/** One product and its variants: details, barcodes, reference cost and the default price, with edit and archive. */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t } = await getT();
  const [me, product, taxes, uoms, lists] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<ProductDetail>(`/products/${id}`),
    apiOrNull<{ data: TaxCategory[] }>('/tax-categories'),
    apiOrNull<{ data: Uom[] }>('/uoms'),
    apiOrNull<{ data: PriceList[] }>('/price-lists'),
  ]);
  if (!product) notFound();
  const defaultList = lists?.data.find((l) => l.isDefault);
  const prices = defaultList ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;
  const priceOf = new Map(prices?.data.map((p) => [p.variantId, p.amount]));
  const canManage = (me.activeTenant?.permissions.includes('catalog.manage') ?? false) && !product.archivedAt;
  const tax = taxes?.data.find((x) => x.id === product.taxCategoryId);
  const uom = uoms?.data.find((u) => u.id === product.uomId);
  const live = product.variants.filter((v) => !v.archivedAt);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/products" className="text-[0.875rem] text-muted underline">{t('prod.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{product.name}</h1>
        <Serial className="mt-1 block">
          {uom?.code ?? '—'} · {product.soldBy === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit')} · {tax?.name ?? '—'} · {product.productType === 'SERVICE' ? t('prod.service') : product.trackInventory ? t('prod.tracked') : t('prod.untracked')}
        </Serial>
        {product.description && <p className="mt-2 max-w-[68ch] text-muted">{product.description}</p>}
      </div>

      {product.archivedAt && <Callout>{t('prod.archivedNote')}</Callout>}

      {canManage && taxes && (
        <div className="flex flex-wrap items-start gap-2">
          <EditProduct product={product} taxes={taxes.data} />
          <AddVariant productId={product.id} />
          <ActionButton url={`/api/v1/products/${product.id}/archive`} label={t('prod.archive')} confirmText={t('prod.archiveConfirm', { name: product.name })} />
        </div>
      )}

      <section>
        <h2 className="section-title mb-3">{t('prod.variantsTitle')}</h2>
        <div className="flex flex-col gap-3">
          {product.variants.map((v) => (
            <Note key={v.id} denom="blue" className={`flex flex-col gap-3 px-4 py-3 pr-6 ${v.archivedAt ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{v.name ?? product.name}{v.archivedAt && <span className="tag ml-2">{t('prod.archived')}</span>}</p>
                  <Serial className="text-ink">{v.sku}</Serial>
                </div>
                <dl className="flex gap-6 text-right">
                  <div>
                    <dt className="text-[0.75rem] text-muted">{t('price.current')}</dt>
                    <dd className="money font-semibold">{peso(priceOf.get(v.id))}</dd>
                  </div>
                  <div>
                    <dt className="text-[0.75rem] text-muted">{t('prod.refCost')}</dt>
                    <dd className="money">{peso(v.referenceCost)}</dd>
                  </div>
                </dl>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[0.8125rem] text-muted">{t('prod.barcodeCol')}:</span>
                {v.barcodeIds.length === 0 && <span className="text-[0.8125rem] text-muted">—</span>}
                {v.barcodeIds.map((b) => (canManage && !v.archivedAt ? <RemoveBarcode key={b.id} barcode={b} /> : <span key={b.id} className="tag serial">{b.code}</span>))}
              </div>
              {canManage && !v.archivedAt && (
                <div className="flex flex-wrap items-end gap-3">
                  <AddBarcode variantId={v.id} />
                  <EditVariant variant={v} />
                  {live.length > 1 && (
                    <ActionButton url={`/api/v1/variants/${v.id}/archive`} label={t('prod.archiveVariant')} confirmText={t('prod.archiveVariantConfirm', { sku: v.sku })} />
                  )}
                </div>
              )}
            </Note>
          ))}
        </div>
        {canManage && <p className="mt-2 text-[0.8125rem] text-muted">{t('prod.priceHint')} <Link href="/prices" className="underline">{t('price.title')}</Link></p>}
      </section>
    </div>
  );
}
