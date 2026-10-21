import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { DeliveriesReport } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.deliveries');

/** Pickups and deliveries per day (ADR-0024 §13): done, failed and cancelled, and delivery fees on claimed jobs. */
export default async function DeliveriesReportPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<DeliveriesReport>(`/reports/deliveries?${new URLSearchParams({ branchId: scope.branch.id, from: scope.from, to: scope.to })}`) : null;
  const d = r?.data;
  return (
    <ReportsChrome tab="deliveries" scope={scope} error={r?.error}>
      {d && (
        <>
          <Note denom="blue" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
            <Figure label={t('rep.trips')}>{d.totals.trips}</Figure>
            <Figure label={t('rep.tripsDone')}>{d.totals.done}</Figure>
            <Figure label={t('rep.tripsFailed')} tone={d.totals.failed > 0 ? 'red' : undefined}>{d.totals.failed}</Figure>
            <Figure label={t('rep.deliveryFees')}>{peso(d.totals.deliveryFees)}</Figure>
          </Note>
          <Note className="pr-2">
            {d.days.length ? (
              <RecordTable
                rows={d.days}
                rowKey={(x) => `${x.day}:${x.kind}`}
                columns={[
                  { header: t('common.date'), cell: (x) => <Serial className="text-ink">{formatDate(x.day, lang)}</Serial> },
                  { header: t('lau.tripKind'), cell: (x) => <span className="tag">{t(`lau.trip.${x.kind}` as MessageKey)}</span> },
                  { header: t('rep.trips'), num: true, cell: (x) => x.trips },
                  { header: t('rep.tripsDone'), num: true, cell: (x) => x.done },
                  { header: t('rep.tripsFailed'), num: true, cell: (x) => x.failed },
                  { header: t('rep.tripsCancelled'), num: true, cell: (x) => x.cancelled },
                  { header: t('rep.tripsScheduled'), num: true, cell: (x) => x.scheduled },
                ]}
                stacked={{
                  title: (x) => <>{formatDate(x.day, lang)} · {t(`lau.trip.${x.kind}` as MessageKey)}</>,
                  meta: (x) => <Serial>{t('rep.tripsDone')} {x.done} · {t('rep.tripsFailed')} {x.failed}</Serial>,
                  figure: (x) => <span className="font-semibold">{x.trips}</span>,
                }}
              />
            ) : (
              <Empty>{t('rep.noTrips')}</Empty>
            )}
          </Note>
          <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('rep.deliveriesHint', { n: d.totals.deliveredJobsWithFee })}</p>
        </>
      )}
    </ReportsChrome>
  );
}
