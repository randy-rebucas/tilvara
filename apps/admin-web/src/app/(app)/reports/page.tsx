import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ItemPerformance, ReportFigures } from '@/lib/api';
import { peso, qty } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from './chrome';

export const metadata = { title: 'Item performance' };

/** A free choice ("No onions") has a count but no money of its own. */
type Money = { netSales: string; revenueExVat: string; cogs: string; grossProfit: string; marginPct: string | null };
type Row = { key: string; kind: 'item' | 'choice' | 'free' | 'subtotal'; name: string; sku?: string; quantity?: string; orders?: number } & Partial<Money>;

/** What each menu item earned, with its priced choices under it (ADR-0014 §10) and its free choices counted (session 25). */
export default async function ItemPerformancePage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ItemPerformance>(`/reports/item-performance?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const figures = (f: ReportFigures) => ({ quantity: f.netQuantity, netSales: f.netSales, revenueExVat: f.revenueExVat, cogs: f.cogs, grossProfit: f.grossProfit, marginPct: f.marginPct });
  const rows: Row[] = (r?.data?.data ?? []).flatMap((i) => [
    { key: i.variantId, kind: 'item' as const, name: i.name, sku: i.sku, ...figures(i) },
    ...i.modifiers.map((m) => ({ key: `${i.variantId}:${m.variantId}`, kind: 'choice' as const, name: m.name, sku: m.sku, ...figures(m) })),
    ...i.freeChoices.map((c) => ({ key: `${i.variantId}:free:${c.modifierOptionId}`, kind: 'free' as const, name: c.name, quantity: c.quantity, orders: c.orders })),
    ...(i.modifiers.length ? [{ key: `${i.variantId}:all`, kind: 'subtotal' as const, name: t('rep.withChoices', { name: i.name }), ...i.withModifiers }] : []),
  ]);
  const pct = (p: string | null | undefined) => (p === undefined ? '' : p === null ? '—' : `${p}%`);
  const money = (v: string | undefined) => (v === undefined ? '' : peso(v));
  const name = (row: Row) =>
    row.kind === 'choice' ? <span className="pl-4 text-muted">+ {row.name}</span>
    : row.kind === 'free' ? <span className="pl-4 text-muted">· {row.name} <span className="text-[0.8125rem]">({t('rep.freeChoiceOrders', { n: row.orders ?? 0 })})</span></span>
    : row.kind === 'subtotal' ? <span className="pl-4 italic">{row.name}</span> : <b>{row.name}</b>;

  return (
    <ReportsChrome tab="items" scope={scope} error={r?.error}>
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.itemsLede')}</p>
        <Note denom="blue" className="pr-2">
          {rows.length > 0 && r?.data ? (
            <RecordTable
              rows={rows}
              rowKey={(x) => x.key}
              columns={[
                { header: t('common.item'), cell: (x) => <>{name(x)} {x.sku && <Serial>{x.sku}</Serial>}</> },
                { header: t('common.quantity'), num: true, cell: (x) => (x.quantity ? qty(x.quantity) : '') },
                { header: t('rep.netSales'), num: true, cell: (x) => <span className="money">{money(x.netSales)}</span> },
                { header: t('rep.revenueExVat'), num: true, cell: (x) => <span className="money">{money(x.revenueExVat)}</span> },
                { header: t('rep.cogs'), num: true, cell: (x) => <span className="money">{money(x.cogs)}</span> },
                { header: t('rep.grossProfit'), num: true, cell: (x) => <span className={`money ${x.kind !== 'choice' ? 'font-semibold' : ''}`}>{money(x.grossProfit)}</span> },
                { header: t('rep.margin'), num: true, cell: (x) => pct(x.marginPct) },
              ]}
              stacked={{
                title: (x) => name(x),
                meta: (x) => <Serial>{x.quantity ? qty(x.quantity) : ''}{x.netSales !== undefined && `${x.quantity ? ' · ' : ''}${t('rep.netSales')} ${peso(x.netSales)} · ${t('rep.cogs')} ${peso(x.cogs ?? '0')}`}</Serial>,
                figure: (x) => (
                  <span className="block">
                    <span className="money block font-semibold">{money(x.grossProfit)}</span>
                    <span className="text-[0.75rem] text-muted">{pct(x.marginPct)}</span>
                  </span>
                ),
              }}
              foot={{
                cells: [t('common.total'), '', <span key="s" className="money">{peso(r.data.totals.netSales)}</span>, <span key="r" className="money">{peso(r.data.totals.revenueExVat)}</span>, <span key="c" className="money">{peso(r.data.totals.cogs)}</span>, <span key="g" className="money">{peso(r.data.totals.grossProfit)}</span>, pct(r.data.totals.marginPct)],
                title: t('rep.grossProfit'),
                figure: <span className="money">{peso(r.data.totals.grossProfit)}</span>,
              }}
            />
          ) : (
            <Empty>{t('rep.noSales')}</Empty>
          )}
        </Note>
      </section>
    </ReportsChrome>
  );
}
