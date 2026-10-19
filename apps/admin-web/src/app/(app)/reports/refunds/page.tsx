import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { RefundWatch } from '@/lib/api';
import { peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { loadReport, ReportsChrome, reportScope, type ReportQuery } from '../chrome';

export const metadata = { title: 'Refund watch' };

/** Rate as a percentage with one decimal, from the API's 4-dp ratio string (string arithmetic only). */
function pct(rate: string | null): string {
  if (rate === null) return '—';
  const [w = '0', f = ''] = rate.split('.');
  const basis = Number(`${w}${f.padEnd(4, '0').slice(0, 4)}`); // ratio × 10,000 as an integer: exact
  return `${Math.floor(basis / 100)}.${String(basis % 100).padStart(2, '0').slice(0, 1)}%`;
}

/** Who refunds what, against the branch's rate (THREAT_MODEL T5). Signals for a manager, not findings. */
export default async function RefundWatchPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { t } = await getT();
  const scope = await reportScope(await searchParams);
  const r = scope.branch ? await loadReport<RefundWatch>(`/reports/refund-watch?branchId=${scope.branch.id}&from=${scope.from}&to=${scope.to}`) : null;
  const rows = r?.data?.data ?? [];
  const flags = (x: RefundWatch['data'][number]) =>
    x.flags.length ? x.flags.map((f) => <span key={f} className="tag tag-warn mr-1">{t(`rep.flag.${f}` as MessageKey)}</span>) : <span className="text-muted">—</span>;

  return (
    <ReportsChrome tab="refunds" scope={scope} error={r?.error}>
      <section>
        <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('rep.refundLede')}</p>
        {r?.data && (
          <p className="mb-3 text-[0.9375rem]" data-testid="branch-rate">
            {t('rep.branchRate', { rate: pct(r.data.branch.refundRate), refunded: peso(r.data.branch.refunded), sales: peso(r.data.branch.sales) })}
          </p>
        )}
        <Note className="pr-2">
          {rows.length > 0 ? (
            <RecordTable
              rows={rows}
              rowKey={(x) => x.userId}
              columns={[
                { header: t('rep.cashier'), cell: (x) => <b>{x.displayName ?? '—'}</b> },
                { header: t('rep.sales'), num: true, cell: (x) => <span className="money">{peso(x.sales)}</span> },
                { header: t('rep.returnsCol'), num: true, cell: (x) => `${x.returnsCount} · ${peso(x.returns)}` },
                { header: t('rep.voidsCol'), num: true, cell: (x) => `${x.voidsCount} · ${peso(x.voids)}` },
                { header: t('rep.ownRefunds'), num: true, cell: (x) => x.ownSalesRefunded },
                { header: t('rep.refundRate'), num: true, cell: (x) => <b className="money">{pct(x.refundRate)}</b> },
                { header: t('rep.flags'), cell: flags },
              ]}
              stacked={{
                title: (x) => x.displayName ?? '—',
                meta: (x) => <Serial>{t('rep.refundRate')} {pct(x.refundRate)} · {t('rep.ownRefunds')} {x.ownSalesRefunded}</Serial>,
                figure: (x) => flags(x),
              }}
            />
          ) : (
            <Empty>{t('rep.noData')}</Empty>
          )}
        </Note>
        <p className="mt-2 text-[0.8125rem] text-muted">{t('rep.refundNote')}</p>
      </section>
    </ReportsChrome>
  );
}
