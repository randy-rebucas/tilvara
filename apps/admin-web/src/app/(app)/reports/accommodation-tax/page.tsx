import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { AccommodationTaxReport } from '@/lib/api';
import { peso, percentFromRate } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Accommodation tax' };

/**
 * The local accommodation tax per month (ADR-0023 §10): the nights' net before VAT it was charged on
 * and the tax, less reversals. The rate and its base are the branch's own setting, unverified.
 */
export default async function AccommodationTaxPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<AccommodationTaxReport>(`/reports/accommodation-tax?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const d = r?.data;
  return (
    <ReportsChrome tab="accommodationTax" scope={scope} error={r?.error}>
      <Callout tone="warn">{t('lod.accommodationTaxUnverified')}</Callout>
      {d && (
        <Note className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-3">
          <Figure label={t('rep.accTaxRate')}>{d.rate ? `${percentFromRate(d.rate)}%` : t('lod.none')}</Figure>
          <Figure label={t('rep.accTaxBase')}>{peso(d.totals.base)}</Figure>
          <Figure label={t('rep.accTax')}>{peso(d.totals.tax)}</Figure>
        </Note>
      )}
      <Note denom="ink" className="pr-2">
        {d && d.data.length > 0 ? (
          <RecordTable
            rows={d.data}
            rowKey={(x) => x.month}
            columns={[
              { header: t('rep.month'), cell: (x) => <Serial className="text-ink">{x.month}</Serial> },
              { header: t('rep.nights'), num: true, cell: (x) => <Serial className="text-ink">{x.nights}</Serial> },
              { header: t('rep.accTaxBase'), num: true, cell: (x) => <span className="money">{peso(x.base)}</span> },
              { header: t('rep.accTax'), num: true, cell: (x) => <b className="money">{peso(x.tax)}</b> },
            ]}
            stacked={{
              title: (x) => x.month,
              meta: (x) => <Serial>{t('rep.nights')} {x.nights} · {t('rep.accTaxBase')} {peso(x.base)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.tax)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', <span key="b" className="money">{peso(d.totals.base)}</span>, <span key="t" className="money">{peso(d.totals.tax)}</span>],
              title: t('rep.accTax'),
              figure: <span className="money">{peso(d.totals.tax)}</span>,
            }}
          />
        ) : (
          <Empty>{d?.rate ? t('rep.noData') : t('rep.accTaxOff')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
