import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByCategory } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Sales by category' };

/** Net sales and gross profit per top-level category, then each category on its own (same figures as By product). */
export default async function ByCategoryPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ByCategory>(`/reports/by-category?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const top = r?.data?.top ?? [];
  const rows = r?.data?.data ?? [];
  const none = t('rep.noCategory');

  return (
    <ReportsChrome tab="category" scope={scope} error={r?.error}>
      {top.length > 0 ? (
        <>
          <h2 className="section-title">{t('rep.topCategories')}</h2>
          <Note className="pr-2">
            <RecordTable
              rows={top}
              rowKey={(x) => x.categoryId ?? 'none'}
              columns={[
                { header: t('rep.category'), cell: (x) => <b>{x.name ?? none}</b> },
                { header: t('rep.netSales'), num: true, cell: (x) => <span className="money">{peso(x.netSales)}</span> },
                { header: t('rep.revenueExVat'), num: true, cell: (x) => <span className="money">{peso(x.revenueExVat)}</span> },
                { header: t('rep.cogs'), num: true, cell: (x) => <span className="money">{peso(x.cogs)}</span> },
                { header: t('rep.grossProfit'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.grossProfit)}</span> },
              ]}
              stacked={{
                title: (x) => x.name ?? none,
                meta: (x) => <Serial>{t('rep.revenueExVat')} {peso(x.revenueExVat)} · {t('rep.cogs')} {peso(x.cogs)}</Serial>,
                figure: (x) => <span className="money font-semibold">{peso(x.netSales)}</span>,
              }}
              foot={{
                cells: [t('common.total'), ...(['netSales', 'revenueExVat', 'cogs', 'grossProfit'] as const).map((k) => <span key={k} className="money">{peso(r!.data!.totals[k])}</span>)],
                title: t('rep.netSales'),
                figure: <span className="money">{peso(r!.data!.totals.netSales)}</span>,
              }}
            />
          </Note>
          <h2 className="section-title">{t('rep.eachCategory')}</h2>
          <Note className="pr-2">
            <RecordTable
              rows={rows}
              rowKey={(x) => x.categoryId ?? 'none'}
              columns={[
                { header: t('rep.category'), cell: (x) => (x.path.length ? <span>{x.path.slice(0, -1).map((p) => <span key={p} className="text-muted">{p} › </span>)}<b>{x.name}</b></span> : <b>{none}</b>) },
                { header: t('csv.netQty'), num: true, cell: (x) => x.netQuantity },
                { header: t('rep.netSales'), num: true, cell: (x) => <span className="money">{peso(x.netSales)}</span> },
                { header: t('rep.cogs'), num: true, cell: (x) => <span className="money">{peso(x.cogs)}</span> },
                { header: t('rep.grossProfit'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.grossProfit)}</span> },
              ]}
              stacked={{
                title: (x) => (x.path.length ? x.path.join(' › ') : none),
                meta: (x) => <Serial>{t('csv.netQty')} {x.netQuantity} · {t('rep.grossProfit')} {peso(x.grossProfit)}</Serial>,
                figure: (x) => <span className="money font-semibold">{peso(x.netSales)}</span>,
              }}
            />
          </Note>
          <p className="text-[0.8125rem] text-muted">{t('rep.estimatedMargin')}</p>
        </>
      ) : (
        <Note><Empty>{t('rep.noData')}</Empty></Note>
      )}
    </ReportsChrome>
  );
}
