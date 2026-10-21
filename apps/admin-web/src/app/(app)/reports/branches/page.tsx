import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByBranch } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.branches');

/** Every branch the person may report on, side by side, each in its own local days, and the total. */
export default async function ByBranchPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ByBranch>(`/reports/by-branch?from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const totals = r?.data?.totals;

  return (
    <ReportsChrome tab="branches" scope={scope} error={r?.error}>
      <Note className="pr-2">
        {rows.length > 0 && totals ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.branchId}
            columns={[
              { header: t('common.branch'), cell: (x) => <span><Serial className="text-ink">{x.code}</Serial> {x.name}</span> },
              { header: t('csv.salesCount'), num: true, cell: (x) => x.salesCount },
              { header: t('csv.sales'), num: true, cell: (x) => <span className="money">{peso(x.sales)}</span> },
              { header: t('csv.returns'), num: true, cell: (x) => <span className="money">{peso(x.returns)}</span> },
              { header: t('rep.netSales'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.netSales)}</span> },
              { header: t('csv.vatAmount'), num: true, cell: (x) => <span className="money">{peso(x.vatAmount)}</span> },
              { header: t('csv.discount'), num: true, cell: (x) => <span className="money">{peso(x.discount)}</span> },
            ]}
            stacked={{
              title: (x) => `${x.code} ${x.name}`,
              meta: (x) => <Serial>{t('csv.salesCount')} {x.salesCount} · {t('csv.returns')} {peso(x.returns)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.netSales)}</span>,
            }}
            foot={{
              cells: [
                t('rep.allBranches'),
                totals.salesCount,
                ...(['sales', 'returns', 'netSales', 'vatAmount', 'discount'] as const).map((k) => <span key={k} className="money">{peso(totals[k])}</span>),
              ],
              title: t('rep.allBranches'),
              figure: <span className="money">{peso(totals.netSales)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
      <p className="text-[0.8125rem] text-muted">{t('rep.branchesNote')}</p>
    </ReportsChrome>
  );
}
