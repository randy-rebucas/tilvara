import { Empty, Note } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, type Me, type TaxSummary } from '@/lib/api';
import { servesLodging } from '@/lib/business-type';
import { peso, percentFromRate } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Tax summary' };

/** Net sales per VAT status and rate in force at the sale (its tax profile), in the BIR's buckets. */
export default async function TaxSummaryPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<TaxSummary>(`/reports/tax-summary?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const lodging = servesLodging((await api<Me>('/me')).activeTenant?.businessType);

  return (
    <ReportsChrome tab="tax" scope={scope} error={r?.error}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('rep.taxNote')}{lodging && <> {t('rep.taxIncludesNights')}</>}</p>
      <Note denom="ink" className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => `${x.vatStatus}:${x.vatRate}`}
            columns={[
              { header: t('loc.vat'), cell: (x) => <b>{x.vatStatus === 'VAT' ? `${t('loc.vatReg')} ${percentFromRate(x.vatRate)}%` : t('loc.nonVat')}</b> },
              { header: t('rep.vatable'), num: true, cell: (x) => <span className="money">{peso(x.vatableSales)}</span> },
              { header: t('rep.vatAmount'), num: true, cell: (x) => <span className="money">{peso(x.vatAmount)}</span> },
              { header: t('rep.vatExempt'), num: true, cell: (x) => <span className="money">{peso(x.vatExemptSales)}</span> },
              { header: t('rep.zeroRated'), num: true, cell: (x) => <span className="money">{peso(x.zeroRatedSales)}</span> },
              { header: t('rep.ptSales'), num: true, cell: (x) => <span className="money">{peso(x.percentageTaxSales)}</span> },
              { header: t('rep.statutoryDiscount'), num: true, cell: (x) => <span className="money">{peso(x.statutoryDiscount)}</span> },
              { header: t('rep.amountDue'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.amountDue)}</span> },
            ]}
            stacked={{
              title: (x) => (x.vatStatus === 'VAT' ? `${t('loc.vatReg')} ${percentFromRate(x.vatRate)}%` : t('loc.nonVat')),
              meta: (x) => <span className="text-[0.8125rem] text-muted">{t('rep.vatable')} {peso(x.vatableSales)} · {t('rep.vatAmount')} {peso(x.vatAmount)} · {t('rep.vatExempt')} {peso(x.vatExemptSales)}</span>,
              figure: (x) => <span className="money font-semibold">{peso(x.amountDue)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noData')}</Empty>
        )}
      </Note>
    </ReportsChrome>
  );
}
