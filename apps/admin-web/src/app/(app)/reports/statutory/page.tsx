import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { StatutoryBook } from '@/lib/api';
import { docNo } from '@/lib/options';
import { formatDate, peso, sumDecimal } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'SC/PWD book' };

/** Every sale and return with a senior citizen or PWD discount: who, ID, the sale and the discount. */
export default async function StatutoryBookPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<StatutoryBook>(`/reports/statutory-book?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const label = (s: string) => (s === 'SC' ? 'SC' : s === 'PWD' ? 'PWD' : s);

  return (
    <ReportsChrome tab="statutory" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.statutoryNote')}</p>
      <Note className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => `${x.document}:${x.register}:${x.number}:${x.idNumber}`}
            columns={[
              { header: t('common.date'), cell: (x) => formatDate(x.day, lang) },
              { header: t('rep.document'), cell: (x) => <Serial className="text-ink">{t(x.document === 'SALE' ? 'rep.docSALE' : 'rep.docRETURN')} {x.register}-{docNo(x.number)}</Serial> },
              { header: t('rep.beneficiary'), cell: (x) => <><b>{x.name}</b> <Serial>{label(x.schemeCode)} · {x.idNumber}</Serial></> },
              { header: t('rep.sales'), num: true, cell: (x) => <span className="money">{peso(x.sales)}</span> },
              { header: t('rep.discount'), num: true, cell: (x) => <span className="money">{peso(x.discount)}</span> },
              { header: t('rep.net'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.net)}</span> },
            ]}
            stacked={{
              title: (x) => x.name,
              meta: (x) => <Serial>{formatDate(x.day, lang)} · {label(x.schemeCode)} {x.idNumber} · {x.register}-{docNo(x.number)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.discount)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', ...(['sales', 'discount', 'net'] as const).map((k) => <span key={k} className="money">{peso(sumDecimal(rows.map((x) => x[k])))}</span>)],
              title: t('rep.discount'),
              figure: <span className="money">{peso(sumDecimal(rows.map((x) => x.discount)))}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
