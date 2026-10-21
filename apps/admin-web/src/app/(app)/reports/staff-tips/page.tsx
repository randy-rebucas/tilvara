import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { TipsByStaffReport } from '@/lib/api';
import { peso, signOf } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Tips by staff' };

/**
 * Tips per staff member (ADR-0022 §7): their shares of the tips on the period's sales, less shares
 * given back by a void. Tips on sales with no staff are listed as unassigned. Paying out stays one amount.
 */
export default async function StaffTipsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<TipsByStaffReport>(`/reports/tips-by-staff?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const name = (x: TipsByStaffReport['staff'][number]) => x.name ?? t('rep.unassigned');
  return (
    <ReportsChrome tab="staffTips" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.staffTipsLede')}</p>
      {d && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label={t('rep.tipsTaken')}>{peso(d.total)}</Figure>
        </div>
      )}
      <Note denom="green" className="pr-2">
        {d && d.staff.length > 0 ? (
          <RecordTable
            rows={d.staff}
            rowKey={(x) => x.staffId ?? 'unassigned'}
            columns={[
              { header: t('rep.staffMember'), cell: (x) => <span className={x.staffId ? 'font-semibold' : 'text-muted'}>{name(x)}</span> },
              { header: t('rep.tipsCount'), num: true, cell: (x) => x.tips },
              { header: t('rep.tipsVoided'), num: true, cell: (x) => (signOf(x.voided) > 0 ? <span className="money">{peso(x.voided)}</span> : '—') },
              { header: t('rep.tipsTaken'), num: true, cell: (x) => <b className="money">{peso(x.amount)}</b> },
            ]}
            stacked={{
              title: (x) => name(x),
              meta: (x) => <Serial>{t('rep.tipsCount')} {x.tips}{signOf(x.voided) > 0 && ` · ${t('rep.tipsVoided')} ${peso(x.voided)}`}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.amount)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', <span key="t" className="money">{peso(d.total)}</span>],
              title: t('common.total'),
              figure: <span className="money">{peso(d.total)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noTips')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
