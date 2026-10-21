import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { CommissionsReport } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.commissions');

/**
 * Commissions (ADR-0022 §5): per staff member, the rate kept on each line at the sale × the line's
 * ex-VAT sales (or a package session's value), less returns. A report for payroll, not a payable.
 */
export default async function CommissionsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<CommissionsReport>(`/reports/commissions?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const m = (v: string) => <span className="money">{peso(v)}</span>;
  return (
    <ReportsChrome tab="commissions" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.commissionsLede')}</p>
      {d && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label={t('rep.commission')}>{peso(d.totals.commission)}</Figure>
          <Figure label={t('rep.commissionBase')}>{peso(d.totals.netBase)}</Figure>
          <Figure label={t('csv.returns')}>{peso(d.totals.returns)}</Figure>
          <Figure label={t('rep.lines')}>{d.totals.lines}</Figure>
        </div>
      )}
      <Note denom="green" className="pr-2">
        {d && d.staff.length > 0 ? (
          <RecordTable
            rows={d.staff}
            rowKey={(x) => x.staffId}
            columns={[
              { header: t('rep.staffMember'), cell: (x) => <span className="font-semibold">{x.name}</span> },
              { header: t('rep.lines'), num: true, cell: (x) => x.lines },
              { header: t('csv.sales'), num: true, cell: (x) => m(x.sales) },
              { header: t('csv.returns'), num: true, cell: (x) => m(x.returns) },
              { header: t('rep.commissionBase'), num: true, cell: (x) => m(x.netBase) },
              { header: t('rep.commission'), num: true, cell: (x) => <b className="money">{peso(x.commission)}</b> },
            ]}
            stacked={{
              title: (x) => x.name,
              meta: (x) => <Serial>{t('rep.lines')} {x.lines} · {t('rep.commissionBase')} {peso(x.netBase)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.commission)}</span>,
            }}
            foot={{
              cells: [t('common.total'), d.totals.lines, <span key="s">{m(d.totals.sales)}</span>, <span key="r">{m(d.totals.returns)}</span>, <span key="b">{m(d.totals.netBase)}</span>, <span key="c" className="money">{peso(d.totals.commission)}</span>],
              title: t('rep.commission'),
              figure: <span className="money">{peso(d.totals.commission)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noCommissions')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
