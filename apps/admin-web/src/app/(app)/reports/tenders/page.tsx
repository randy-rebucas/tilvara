import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByTender } from '@/lib/api';
import { peso, sumDecimal } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.tenders');

/** Money taken by method (cash, card, QR), refunds, and the net to reconcile against the drawer and the bank. */
export default async function ByTenderPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ByTender>(`/reports/by-tender?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];

  return (
    <ReportsChrome tab="tenders" scope={scope} error={r?.error}>
      <Note className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.method}
            columns={[
              { header: t('csv.method'), cell: (x) => <b>{x.method}</b> },
              { header: t('rep.count'), num: true, cell: (x) => x.tenders },
              { header: t('rep.collected'), num: true, cell: (x) => <span className="money">{peso(x.collected)}</span> },
              { header: t('rep.refunded'), num: true, cell: (x) => <span className="money">{peso(x.refunded)}</span> },
              { header: t('rep.net'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.net)}</span> },
            ]}
            stacked={{
              title: (x) => x.method,
              meta: (x) => <Serial>{t('rep.collected')} {peso(x.collected)} · {t('rep.refunded')} {peso(x.refunded)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.net)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', ...(['collected', 'refunded', 'net'] as const).map((k) => <span key={k} className="money">{peso(sumDecimal(rows.map((x) => x[k])))}</span>)],
              title: t('rep.net'),
              figure: <span className="money">{peso(sumDecimal(rows.map((x) => x.net)))}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
