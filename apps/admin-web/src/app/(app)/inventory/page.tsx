import { redirect } from 'next/navigation';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type ItemLocation, type LowStockRow, type Me, type StockByBranch, type Valuation } from '@/lib/api';
import { peso, qty, signOf } from '@/lib/format';
import { variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { ALL, InventoryChrome, inventoryBranch } from './chrome';
import { LocationCell } from './locations';
import { AdjustStockForm, RemoveReorderPoint, ReorderForm } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory');

export default async function StockPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  const me = await api<Me>('/me');
  const perms = me.activeTenant?.permissions ?? [];
  // Someone who may only count stock (inventory.count) lands on the counts they can do.
  if (!perms.includes('inventory.read') && perms.includes('inventory.count')) redirect(`/inventory/counts${sp.branch ? `?branch=${sp.branch}` : ''}`);
  const { branches, branch } = await inventoryBranch(sp.branch);
  if (sp.branch === ALL && branches.length > 1) return <AllBranches branches={branches} branch={branch} />;
  const [valuation, low, points, products, locations] = await Promise.all([
    branch ? apiOrNull<Valuation>(`/reports/inventory-valuation?branchId=${branch.id}`) : null,
    branch ? apiOrNull<{ data: LowStockRow[] }>(`/stock/low?branchId=${branch.id}`) : null,
    branch ? apiOrNull<{ data: LowStockRow[] }>(`/stock/reorder-points?branchId=${branch.id}`) : null,
    allProducts(),
    branch ? apiOrNull<{ data: ItemLocation[] }>(`/stock/locations?branchId=${branch.id}`) : null,
  ]);
  const canReorder = perms.includes('purchasing.manage') || perms.includes('inventory.adjust');
  const canAdjust = perms.includes('inventory.adjust');
  // Shelf locations (ADR-0021 §5): set by whoever adjusts or counts stock here.
  const canPlace = perms.includes('inventory.adjust') || perms.includes('inventory.count');
  const placeOf = new Map(locations?.data.map((l) => [l.variantId, l.location]));
  // A Reserved column only when something is set aside (session 20).
  const anyReserved = valuation?.data.some((r) => r.reserved && signOf(r.reserved) > 0) ?? false;

  return (
    <InventoryChrome tab="stock" branches={branches} branch={branch}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('inv.tab.stock')}</h2>
          {canAdjust && branch && <AdjustStockForm branchId={branch.id} variants={variantOptions(products?.data, { stocked: true })} dated={products?.data.some((p) => p.tracksExpiry && !p.archivedAt) ?? false} />}
        </div>
        {valuation && (
          <div className="mb-3">
            {valuation.totalValue === valuation.ledgerValue ? (
              <p className="text-[0.875rem] text-muted">
                {t('inv.stockValue')}: <b className="money text-ink">{peso(valuation.totalValue)}</b> · {t('inv.ledgerOk')}
              </p>
            ) : (
              <Callout tone="error">{t('inv.ledgerOff', { v: peso(valuation.ledgerValue) })}</Callout>
            )}
          </div>
        )}
        <Note denom="gold" className="pr-2">
          {valuation && valuation.data.length > 0 ? (
            <RecordTable
              rows={valuation.data}
              rowKey={(r) => r.variantId}
              columns={[
                { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r) => r.name },
                {
                  header: t('shelf.location'),
                  cell: (r) =>
                    canPlace && branch ? (
                      <LocationCell key={`${branch.id}-${r.variantId}`} branchId={branch.id} variantId={r.variantId} name={r.name} location={placeOf.get(r.variantId) ?? null} />
                    ) : (
                      <Serial className="text-ink">{placeOf.get(r.variantId) ?? '—'}</Serial>
                    ),
                },
                { header: t('inv.onHand'), num: true, cell: (r) => <span className={signOf(r.quantity) < 0 ? 'text-red' : ''}>{qty(r.quantity)}</span> },
                ...(anyReserved
                  ? [
                      { header: t('inv.reserved'), num: true, cell: (r: (typeof valuation.data)[number]) => (r.reserved && signOf(r.reserved) > 0 ? qty(r.reserved) : '') },
                      { header: t('inv.available'), num: true, cell: (r: (typeof valuation.data)[number]) => <b>{qty(r.available ?? r.quantity)}</b> },
                    ]
                  : []),
                { header: t('inv.avgCost'), num: true, cell: (r) => <span className="money">{peso(r.avgCost)}</span> },
                { header: t('common.value'), num: true, cell: (r) => <span className="money font-semibold">{peso(r.value)}</span> },
              ]}
              stacked={{
                title: (r) => r.name,
                // On a phone the shelf is edited under the row too (the stacked list has no columns).
                meta: (r) =>
                  canPlace && branch ? (
                    <>
                      <Serial>{r.sku} · {qty(r.quantity)} × {peso(r.avgCost)}</Serial>
                      <div className="mt-2">
                        <LocationCell key={`${branch.id}-${r.variantId}-m`} idPrefix="loc-m" branchId={branch.id} variantId={r.variantId} name={r.name} location={placeOf.get(r.variantId) ?? null} />
                      </div>
                    </>
                  ) : (
                    <Serial>{r.sku}{placeOf.get(r.variantId) ? ` · ${placeOf.get(r.variantId)}` : ''} · {qty(r.quantity)} × {peso(r.avgCost)}</Serial>
                  ),
                figure: (r) => <span className="money font-semibold">{peso(r.value)}</span>,
              }}
              foot={{
                cells: ['', t('common.total'), '', '', ...(anyReserved ? ['', ''] : []), '', <span key="v" className="money">{peso(valuation.totalValue)}</span>],
                title: t('inv.stockValue'),
                figure: <span className="money">{peso(valuation.totalValue)}</span>,
              }}
            />
          ) : (
            <Empty>{valuation ? t('inv.noStock') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('inv.low')}</h2>
          {canReorder && branch && <ReorderForm branchId={branch.id} variants={variantOptions(products?.data, { stocked: true })} />}
        </div>
        <Note denom="gold" className="pr-2">
          {low && low.data.length > 0 ? (
            <RecordTable
              rows={low.data}
              rowKey={(r) => r.variantId}
              columns={[
                { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r) => r.name },
                { header: t('inv.onHand'), num: true, cell: (r) => <b>{qty(r.quantity)}</b> },
                { header: t('inv.reorderPoint'), num: true, cell: (r) => qty(r.reorderPoint) },
                { header: t('inv.onOrder'), num: true, cell: (r) => qty(r.onOrder) },
                { header: t('inv.suggested'), num: true, cell: (r) => <b>{qty(r.suggestedOrder)}</b> },
              ]}
              stacked={{
                title: (r) => r.name,
                meta: (r) => <Serial>{r.sku} · {t('inv.onHand')} {qty(r.quantity)} · {t('inv.reorderPoint')} {qty(r.reorderPoint)} · {t('inv.onOrder')} {qty(r.onOrder)}</Serial>,
                // The number to act on: what to order.
                figure: (r) => (
                  <span className="block">
                    <span className="block text-[0.75rem] text-muted">{t('inv.suggested')}</span>
                    <b className="serial text-[0.9375rem] text-ink">{qty(r.suggestedOrder)}</b>
                  </span>
                ),
              }}
            />
          ) : (
            <Empty>{low ? t('inv.noLow') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('inv.allReorder')}</h2>
        <Note denom="gold" className="pr-2">
          {points && points.data.length > 0 ? (
            <RecordTable
              rows={points.data}
              rowKey={(r) => r.variantId}
              columns={[
                { header: t('prod.sku'), cell: (r) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r) => r.name },
                { header: t('inv.onHand'), num: true, cell: (r) => qty(r.quantity) },
                { header: t('inv.reorderPoint'), num: true, cell: (r) => <b>{qty(r.reorderPoint)}</b> },
                { header: t('inv.reorderQty'), num: true, cell: (r) => (r.reorderQuantity ? qty(r.reorderQuantity) : '—') },
                ...(canReorder && branch ? [{ header: '', cell: (r: LowStockRow) => <RemoveReorderPoint branchId={branch.id} variantId={r.variantId} name={r.name} /> }] : []),
              ]}
              stacked={{
                title: (r) => r.name,
                meta: (r) => <Serial>{r.sku} · {t('inv.onHand')} {qty(r.quantity)} · {t('inv.reorderPoint')} {qty(r.reorderPoint)}</Serial>,
                figure: (r) => (canReorder && branch ? <RemoveReorderPoint branchId={branch.id} variantId={r.variantId} name={r.name} /> : null),
              }}
            />
          ) : (
            <Empty>{points ? t('inv.noReorder') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}

/** Every branch side by side (ADR-0021 §5): on hand per branch and the total, for the branches the person may read. */
async function AllBranches({ branches, branch }: { branches: Awaited<ReturnType<typeof inventoryBranch>>['branches']; branch: Awaited<ReturnType<typeof inventoryBranch>>['branch'] }) {
  const { t } = await getT();
  const stock = await apiOrNull<StockByBranch>('/stock/balances/by-branch');
  const cols = stock?.branches ?? [];
  type Row = StockByBranch['data'][number];
  return (
    <InventoryChrome tab="stock" branches={branches} branch={branch} all>
      <section>
        <h2 className="section-title mb-1">{t('shelf.allTitle')}</h2>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('shelf.allLede')}</p>
        {stock?.truncated && <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('shelf.allTruncated')}</p>}
        <Note denom="gold" className="pr-2">
          {stock && stock.data.length > 0 ? (
            <RecordTable
              rows={stock.data}
              rowKey={(r) => r.variantId}
              columns={[
                { header: t('prod.sku'), cell: (r: Row) => <Serial className="text-ink">{r.sku}</Serial> },
                { header: t('common.item'), cell: (r: Row) => r.name },
                ...cols.map((b) => ({
                  header: <span className="text-violet">{b.code}</span>,
                  num: true,
                  cell: (r: Row) => {
                    const at = r.branches[b.id];
                    if (!at) return <span className="text-muted">—</span>;
                    return (
                      <span className={signOf(at.quantity) < 0 ? 'text-red' : ''}>
                        {qty(at.quantity)}
                        {at.available !== at.quantity && <span className="block text-[0.75rem] text-muted">{t('shelf.availableN', { n: qty(at.available) })}</span>}
                      </span>
                    );
                  },
                })),
                { header: t('common.total'), num: true, cell: (r: Row) => <b>{qty(r.total)}</b> },
              ]}
              stacked={{
                title: (r) => r.name,
                meta: (r) => <Serial>{r.sku} · {cols.filter((b) => r.branches[b.id]).map((b) => `${b.code} ${qty(r.branches[b.id]!.quantity)}`).join(' · ')}</Serial>,
                figure: (r) => <b className="serial text-[0.9375rem] text-ink">{qty(r.total)}</b>,
              }}
            />
          ) : (
            <Empty>{stock ? t('inv.noStock') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </InventoryChrome>
  );
}
