import Link from 'next/link';
import { ActionButton, ReasonAction } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/scope';
import { apiOrNull, type OfflineSale, type TillHealth } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Offline sales' };

type Tab = 'review' | 'recorded' | 'dismissed';
const STATUS: Record<Tab, OfflineSale['status']> = { review: 'QUARANTINED', recorded: 'RECORDED', dismissed: 'DISMISSED' };
const KNOWN = new Set(['TOTAL_MISMATCH', 'SESSION_NOT_OPEN', 'NOT_SESSION_OWNER', 'CASHIER_NOT_AUTHORIZED', 'WRONG_REGISTER', 'UNKNOWN_SNAPSHOT', 'PERIOD_CLOSED', 'FORBIDDEN', 'NOT_FOUND', 'DUPLICATE_TRANSACTION']);
const FLAGS = new Set(['PRICE_CHANGED', 'SNAPSHOT_EXPIRED', 'CLOCK_ADJUSTED']);

/**
 * Offline sales delivered by the tills (ADR-0015 §5): the ones the server could not record wait here
 * for a manager (`cash.reconcile`) to record again once fixed, or dismiss with a reason.
 */
type T = Awaited<ReturnType<typeof getT>>['t'];

/** A till in words: silent during a shift (amber), sales waiting for review, or fine. */
function TillState({ x, t }: { x: TillHealth; t: T }) {
  return (
    <span className="flex flex-wrap gap-1">
      {x.silent && <span className="tag tag-warn">{t('off.till.silent')}</span>}
      {x.quarantined > 0 && <span className="tag">{t('off.till.waiting', { n: String(x.quarantined) })}</span>}
      {!x.silent && x.quarantined === 0 && <span className="text-muted">{t('off.till.ok')}</span>}
    </span>
  );
}

export default async function OfflineSalesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { t, lang } = await getT();
  const q = (await searchParams).tab;
  const tab: Tab = q === 'recorded' || q === 'dismissed' ? q : 'review';
  const [list, health] = await Promise.all([
    apiOrNull<{ data: OfflineSale[] }>(`/sync/transactions?status=${STATUS[tab]}`),
    apiOrNull<{ data: TillHealth[]; silenceMinutes: number }>('/sync/terminals'),
  ]);
  const rows = list?.data ?? [];
  const tills = health?.data ?? [];

  const why = (x: OfflineSale) => {
    if (x.errorCode && KNOWN.has(x.errorCode)) {
      const d = x.errorDetail?.details ?? {};
      return t(`off.why.${x.errorCode}` as MessageKey, {
        charged: peso(String(d.charged ?? '')), expected: peso(String(d.expected ?? '')),
        sale: d.saleNumber === undefined ? '' : `#${String(d.saleNumber).padStart(6, '0')}`,
      });
    }
    return x.errorDetail?.message ?? x.errorCode ?? '';
  };
  const outcome = (x: OfflineSale) =>
    x.status === 'RECORDED'
      ? (
        <>
          {x.saleId ? (
            <Link href={`/sales/${x.saleId}`} className="underline">{t('off.saleN', { ref: `${x.registerCode}-${String(x.saleNumber ?? 0).padStart(6, '0')}` })}</Link>
          ) : (
            t('off.saleN', { ref: `${x.registerCode}-${String(x.saleNumber ?? 0).padStart(6, '0')}` })
          )}
          {/* Recorded, not refused, but worth a look (ADR-0015 §5): each flag in words. */}
          {x.flags.filter((f) => FLAGS.has(f)).map((f) => (
            <span key={f} className="tag tag-warn mt-1 block w-fit">{t(`off.flag.${f}` as MessageKey, { deviceTime: formatDateTime(x.occurredAt, lang) })}</span>
          ))}
        </>
      )
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
      {tills.length > 0 && (
        <section aria-labelledby="tills">
          <h2 id="tills" className="mb-2 text-[1.0625rem] font-semibold">{t('off.tills')}</h2>
          {tills.some((x) => x.silent) && (
            <p role="status" className="mb-3 max-w-[68ch] text-[0.875rem] text-orange">{t('off.silentHint', { n: String(health?.silenceMinutes ?? 30) })}</p>
          )}
          <Note className="pr-2">
            <RecordTable
              rows={tills}
              rowKey={(x) => x.terminalId}
              columns={[
                { header: t('off.till.name'), cell: (x) => <><span className="font-semibold">{x.name}</span><Serial className="block">{x.branchName} · {x.register.code}</Serial></> },
                { header: t('off.till.lastContact'), cell: (x) => (x.lastContactAt ? formatDateTime(x.lastContactAt, lang) : t('off.till.never')) },
                { header: t('off.till.shift'), cell: (x) => (x.shiftOpenedAt ? t('off.till.shiftOpen', { since: formatDateTime(x.shiftOpenedAt, lang) }) : t('off.till.noShift')) },
                { header: t('off.till.state'), cell: (x) => <TillState x={x} t={t} /> },
              ]}
              stacked={{
                title: (x) => <>{x.name} · {x.register.code}</>,
                meta: (x) => <>{x.lastContactAt ? formatDateTime(x.lastContactAt, lang) : t('off.till.never')} · <TillState x={x} t={t} /></>,
              }}
            />
          </Note>
        </section>
      )}
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
                { header: t('off.col.happened'), cell: (x) => formatDateTime(x.recordedAt ?? x.occurredAt, lang) },
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
                    <Serial>{x.localReference} · {x.terminalName} · {formatDateTime(x.recordedAt ?? x.occurredAt, lang)}</Serial>
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
