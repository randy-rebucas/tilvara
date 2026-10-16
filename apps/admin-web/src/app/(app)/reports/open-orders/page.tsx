import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import type { OpenOrders } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Open orders' };

/** Orders still open or unpaid at the close of a day (or now, for today) — what to chase before closing. */
export default async function OpenOrdersPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<OpenOrders>(`/reports/open-orders?branchId=${scope.branch.id}&day=${scope.day}`) : null;
  const d = r?.data;
  const where = (o: OpenOrders['data'][number]) => o.tableCode ?? o.customerName ?? t('rest.takeaway');

  return (
    <ReportsChrome tab="open" scope={scope} error={r?.error}>
      {d && (
        <>
          <p className="text-[0.875rem] text-muted">{t('rep.asOf', { time: formatDateTime(d.asOf, lang) })}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label={t('rep.openOrders')}>{d.totals.orders}</Figure>
            <Figure label={t('rep.unbilled')}>{d.totals.unbilled}</Figure>
            <Figure label={t('rep.billedUnpaid')}>{d.totals.billed}</Figure>
            <Figure label={t('rep.unpaid')}>{peso(d.totals.unpaid)}</Figure>
          </div>
        </>
      )}
      <Note className="pr-2">
        {d && d.data.length > 0 ? (
          <RecordTable
            rows={d.data}
            rowKey={(o) => o.orderId}
            columns={[
              { header: t('rep.order'), cell: (o) => <><b>{where(o)}</b> <Serial>#{o.orderNumber}</Serial></> },
              { header: t('rep.opened'), cell: (o) => <>{formatDateTime(o.openedAt, lang)}<span className="block text-[0.8125rem] text-muted">{o.openedBy.displayName}</span></> },
              { header: t('common.status'), cell: (o) => <span className={`tag ${o.status === 'BILLED' ? 'tag-warn' : ''}`}>{t(`rep.orderStatus.${o.status}`)}</span> },
              { header: t('rep.itemsNotServed'), num: true, cell: (o) => `${o.notServed} / ${o.items}` },
              { header: t('rep.billAmount'), num: true, cell: (o) => (o.bill ? <span className="money">{peso(o.bill.amountDue)}</span> : '—') },
              { header: t('rep.left'), num: true, cell: (o) => (o.bill ? <b className="money">{peso(o.bill.remaining)}</b> : '—') },
            ]}
            stacked={{
              title: (o) => <>{where(o)} <Serial>#{o.orderNumber}</Serial></>,
              meta: (o) => <Serial>{t(`rep.orderStatus.${o.status}`)} · {formatDateTime(o.openedAt, lang)}</Serial>,
              figure: (o) => (o.bill ? <span className="money font-semibold">{peso(o.bill.remaining)}</span> : <span className="text-[0.75rem] text-muted">{t('rep.notBilled')}</span>),
            }}
            foot={{ cells: [t('common.total'), '', '', '', '', <span key="u" className="money">{peso(d.totals.unpaid)}</span>], title: t('rep.unpaid'), figure: <span className="money">{peso(d.totals.unpaid)}</span> }}
          />
        ) : (
          <Empty>{t('rep.noOpenOrders')}</Empty>
        )}
      </Note>
      <p className="text-[0.8125rem] text-muted">{t('rep.openNote')}</p>
    </ReportsChrome>
  );
}
