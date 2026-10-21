import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { GuestLedgerReport } from '@/lib/api';
import { formatDate, peso, signOf } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.guest-ledger');

/**
 * The guest ledger (ADR-0023 §12) of the branch's legal entity, as it stands now: open folios and
 * what each guest owes beside *Guest ledger* in the books, and deposits held beside *Guest deposits*.
 * A difference is for the accountant.
 */
export default async function GuestLedgerPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const entity = scope.branch?.legalEntityId;
  const r = entity ? await loadReport<GuestLedgerReport>(`/reports/guest-ledger?legalEntityId=${entity}`) : null;
  const d = r?.data;
  const status = (s: string) => t(`lod.status.${s}` as MessageKey);
  return (
    <ReportsChrome tab="guestLedger" scope={scope} error={r?.error} extra={entity ? { entity } : {}}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.guestLedgerLede')}</p>
      {d && (
        <>
          <Note denom="ink" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
            <Figure label={t('rep.glOpenFolios')}>{peso(d.totals.folios)}</Figure>
            <Figure label={t('rep.glLedgerBooks')}>{peso(d.totals.guestLedgerGl)}</Figure>
            <Figure label={t('rep.glDeposits')}>{peso(d.totals.deposits)}</Figure>
            <Figure label={t('rep.glDepositsBooks')}>{peso(d.totals.guestDepositsGl)}</Figure>
          </Note>
          {signOf(d.totals.guestLedgerDifference) === 0 && signOf(d.totals.depositsDifference) === 0 ? (
            <Callout>{t('rep.glMatches')}</Callout>
          ) : (
            <Callout tone="warn">{t('rep.glDiffers', { ledger: peso(d.totals.guestLedgerDifference), deposits: peso(d.totals.depositsDifference) })}</Callout>
          )}
          <section aria-labelledby="open-folios">
            <h2 id="open-folios" className="section-title mb-3">{t('rep.glOpenFolios')}</h2>
            <Note className="pr-2">
              {d.folios.length ? (
                <RecordTable
                  rows={d.folios}
                  rowKey={(f) => f.folioId}
                  columns={[
                    { header: t('lod.room'), cell: (f) => <Serial className="text-ink">{f.roomNumber}</Serial> },
                    { header: t('lod.guest'), cell: (f) => <Link href={`/lodging/stays/${f.stayId}`} className="font-semibold underline">{f.guestName ?? '—'}</Link> },
                    { header: t('lod.dates'), cell: (f) => <Serial className="text-ink">{formatDate(f.arrivalDate, lang)} → {formatDate(f.departureDate, lang)}</Serial> },
                    { header: t('common.status'), cell: (f) => <span className="tag">{status(f.stayStatus)}</span> },
                    { header: t('lod.folioBalance'), num: true, cell: (f) => <b className="money">{peso(f.balance)}</b> },
                  ]}
                  stacked={{
                    title: (f) => <Link href={`/lodging/stays/${f.stayId}`} className="underline">{f.guestName ?? '—'}</Link>,
                    meta: (f) => <Serial>{t('lod.roomN', { n: f.roomNumber })} · {status(f.stayStatus)}</Serial>,
                    figure: (f) => <span className="money font-semibold">{peso(f.balance)}</span>,
                  }}
                  foot={{ cells: [t('common.total'), '', '', '', <span key="t" className="money">{peso(d.totals.folios)}</span>], title: t('common.total'), figure: <span className="money">{peso(d.totals.folios)}</span> }}
                />
              ) : (
                <Empty>{t('rep.glNoFolios')}</Empty>
              )}
            </Note>
          </section>
          <section aria-labelledby="deposits-held">
            <h2 id="deposits-held" className="section-title mb-3">{t('rep.glDeposits')}</h2>
            <Note className="pr-2">
              {d.deposits.length ? (
                <RecordTable
                  rows={d.deposits}
                  rowKey={(x) => x.stayId}
                  columns={[
                    { header: t('lod.room'), cell: (x) => <Serial className="text-ink">{x.roomNumber}</Serial> },
                    { header: t('lod.arrival'), cell: (x) => <Link href={`/lodging/stays/${x.stayId}`} className="underline">{formatDate(x.arrivalDate, lang)}</Link> },
                    { header: t('common.status'), cell: (x) => <span className="tag">{status(x.stayStatus)}</span> },
                    { header: t('lod.depositsHeld'), num: true, cell: (x) => <b className="money">{peso(x.held)}</b> },
                  ]}
                  stacked={{
                    title: (x) => <Link href={`/lodging/stays/${x.stayId}`} className="underline">{t('lod.roomN', { n: x.roomNumber })}</Link>,
                    meta: (x) => <Serial>{formatDate(x.arrivalDate, lang)} · {status(x.stayStatus)}</Serial>,
                    figure: (x) => <span className="money font-semibold">{peso(x.held)}</span>,
                  }}
                  foot={{ cells: [t('common.total'), '', '', <span key="t" className="money">{peso(d.totals.deposits)}</span>], title: t('common.total'), figure: <span className="money">{peso(d.totals.deposits)}</span> }}
                />
              ) : (
                <Empty>{t('rep.glNoDeposits')}</Empty>
              )}
            </Note>
          </section>
        </>
      )}
    </ReportsChrome>
  );
}
