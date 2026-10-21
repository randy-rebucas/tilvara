import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { JobDepositsReport } from '@/lib/api';
import { formatDateTime, peso, signOf } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.job-order-deposits');

/**
 * Down payments held (ADR-0024 §5, §13) on open jobs of the branch's legal entity beside *Customer
 * down payments* in the books, the laundry unclaimed now with its value, and what was kept. A
 * difference is for the accountant.
 */
export default async function JobDepositsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const entity = scope.branch?.legalEntityId;
  const r = entity ? await loadReport<JobDepositsReport>(`/reports/job-order-deposits?legalEntityId=${entity}`) : null;
  const d = r?.data;
  const status = (s: string) => t(`lau.status.${s}` as MessageKey);
  return (
    <ReportsChrome tab="jobDeposits" scope={scope} error={r?.error} extra={entity ? { entity } : {}}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.jobDepositsLede')}</p>
      {d && (
        <>
          <Note denom="ink" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
            <Figure label={t('rep.dpHeld')}>{peso(d.totals.held)}</Figure>
            <Figure label={t('rep.dpBooks')}>{peso(d.totals.customerDownPaymentsGl)}</Figure>
            <Figure label={t('rep.unclaimedValue')}>{peso(d.totals.unclaimedValue)}</Figure>
            <Figure label={t('rep.dpKept')}>{peso(d.forfeited.amount)}</Figure>
          </Note>
          {signOf(d.totals.difference) === 0 ? <Callout>{t('rep.dpMatches')}</Callout> : <Callout tone="warn">{t('rep.dpDiffers', { amount: peso(d.totals.difference) })}</Callout>}
          <section aria-labelledby="held">
            <h2 id="held" className="section-title mb-3">{t('rep.dpHeld')}</h2>
            <Note className="pr-2">
              {d.held.length ? (
                <RecordTable
                  rows={d.held}
                  rowKey={(x) => x.jobOrderId}
                  columns={[
                    { header: t('lau.job'), cell: (x) => <Link href={`/laundry/jobs/${x.jobOrderId}`} className="serial font-semibold underline">{x.reference}</Link> },
                    { header: t('lau.customer'), cell: (x) => x.customer ?? '—' },
                    { header: t('common.status'), cell: (x) => <span className="tag">{status(x.status)}</span> },
                    { header: t('lau.total'), num: true, cell: (x) => <span className="money">{peso(x.amountDue)}</span> },
                    { header: t('lau.held'), num: true, cell: (x) => <b className="money">{peso(x.held)}</b> },
                  ]}
                  stacked={{
                    title: (x) => <Link href={`/laundry/jobs/${x.jobOrderId}`} className="underline">{x.reference} · {x.customer ?? '—'}</Link>,
                    meta: (x) => <Serial>{status(x.status)} · {peso(x.amountDue)}</Serial>,
                    figure: (x) => <span className="money font-semibold">{peso(x.held)}</span>,
                  }}
                  foot={{ cells: [t('common.total'), '', '', '', <span key="t" className="money">{peso(d.totals.held)}</span>], title: t('common.total'), figure: <span className="money">{peso(d.totals.held)}</span> }}
                />
              ) : (
                <Empty>{t('rep.dpNone')}</Empty>
              )}
            </Note>
          </section>
          <section aria-labelledby="unclaimed">
            <h2 id="unclaimed" className="section-title mb-3">{t('rep.unclaimedNow')}</h2>
            <Note className="pr-2">
              {d.unclaimed.length ? (
                <RecordTable
                  rows={d.unclaimed}
                  rowKey={(x) => x.jobOrderId}
                  columns={[
                    { header: t('lau.job'), cell: (x) => <Link href={`/laundry/jobs/${x.jobOrderId}`} className="serial font-semibold underline">{x.reference}</Link> },
                    { header: t('lau.customer'), cell: (x) => x.customer ?? '—' },
                    { header: t('rep.readySince'), cell: (x) => <Serial className="text-ink">{formatDateTime(x.readyAt, lang)} · {t('rep.daysN', { n: x.daysWaiting })}</Serial> },
                    { header: t('rep.finalNotice'), cell: (x) => <span className="tag">{x.finalNoticeSent ? t('rep.finalSent') : t('rep.finalNotSent')}</span> },
                    { header: t('lau.total'), num: true, cell: (x) => <span className="money">{peso(x.amountDue)}</span> },
                    { header: t('lau.held'), num: true, cell: (x) => <span className="money">{peso(x.held)}</span> },
                  ]}
                  stacked={{
                    title: (x) => <Link href={`/laundry/jobs/${x.jobOrderId}`} className="underline">{x.reference} · {x.customer ?? '—'}</Link>,
                    meta: (x) => <Serial>{t('rep.daysN', { n: x.daysWaiting })} · {x.finalNoticeSent ? t('rep.finalSent') : t('rep.finalNotSent')}</Serial>,
                    figure: (x) => <span className="money font-semibold">{peso(x.amountDue)}</span>,
                  }}
                />
              ) : (
                <Empty>{t('rep.noUnclaimed')}</Empty>
              )}
            </Note>
          </section>
        </>
      )}
    </ReportsChrome>
  );
}
