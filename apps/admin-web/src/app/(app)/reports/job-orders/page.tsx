import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { JobOrdersReport } from '@/lib/api';
import { formatDate, peso, qty } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.job-orders');

/**
 * Job orders (ADR-0024 §13): per day, jobs taken in, made ready, claimed, cancelled and disposed of;
 * the average turnaround and the share ready by the promised time; kilos and loads by service. Claim
 * sales are ordinary sales in the sales reports.
 */
export default async function JobOrdersReportPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<JobOrdersReport>(`/reports/job-orders?${new URLSearchParams({ branchId: scope.branch.id, from: scope.from, to: scope.to })}`) : null;
  const d = r?.data;
  const hours = (h: string | null) => (h === null ? '—' : t('rep.hoursN', { n: h }));
  const pct = (p: string | null) => (p === null ? '—' : `${p}%`);
  return (
    <ReportsChrome tab="jobOrders" scope={scope} error={r?.error}>
      {d && (
        <>
          <Note denom="blue" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-3 lg:grid-cols-6">
            <Figure label={t('rep.jobsReceived')}>{d.totals.received}</Figure>
            <Figure label={t('rep.jobsClaimed')}>{d.totals.claimed}</Figure>
            <Figure label={t('rep.turnaround')}>{hours(d.totals.averageTurnaroundHours)}</Figure>
            <Figure label={t('rep.onTime')}>{pct(d.totals.onTimePercent)}</Figure>
            <Figure label={t('rep.kilos')}>{qty(d.totals.kilos)}</Figure>
            <Figure label={t('rep.overdueNow')} tone={d.totals.overdueNow > 0 ? 'red' : undefined}>{d.totals.overdueNow}</Figure>
          </Note>
          <section aria-labelledby="by-day">
            <h2 id="by-day" className="section-title mb-3">{t('rep.byDay')}</h2>
            <Note className="pr-2">
              <RecordTable
                rows={d.days}
                rowKey={(x) => x.day}
                columns={[
                  { header: t('common.date'), cell: (x) => <Serial className="text-ink">{formatDate(x.day, lang)}</Serial> },
                  { header: t('rep.jobsReceived'), num: true, cell: (x) => x.received },
                  { header: t('rep.jobsReady'), num: true, cell: (x) => x.ready },
                  { header: t('rep.jobsClaimed'), num: true, cell: (x) => x.claimed },
                  { header: t('rep.jobsCancelled'), num: true, cell: (x) => x.cancelled },
                  { header: t('rep.jobsDisposed'), num: true, cell: (x) => x.disposed },
                  { header: t('rep.turnaround'), num: true, cell: (x) => hours(x.averageTurnaroundHours) },
                  { header: t('rep.onTime'), num: true, cell: (x) => pct(x.onTimePercent) },
                ]}
                stacked={{
                  title: (x) => formatDate(x.day, lang),
                  meta: (x) => <Serial>{t('rep.jobsReceived')} {x.received} · {t('rep.jobsReady')} {x.ready} · {t('rep.turnaround')} {hours(x.averageTurnaroundHours)}</Serial>,
                  figure: (x) => <span className="font-semibold">{x.claimed}</span>,
                }}
                foot={{
                  cells: [t('common.total'), d.totals.received, d.totals.ready, d.totals.claimed, d.totals.cancelled, d.totals.disposed, hours(d.totals.averageTurnaroundHours), pct(d.totals.onTimePercent)],
                  title: t('common.total'),
                  figure: <span>{d.totals.claimed}</span>,
                }}
              />
            </Note>
          </section>
          <section aria-labelledby="by-service">
            <h2 id="by-service" className="section-title mb-3">{t('rep.byService')}</h2>
            <Note className="pr-2">
              {d.services.length ? (
                <RecordTable
                  rows={d.services}
                  rowKey={(x) => x.variantId}
                  columns={[
                    { header: t('lau.service'), cell: (x) => <span className="font-semibold">{x.name}</span> },
                    { header: t('lau.unitCol'), cell: (x) => t(`lau.unit.${x.unit}` as MessageKey) },
                    { header: t('rep.measured'), num: true, cell: (x) => qty(x.measured) },
                    { header: t('rep.billed'), num: true, cell: (x) => qty(x.billed) },
                    { header: t('rep.jobs'), num: true, cell: (x) => x.jobs },
                    { header: t('rep.amount'), num: true, cell: (x) => <span className="money">{peso(x.amount)}</span> },
                  ]}
                  stacked={{
                    title: (x) => x.name,
                    meta: (x) => <Serial>{qty(x.billed)} {t(`lau.unit.${x.unit}` as MessageKey)} · {t('rep.jobsN', { n: x.jobs })}</Serial>,
                    figure: (x) => <span className="money font-semibold">{peso(x.amount)}</span>,
                  }}
                />
              ) : (
                <Empty>{t('rep.noJobs')}</Empty>
              )}
            </Note>
            <p className="mt-2 max-w-[68ch] text-[0.8125rem] text-muted">{t('rep.jobOrdersHint')}</p>
          </section>
        </>
      )}
    </ReportsChrome>
  );
}
