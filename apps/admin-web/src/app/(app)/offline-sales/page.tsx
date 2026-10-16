import { ActionButton, ReasonAction } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/scope';
import { apiOrNull, type OfflineSale } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Offline sales' };

type Tab = 'review' | 'recorded' | 'dismissed';
const STATUS: Record<Tab, OfflineSale['status']> = { review: 'QUARANTINED', recorded: 'RECORDED', dismissed: 'DISMISSED' };
const KNOWN = new Set(['TOTAL_MISMATCH', 'SESSION_NOT_OPEN', 'NOT_SESSION_OWNER', 'CASHIER_NOT_AUTHORIZED', 'WRONG_REGISTER', 'UNKNOWN_SNAPSHOT', 'PERIOD_CLOSED', 'FORBIDDEN', 'NOT_FOUND']);

/**
 * Offline sales delivered by the tills (ADR-0015 §5): the ones the server could not record wait here
 * for a manager (`cash.reconcile`) to record again once fixed, or dismiss with a reason.
 */
export default async function OfflineSalesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { t, lang } = await getT();
  const q = (await searchParams).tab;
  const tab: Tab = q === 'recorded' || q === 'dismissed' ? q : 'review';
  const list = await apiOrNull<{ data: OfflineSale[] }>(`/sync/transactions?status=${STATUS[tab]}`);
  const rows = list?.data ?? [];

  const why = (x: OfflineSale) => {
    if (x.errorCode && KNOWN.has(x.errorCode)) {
      const d = x.errorDetail?.details ?? {};
      return t(`off.why.${x.errorCode}` as MessageKey, { charged: peso(String(d.charged ?? '')), expected: peso(String(d.expected ?? '')) });
    }
    return x.errorDetail?.message ?? x.errorCode ?? '';
  };
  const outcome = (x: OfflineSale) =>
    x.status === 'RECORDED'
      ? t('off.saleN', { ref: `${x.registerCode}-${String(x.saleNumber ?? 0).padStart(6, '0')}` })
      : x.status === 'DISMISSED'
        ? t('off.dismissedBecause', { reason: x.resolveReason ?? '' })
        : why(x);
  const actions = (x: OfflineSale) =>
    x.status === 'QUARANTINED' && (
      <div className="flex flex-wrap items-start justify-end gap-2">
        <ActionButton url={`/api/v1/sync/transactions/${x.id}/retry`} label={t('off.retry')} primary refreshOnError />
        <ReasonAction url={`/api/v1/sync/transactions/${x.id}/dismiss`} label={t('off.dismiss')} reasonLabel={t('off.dismissReason')} hint={t('off.dismissHint')} danger />
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('off.title')} lede={t('off.lede')} />
      <SubNav
        label={t('common.sections')}
        active={tab}
        items={(['review', 'recorded', 'dismissed'] as Tab[]).map((k) => ({ key: k, href: k === 'review' ? '/offline-sales' : `/offline-sales?tab=${k}`, label: t(`off.tab.${k}`) }))}
      />
      <section>
        {tab === 'review' && rows.length > 0 && <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('off.reviewHint')}</p>}
        <Note denom="orange" className="pr-2">
          {rows.length > 0 ? (
            <RecordTable
              rows={rows}
              rowKey={(x) => x.id}
              columns={[
                { header: t('off.col.reference'), cell: (x) => <><Serial className="text-orange">{x.localReference}</Serial><span className="block text-[0.8125rem] text-muted">{x.terminalName} · {x.registerCode}</span></> },
                { header: t('off.col.happened'), cell: (x) => formatDateTime(x.occurredAt, lang) },
                { header: t('off.col.cashier'), cell: (x) => x.cashierName ?? t('off.unknownCashier') },
                { header: t('off.col.amount'), num: true, cell: (x) => <span className="money">{peso(x.amountDue)}</span> },
                {
                  header: tab === 'review' ? t('off.col.problem') : t('off.col.outcome'),
                  cell: (x) => <>{outcome(x)}{x.attempts > 1 && <Serial className="block">{t('off.tries', { n: String(x.attempts) })}</Serial>}</>,
                },
                ...(tab === 'review' ? [{ header: <span className="sr-only">{t('common.actions')}</span>, num: true, cell: actions }] : []),
              ]}
              stacked={{
                title: (x) => <>{x.cashierName ?? t('off.unknownCashier')} · <span className="money">{peso(x.amountDue)}</span></>,
                meta: (x) => (
                  <>
                    <Serial>{x.localReference} · {x.terminalName} · {formatDateTime(x.occurredAt, lang)}</Serial>
                    <span className="mt-1 block">{outcome(x)}</span>
                    {tab === 'review' && <div className="mt-2">{actions(x)}</div>}
                  </>
                ),
              }}
            />
          ) : (
            <Empty>{list ? t(`off.empty.${tab}`) : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
