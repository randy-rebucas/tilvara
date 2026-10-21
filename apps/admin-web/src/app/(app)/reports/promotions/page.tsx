import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PromotionsReport } from '@/lib/api';
import { peso, qty, sumDecimal } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.promotions');

/** Per promotion (ADR-0021 §1): the sales it priced, the units, the discount it gave and what they sold for, less returns. */
export default async function PromotionsReportPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<PromotionsReport>(`/reports/promotions?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const total = (k: 'discount' | 'netSales') => sumDecimal(rows.map((x) => x[k]));

  return (
    <ReportsChrome tab="promotions" scope={scope} error={r?.error}>
      <Note denom="blue" className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.promotionId}
            columns={[
              { header: t('promo.name'), cell: (x) => <Link href={`/prices/promotions/${x.promotionId}`} className="font-semibold underline">{x.name}</Link> },
              { header: t('promo.kind'), cell: (x) => <span className="text-muted">{t(`promo.kind.${x.kind}` as MessageKey)}</span> },
              { header: t('csv.salesCount'), num: true, cell: (x) => x.salesCount },
              { header: t('csv.netQty'), num: true, cell: (x) => qty(x.netQuantity) },
              { header: t('rep.promoDiscount'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.discount)}</span> },
              { header: t('rep.netSales'), num: true, cell: (x) => <span className="money">{peso(x.netSales)}</span> },
            ]}
            stacked={{
              title: (x) => x.name,
              meta: (x) => <Serial>{t('csv.salesCount')} {x.salesCount} · {qty(x.netQuantity)} · {t('rep.netSales')} {peso(x.netSales)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.discount)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', '', <span key="d" className="money">{peso(total('discount'))}</span>, <span key="n" className="money">{peso(total('netSales'))}</span>],
              title: t('rep.promoDiscount'),
              figure: <span className="money">{peso(total('discount'))}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noPromotions')}</Empty>
        )}
      </Note>
      <p className="max-w-[80ch] text-[0.8125rem] text-muted">{t('rep.promotionsNote')}</p>
    </ReportsChrome>
  );
}
