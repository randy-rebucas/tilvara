import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { TipsReport } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.tips');

/**
 * Tips (session 25): owed to staff, not sales. Taken with sales (cash or card/QR), given back by voids,
 * paid out from the drawers, per local day and by cashier, checked against Tips payable in the books.
 */
export default async function TipsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<TipsReport>(`/reports/tips?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const m = (v: string) => <span className="money">{peso(v)}</span>;

  return (
    <ReportsChrome tab="tips" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.tipsLede')}</p>
      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label={t('rep.tipsOwed')}>{peso(d.totals.owed)}</Figure>
            <Figure label={t('rep.tipsTaken')}>{peso(d.totals.taken)}</Figure>
            <Figure label={t('rep.tipsRefunded')}>{peso(d.totals.refunded)}</Figure>
            <Figure label={t('rep.tipsPaidOut')}>{peso(d.totals.paidOut)}</Figure>
          </div>
          {d.ledger === d.totals.owed ? (
            <p className="text-[0.875rem] text-muted">{t('rep.tipsLedgerOk')}</p>
          ) : (
            <Callout tone="error">{t('rep.tipsLedgerOff', { v: peso(d.ledger) })}</Callout>
          )}
        </>
      )}
      <Note denom="ink" className="pr-2">
        {d && d.days.length > 0 ? (
          <RecordTable
            rows={d.days}
            rowKey={(x) => x.day}
            columns={[
              { header: t('common.date'), cell: (x) => formatDate(x.day, lang) },
              { header: t('rep.tipsCount'), num: true, cell: (x) => x.tips },
              { header: t('rep.tipsCash'), num: true, cell: (x) => m(x.cash) },
              { header: t('rep.tipsElectronic'), num: true, cell: (x) => m(x.electronic) },
              { header: t('rep.tipsRefunded'), num: true, cell: (x) => m(x.refunded) },
              { header: t('rep.tipsPaidOut'), num: true, cell: (x) => m(x.paidOut) },
              { header: t('rep.tipsOwed'), num: true, cell: (x) => <b className="money">{peso(x.owed)}</b> },
            ]}
            stacked={{
              title: (x) => formatDate(x.day, lang),
              meta: (x) => <Serial>{t('rep.tipsTaken')} {peso(x.taken)} · {t('rep.tipsRefunded')} {peso(x.refunded)} · {t('rep.tipsPaidOut')} {peso(x.paidOut)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.owed)}</span>,
            }}
            foot={{
              cells: [t('common.total'), d.totals.tips, <span key="c">{m(d.totals.cash)}</span>, <span key="e">{m(d.totals.electronic)}</span>, <span key="r">{m(d.totals.refunded)}</span>, <span key="p">{m(d.totals.paidOut)}</span>, <span key="o" className="money">{peso(d.totals.owed)}</span>],
              title: t('rep.tipsOwed'),
              figure: <span className="money">{peso(d.totals.owed)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noTips')}</Empty>
        )}
      </Note>
      {d && d.byCashier.length > 0 && (
        <section>
          <h2 className="section-title mb-3">{t('rep.tipsByCashier')}</h2>
          <Note denom="none" className="pr-2">
            <RecordTable
              rows={d.byCashier}
              rowKey={(c) => c.userId}
              columns={[
                { header: t('csv.cashier'), cell: (c) => c.name ?? '—' },
                { header: t('rep.tipsCount'), num: true, cell: (c) => c.tips },
                { header: t('rep.tipsTaken'), num: true, cell: (c) => <b className="money">{peso(c.amount)}</b> },
              ]}
              stacked={{
                title: (c) => c.name ?? '—',
                meta: (c) => <Serial>{t('rep.tipsCount')} {c.tips}</Serial>,
                figure: (c) => <span className="money font-semibold">{peso(c.amount)}</span>,
              }}
            />
          </Note>
        </section>
      )}
    </ReportsChrome>
  );
}
