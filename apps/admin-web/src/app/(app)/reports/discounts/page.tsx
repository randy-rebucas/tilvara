import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { DiscountsReport } from '@/lib/api';
import { formatDateTime, peso, signOf } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.discounts');

/** Every line sold off its list price: discounts at the counter and approved price changes, with who did each. */
export default async function DiscountsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<DiscountsReport>(`/reports/discounts?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const people = r?.data?.byCashier ?? [];

  return (
    <ReportsChrome tab="discounts" scope={scope} error={r?.error}>
      {rows.length > 0 ? (
        <>
          <Note className="pr-2">
            <RecordTable
              rows={people}
              rowKey={(p) => p.userId}
              columns={[
                { header: t('csv.cashier'), cell: (p) => <b>{p.displayName ?? '—'}</b> },
                { header: t('rep.lines'), num: true, cell: (p) => p.lines },
                { header: t('csv.discount'), num: true, cell: (p) => <span className="money">{peso(p.discount)}</span> },
                { header: t('rep.priceChange'), num: true, cell: (p) => <span className="money">{peso(p.priceChange)}</span> },
              ]}
              stacked={{
                title: (p) => p.displayName ?? '—',
                meta: (p) => <Serial>{t('rep.lines')} {p.lines} · {t('rep.priceChange')} {peso(p.priceChange)}</Serial>,
                figure: (p) => <span className="money font-semibold">{peso(p.discount)}</span>,
              }}
              foot={{
                cells: [t('common.total'), r!.data!.totals.lines, <span key="d" className="money">{peso(r!.data!.totals.discount)}</span>, <span key="p" className="money">{peso(r!.data!.totals.priceChange)}</span>],
                title: t('csv.discount'),
                figure: <span className="money">{peso(r!.data!.totals.discount)}</span>,
              }}
            />
          </Note>
          <Note className="pr-2">
            <RecordTable
              rows={rows}
              rowKey={(l) => `${l.saleId}-${l.name}-${l.unitPrice}-${l.discount}`}
              columns={[
                { header: t('cust.receipt'), cell: (l) => <Link href={`/sales/${l.saleId}`} className="serial font-semibold underline">{l.reference}</Link> },
                { header: t('cust.when'), cell: (l) => <span className="text-muted">{formatDateTime(l.completedAt, lang)}</span> },
                { header: t('common.item'), cell: (l) => <span>{l.name} <Serial>× {l.quantity}</Serial></span> },
                { header: t('rep.listPrice'), num: true, cell: (l) => <span className="money">{peso(l.listUnitPrice)}</span> },
                { header: t('rep.soldAt'), num: true, cell: (l) => <span className="money">{peso(l.unitPrice)}</span> },
                { header: t('csv.discount'), num: true, cell: (l) => <span className="money">{signOf(l.discount) ? peso(l.discount) : '—'}</span> },
                {
                  header: t('rep.approvedBy'),
                  cell: (l) => (l.approvalMethod ? <span>{l.approvedByName ?? '—'}{l.priceReason && <span className="text-muted"> · {l.priceReason}</span>}</span> : <span className="text-muted">—</span>),
                },
                { header: t('csv.cashier'), cell: (l) => <span>{l.cashierName ?? '—'}</span> },
              ]}
              stacked={{
                title: (l) => `${l.name} × ${l.quantity}`,
                meta: (l) => (
                  <Serial>
                    {l.reference} · {peso(l.listUnitPrice)} → {peso(l.unitPrice)}
                    {l.approvalMethod && ` · ${t('rep.approvedBy')} ${l.approvedByName ?? '—'}`}
                  </Serial>
                ),
                figure: (l) => <span className="money font-semibold">{signOf(l.discount) ? peso(l.discount) : peso(l.priceChange)}</span>,
              }}
            />
          </Note>
          <p className="text-[0.8125rem] text-muted">{t('rep.discountsNote')}</p>
        </>
      ) : (
        <Note><Empty>{t('rep.noDiscounts')}</Empty></Note>
      )}
    </ReportsChrome>
  );
}
