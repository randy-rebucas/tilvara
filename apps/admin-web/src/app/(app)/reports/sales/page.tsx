import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { SaleBuckets, SalesSummary } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.sales');

/** Per local day: sales, returns and voids, and the net, in the receipt's buckets. */
export default async function SalesSummaryPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<SalesSummary>(`/reports/sales-summary?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const s = r?.data;
  const days = s?.days.filter((d) => d.salesCount + d.returnsCount + d.voidsCount > 0) ?? [];
  const cols = (b: SaleBuckets) => [b.gross, b.discount, b.statutoryDiscount, b.vatAmount, b.amountDue];

  return (
    <ReportsChrome tab="sales" scope={scope} error={r?.error}>
      {s && (
        <Note className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
          <Figure label={t('rep.sales')}>{peso(s.totals.sales.amountDue)}</Figure>
          <Figure label={t('rep.returns')}>{peso(s.totals.returns.amountDue)}</Figure>
          <Figure label={t('rep.net')}>{peso(s.totals.net.amountDue)}</Figure>
          <Figure label={t('rep.vatAmount')}>{peso(s.totals.net.vatAmount)}</Figure>
        </Note>
      )}
      <Note className="pr-2">
        {days.length > 0 && s ? (
          <RecordTable
            rows={days}
            rowKey={(d) => d.day}
            columns={[
              { header: t('common.date'), cell: (d) => <b>{formatDate(d.day, lang)}</b> },
              { header: t('rep.count'), num: true, cell: (d) => <Serial className="text-ink">{d.salesCount} / {d.returnsCount + d.voidsCount}</Serial> },
              { header: t('csv.gross'), num: true, cell: (d) => <span className="money">{peso(d.net.gross)}</span> },
              { header: t('rep.discount'), num: true, cell: (d) => <span className="money">{peso(d.net.discount)}</span> },
              { header: t('rep.statutoryDiscount'), num: true, cell: (d) => <span className="money">{peso(d.net.statutoryDiscount)}</span> },
              { header: t('rep.vatAmount'), num: true, cell: (d) => <span className="money">{peso(d.net.vatAmount)}</span> },
              { header: t('rep.net'), num: true, cell: (d) => <span className="money font-semibold">{peso(d.net.amountDue)}</span> },
            ]}
            stacked={{
              title: (d) => formatDate(d.day, lang),
              meta: (d) => <Serial>{t('rep.sales')} {peso(d.sales.amountDue)} · {t('rep.returns')} {peso(d.returns.amountDue)}</Serial>,
              figure: (d) => <span className="money font-semibold">{peso(d.net.amountDue)}</span>,
            }}
            foot={{
              cells: [t('common.total'), `${s.totals.salesCount} / ${s.totals.returnsCount}`, ...cols(s.totals.net).map((v, i) => <span key={i} className="money">{peso(v)}</span>)],
              title: t('rep.net'),
              figure: <span className="money">{peso(s.totals.net.amountDue)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
      {s && days.length > 0 && <p className="text-[0.8125rem] text-muted">{t('rep.countHint')}</p>}
      {/* ADR-0023: room nights are not sales (they are charged on the folio), so they are their own source. */}
      {s?.rooms && s.rooms.days.length > 0 && (
        <section aria-labelledby="rooms-source" className="flex flex-col gap-3">
          <h2 id="rooms-source" className="section-title">{t('rep.roomsSource')}</h2>
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.roomsSourceHint')}</p>
          <Note denom="violet" className="pr-2">
            <RecordTable
              rows={s.rooms.days}
              rowKey={(d) => d.day}
              columns={[
                { header: t('common.date'), cell: (d) => <b>{formatDate(d.day, lang)}</b> },
                { header: t('rep.nights'), num: true, cell: (d) => <Serial className="text-ink">{d.nights}</Serial> },
                { header: t('rep.statutoryDiscount'), num: true, cell: (d) => <span className="money">{peso(d.statutoryDiscount)}</span> },
                { header: t('rep.vatAmount'), num: true, cell: (d) => <span className="money">{peso(d.vatAmount)}</span> },
                { header: t('rep.net'), num: true, cell: (d) => <span className="money font-semibold">{peso(d.amountDue)}</span> },
              ]}
              stacked={{
                title: (d) => formatDate(d.day, lang),
                meta: (d) => <Serial>{t('rep.nights')} {d.nights} · {t('rep.vatAmount')} {peso(d.vatAmount)}</Serial>,
                figure: (d) => <span className="money font-semibold">{peso(d.amountDue)}</span>,
              }}
              foot={{
                cells: [t('common.total'), s.rooms.totals.nights, <span key="sd" className="money">{peso(s.rooms.totals.statutoryDiscount)}</span>, <span key="v" className="money">{peso(s.rooms.totals.vatAmount)}</span>, <span key="a" className="money">{peso(s.rooms.totals.amountDue)}</span>],
                title: t('rep.roomsSource'),
                figure: <span className="money">{peso(s.rooms.totals.amountDue)}</span>,
              }}
            />
          </Note>
        </section>
      )}
    </ReportsChrome>
  );
}
