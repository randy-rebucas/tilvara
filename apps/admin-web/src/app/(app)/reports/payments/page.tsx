import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PaymentExceptions } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('reports.payments');

/**
 * Card and QR payments of the branch that still need someone, on any shift: no answer from the
 * provider, still waiting, or approved but in no sale. Each is checked or cancelled at the till.
 */
export default async function PaymentExceptionsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t, lang } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<PaymentExceptions>(`/reports/payment-exceptions?branchId=${scope.branch.id}`) : null;
  const rows = r?.data?.data ?? [];

  return (
    <ReportsChrome tab="payments" scope={scope} error={r?.error}>
      <Note className="pr-2">
        {rows.length > 0 ? (
          <RecordTable
            rows={rows}
            rowKey={(x) => x.id}
            columns={[
              { header: t('rep.problem'), cell: (x) => <span className="tag tag-warn">{t(`rep.problem.${x.problem}` as MessageKey)}</span> },
              { header: t('csv.method'), cell: (x) => <b>{x.method}</b> },
              { header: t('rep.takenAt'), cell: (x) => <span className="text-muted">{formatDateTime(x.createdAt, lang)}</span> },
              { header: t('rep.shift'), cell: (x) => <Link href={`/shifts/${x.cashierSessionId}`} className="underline"><Serial className="text-ink">{x.registerCode}</Serial> {x.cashierName ?? '—'}</Link> },
              { header: t('rep.amount'), num: true, cell: (x) => <span className="money font-semibold">{peso(x.amount)}</span> },
            ]}
            stacked={{
              title: (x) => t(`rep.problem.${x.problem}` as MessageKey),
              meta: (x) => <Serial>{x.method} · {x.registerCode} · {formatDateTime(x.createdAt, lang)}</Serial>,
              figure: (x) => <span className="money font-semibold">{peso(x.amount)}</span>,
            }}
            foot={{
              cells: [t('common.total'), '', '', '', <span key="a" className="money">{peso(r!.data!.totals.amount)}</span>],
              title: t('common.total'),
              figure: <span className="money">{peso(r!.data!.totals.amount)}</span>,
            }}
          />
        ) : (
          <Empty>{t('rep.noExceptions')}</Empty>
        )}
      </Note>
      <p className="text-[0.8125rem] text-muted">{t('rep.paymentsNote')}</p>
    </ReportsChrome>
  );
}
