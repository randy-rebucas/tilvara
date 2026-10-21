import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { OccupancyReport } from '@/lib/api';
import { formatDate, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.occupancy');

const pct = (v: string | null) => (v === null ? '—' : `${v}%`);

/**
 * Occupancy and room revenue (ADR-0023 §12): per night, rooms available (not out of order) and sold
 * (nights charged, less reversals), occupancy, room revenue before VAT, ADR and RevPAR.
 */
export default async function OccupancyPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<OccupancyReport>(`/reports/occupancy?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  const m = (v: string | null) => <span className="money">{v === null ? '—' : peso(v)}</span>;
  return (
    <ReportsChrome tab="occupancy" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.occupancyLede')}</p>
      {d && (
        <Note denom="violet" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
          <Figure label={t('rep.occupancyPct')}>{pct(d.totals.occupancyPercent)}</Figure>
          <Figure label={t('rep.roomRevenue')}>{peso(d.totals.roomRevenueExVat)}</Figure>
          <Figure label={t('rep.adr')}>{d.totals.adr === null ? '—' : peso(d.totals.adr)}</Figure>
          <Figure label={t('rep.revpar')}>{d.totals.revpar === null ? '—' : peso(d.totals.revpar)}</Figure>
        </Note>
      )}
      <Note className="pr-2">
        {d && d.days.length > 0 ? (
          <RecordTable
            rows={d.days}
            rowKey={(x) => x.day}
            dimmed={(x) => x.roomsSold === 0}
            columns={[
              { header: t('common.date'), cell: (x) => <b>{formatDate(x.day, lang)}</b> },
              { header: t('rep.roomsAvailable'), num: true, cell: (x) => <Serial className="text-ink">{x.roomsAvailable}</Serial> },
              { header: t('rep.roomsSold'), num: true, cell: (x) => <Serial className="text-ink">{x.roomsSold}</Serial> },
              { header: t('rep.occupancyPct'), num: true, cell: (x) => <Serial className="text-ink">{pct(x.occupancyPercent)}</Serial> },
              { header: t('rep.roomRevenue'), num: true, cell: (x) => m(x.roomRevenueExVat) },
              { header: t('rep.adr'), num: true, cell: (x) => m(x.adr) },
              { header: t('rep.revpar'), num: true, cell: (x) => m(x.revpar) },
            ]}
            stacked={{
              title: (x) => formatDate(x.day, lang),
              meta: (x) => <Serial>{t('rep.roomsSoldOf', { sold: x.roomsSold, available: x.roomsAvailable })} · {pct(x.occupancyPercent)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.roomRevenueExVat)}</span>,
            }}
            foot={{
              cells: [t('common.total'), d.totals.roomsAvailable, d.totals.roomsSold, pct(d.totals.occupancyPercent), <span key="r" className="money">{peso(d.totals.roomRevenueExVat)}</span>, m(d.totals.adr), m(d.totals.revpar)],
              title: t('rep.roomRevenue'),
              figure: <span className="money">{peso(d.totals.roomRevenueExVat)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
