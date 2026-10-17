import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { ByProduct } from '@/lib/api';
import { peso, qty, sumDecimal } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Sales by product' };

/** Each item sold: quantities, net sales, revenue ex VAT, cost and gross profit; charges listed apart. */
export default async function ByProductPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<ByProduct>(`/reports/by-product?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const total = (k: 'netSales' | 'revenueExVat' | 'cogs' | 'grossProfit') => sumDecimal(rows.map((x) => x[k]));

  return (
    <ReportsChrome tab="products" scope={scope} error={r?.error}>
      <Note denom="blue" className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.variantId}
            columns={[
              { header: t('common.item'), cell: (x) => <><b>{x.name}</b> <Serial>{x.sku}</Serial></> },
              { header: t('rep.qtySold'), num: true, cell: (x) => qty(x.quantitySold) },
              { header: t('rep.qtyReturned'), num: true, cell: (x) => qty(x.quantityReturned) },
              { header: t('rep.netSales'), num: true, cell: (x) => <span className="money">{peso(x.netSales)}</span> },
              { header: t('rep.revenueExVat'), num: true, cell: (x) => <span className="money">{peso(x.revenueExVat)}</span> },
              { header: t('rep.cogs'), num: true, cell: (x) => <span className="money">{peso(x.cogs)}</span> },
              { header: t('rep.grossProfit'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.grossProfit)}</span> },
            ]}
            stacked={{
              title: (x) => x.name,
              meta: (x) => <Serial>{x.sku} · {qty(x.netQuantity)} · {t('rep.netSales')} {peso(x.netSales)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.grossProfit)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', ...(['netSales', 'revenueExVat', 'cogs', 'grossProfit'] as const).map((k) => <span key={k} className="money">{peso(total(k))}</span>)],
              title: t('rep.grossProfit'),
              figure: <span className="money">{peso(total('grossProfit'))}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
      {r?.data && r.data.charges.length > 0 && (
        <p className="text-[0.875rem] text-muted">
          {r.data.charges.map((c) => `${t('doc.serviceCharge')}: ${peso(c.net)} (${t('rep.revenueExVat')} ${peso(c.netExVat)})`).join(' · ')}
        </p>
      )}
    </ReportsChrome>
  );
}
