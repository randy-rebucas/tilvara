import { redirect } from 'next/navigation';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { allProducts, api, apiOrNull, type LowStockRow, type Me, type Valuation } from '@/lib/api';
import { peso, qty, signOf } from '@/lib/format';
import { variantOptions } from '@/lib/options';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from './chrome';
import { AdjustStockForm, RemoveReorderPoint, ReorderForm } from './forms';

export const metadata = { title: 'Inventory' };

export default async function StockPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t } = await getT();
  const sp = await searchParams;
  // Someone who may only count stock (inventory.count) lands on the counts they can do.
  const own = (await api<Me>('/me')).activeTenant?.permissions ?? [];
  if (!own.includes('inventory.read') && own.includes('inventory.count')) redirect(`/inventory/counts${sp.branch ? `?branch=${sp.branch}` : ''}`);
  const { branches, branch } = await inventoryBranch(sp.branch);
  const [me, valuation, low, points, products] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<Valuation>(`/reports/inventory-valuation?branchId=${branch.id}`) : null,
    branch ? apiOrNull<{ data: LowStockRow[] }>(`/stock/low?branchId=${branch.id}`) : null,
    branch ? apiOrNull<{ data: LowStockRow[] }>(`/stock/reorder-points?branchId=${branch.id}`) : null,
    allProducts(),
  ]);
  const perms = me.activeTenant?.permissions ?? [];
  const canReorder = perms.includes('purchasing.manage') || perms.includes('inventory.adjust');
  const canAdjust = perms.includes('inventory.adjust');
  // A Reserved column only when something is set aside (session 20).
  const anyReserved = valuation?.data.some((r) => r.reserved && signOf(r.reserved) > 0) ?? false;

  return (
    <InventoryChrome tab="stock" branches={branches} branch={branch}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('inv.tab.stock')}</h2>
          {canAdjust && branch && <AdjustStockForm branchId={branch.id} variants={variantOptions(products?.data, { stocked: true })} />}
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
                meta: (r) => <Serial>{r.sku} · {qty(r.quantity)} × {peso(r.avgCost)}</Serial>,
                figure: (r) => <span className="money font-semibold">{peso(r.value)}</span>,
              }}
              foot={{
                cells: ['', t('common.total'), '', ...(anyReserved ? ['', ''] : []), '', <span key="v" className="money">{peso(valuation.totalValue)}</span>],
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
