import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PurchasesBySupplier } from '@/lib/api';
import { peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Purchases by supplier' };

/** Goods received from each supplier at receipt cost, what went back, the net, and the invoices of the period. */
export default async function PurchasesPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<PurchasesBySupplier>(`/reports/purchases-by-supplier?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];

  return (
    <ReportsChrome tab="purchases" scope={scope} error={r?.error}>
      <Note className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.supplierId}
            columns={[
              { header: t('rep.supplier'), cell: (x) => <Link href={`/purchasing/suppliers/${x.supplierId}`} className="underline"><Serial className="text-ink">{x.code}</Serial> {x.name}</Link> },
              { header: t('rep.receipts'), num: true, cell: (x) => x.receipts },
              { header: t('rep.received'), num: true, cell: (x) => <span className="money">{peso(x.received)}</span> },
              { header: t('rep.returnedToSupplier'), num: true, cell: (x) => <span className="money">{peso(x.returned)}</span> },
              { header: t('rep.netReceived'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.netReceived)}</span> },
              { header: t('rep.invoiced'), num: true, cell: (x) => <span className="money">{peso(x.invoiced)}</span> },
            ]}
            stacked={{
              title: (x) => `${x.code} ${x.name}`,
              meta: (x) => <Serial>{t('rep.received')} {peso(x.received)} · {t('rep.returnedToSupplier')} {peso(x.returned)} · {t('rep.invoiced')} {peso(x.invoiced)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.netReceived)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', ...(['received', 'returned', 'netReceived', 'invoiced'] as const).map((k) => <span key={k} className="money">{peso(r!.data!.totals[k])}</span>)],
              title: t('rep.netReceived'),
              figure: <span className="money">{peso(r!.data!.totals.netReceived)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noPurchases')}</Empty>
        )}
      </Note>
      <p className="text-[0.8125rem] text-muted">{t('rep.purchasesNote')}</p>
    </ReportsChrome>
  );
}
