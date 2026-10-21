import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByCashier } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.cashiers');

/** Who rang up what, and the returns each person processed. */
export default async function ByCashierPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ByCashier>(`/reports/by-cashier?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];

  return (
    <ReportsChrome tab="cashiers" scope={scope} error={r?.error}>
      <Note className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.userId}
            columns={[
              { header: t('rep.cashier'), cell: (x) => <b>{x.displayName ?? '—'}</b> },
              { header: t('csv.salesCount'), num: true, cell: (x) => x.salesCount },
              { header: t('rep.sales'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.sales)}</span> },
              { header: t('csv.returnsCount'), num: true, cell: (x) => x.returnsProcessed },
              { header: t('rep.returns'), num: true, cell: (x) => <span className="money">{peso(x.returns)}</span> },
            ]}
            stacked={{
              title: (x) => x.displayName ?? '—',
              meta: (x) => <Serial>{t('csv.salesCount')} {x.salesCount} · {t('rep.returns')} {peso(x.returns)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.sales)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
