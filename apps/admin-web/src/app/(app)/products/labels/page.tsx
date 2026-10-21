import { Empty, Note, PageHeader, ToLocations } from '@/components/note';
import { allProducts, apiOrNull, type Branch, type CurrentPrice, type ItemLocation, type PriceList } from '@/lib/api';
import { getT } from '@/i18n/server';
import { ProductsTabs } from '../tabs';
import { LabelMaker } from './labels';

export const metadata = { title: 'Labels' };

/**
 * Price and shelf labels (ADR-0021 §4): items × copies on a sheet, a roll or shelf-edge strips, with
 * the price at a chosen branch and its shelf location. Every branch's prices and locations are read
 * here, so switching branch on the page keeps the items already picked.
 */
export default async function LabelsPage() {
  const { t } = await getT();
  const [products, branchList, lists] = await Promise.all([allProducts(), apiOrNull<{ data: Branch[] }>('/branches'), apiOrNull<{ data: PriceList[] }>('/price-lists')]);
  const branches = branchList?.data.filter((b) => !b.archivedAt) ?? [];
  const active = lists?.data.filter((l) => !l.archivedAt) ?? [];
  const listFor = (b: Branch) => active.find((l) => l.branchIds.includes(b.id)) ?? active.find((l) => l.isDefault);
  const usedLists = [...new Set(branches.map(listFor).filter((l): l is PriceList => !!l))];
  const [prices, locations] = await Promise.all([
    Promise.all(usedLists.map(async (l) => [l.id, (await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${l.id}/prices`))?.data ?? []] as const)),
    Promise.all(branches.map(async (b) => [b.id, (await apiOrNull<{ data: ItemLocation[] }>(`/stock/locations?branchId=${b.id}`))?.data ?? []] as const)),
  ]);
  const priceByList = new Map(prices);
  const byBranch = Object.fromEntries(
    branches.map((b) => {
      const list = listFor(b);
      return [
        b.id,
        {
          prices: Object.fromEntries((list ? (priceByList.get(list.id) ?? []) : []).map((p) => [p.variantId, p.amount])),
          locations: Object.fromEntries((locations.find(([id]) => id === b.id)?.[1] ?? []).map((l) => [l.variantId, l.location])),
        },
      ];
    }),
  );
  const pickable = (products?.data ?? [])
    .filter((p) => !p.archivedAt)
    .map((p) => ({ id: p.id, name: p.name, variants: p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, sku: v.sku, name: v.name, barcodes: v.barcodes })) }))
    .filter((p) => p.variants.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="contents print:hidden">
        <PageHeader title={t('prod.title')} lede={t('prod.lede')} />
        <ProductsTabs active="labels" />
      </div>
      {!products ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : branches.length === 0 ? (
        <Note><Empty action={<ToLocations label={t('loc.goTo')} />}>{t('inv.noBranch')}</Empty></Note>
      ) : (
        <LabelMaker products={pickable} branches={branches.map((b) => ({ id: b.id, code: b.code, name: b.name }))} byBranch={byBranch} />
      )}
    </div>
  );
}
