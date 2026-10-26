import Link from 'next/link';
import { ReasonAction } from '@/components/actions';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type CashierSessionRow, type Me, type Member, type Register } from '@/lib/api';
import { formatDateTime, peso, signed, signOf } from '@/lib/format';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('shifts');

/** How many recently closed shifts to show under the ones waiting. */
const RECENT = 30;

/**
 * Drawer counts: shifts counted short or over wait here (CLOSED) until a manager other than the
 * person who counted approves the count (`cash.reconcile`; the API refuses self-approval too).
 * The difference was booked when the drawer was counted; approving records who answered for it.
 */
export default async function DrawerCountsPage() {
  const { t, lang } = await getT();
  const me = await api<Me>('/me');
  const manager = me.activeTenant?.permissions.includes('cash.reconcile') ?? false;
  const [waiting, openNow, closed, branches, registers, members] = await Promise.all([
    apiOrNull<{ data: CashierSessionRow[] }>('/cashier-sessions?status=CLOSED'),
    apiOrNull<{ data: CashierSessionRow[] }>('/cashier-sessions?status=OPEN'),
    apiOrNull<{ data: CashierSessionRow[] }>('/cashier-sessions?status=RECONCILED'),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: Register[] }>('/registers'),
    apiOrNull<{ data: Member[] }>('/members'),
  ]);
  const person = (userId: string | null | undefined) => (userId ? members?.data.find((m) => m.user.id === userId)?.user.displayName ?? '—' : '—');
  const where = (s: CashierSessionRow) => {
    const register = registers?.data.find((r) => r.id === s.registerId);
    const branch = branches?.data.find((b) => b.id === s.branchId);
    return `${register?.code ?? '—'} · ${branch?.name ?? '—'}`;
  };
  const difference = (v: string) => (
    <span className={`money font-semibold ${signOf(v) !== 0 ? 'text-red' : ''}`}>
      {signOf(v) === 0 ? peso('0') : signed(v, peso)} {signOf(v) < 0 ? t('doc.short') : signOf(v) > 0 ? t('doc.over') : ''}
    </span>
  );
  const approve = (s: CashierSessionRow) =>
    s.reconciliation?.countedBy === me.userId ? (
      <span className="text-[0.875rem] text-muted">{t('drawers.selfCounted')}</span>
    ) : (
      <ReasonAction url={`/api/v1/cashier-sessions/${s.id}/approve-variance`} label={t('drawers.approve')} reasonLabel={t('drawers.approveNote')} hint={t('drawers.approveHint')} field="note" />
    );
  const open = (s: CashierSessionRow) => <Link href={`/shifts/${s.id}`} className="btn">{t('drawers.open')}</Link>;
  const recent = (closed?.data ?? []).slice(0, RECENT);

  if (!manager) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('drawers.title')} lede={t('drawers.lede')} />
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('drawers.title')} lede={t('drawers.lede')} actions={<Link href="/offline-sales" className="btn">{t('off.title')}</Link>} />

      <section aria-labelledby="waiting">
        <h2 id="waiting" className="section-title mb-3">{t('drawers.waiting')}</h2>
        <Note denom="orange" className="pr-2">
          {waiting && waiting.data.length > 0 ? (
            <RecordTable
              rows={waiting.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('drawers.register'), cell: (s) => <><Serial className="text-orange">{where(s)}</Serial><span className="block text-[0.8125rem] text-muted">{s.openedByName ?? person(s.openedBy)}</span></> },
                { header: t('drawers.countedAt'), cell: (s) => <span className="text-muted">{formatDateTime(s.closedAt, lang)}<span className="block">{s.reconciliation?.countedByName ?? person(s.reconciliation?.countedBy)}</span></span> },
                { header: t('doc.expectedCash'), num: true, cell: (s) => <span className="money">{peso(s.reconciliation?.expectedCash)}</span> },
                { header: t('doc.countedCash'), num: true, cell: (s) => <span className="money">{peso(s.reconciliation?.countedCash)}</span> },
                { header: t('doc.variance'), num: true, cell: (s) => difference(s.reconciliation?.variance ?? '0') },
                { header: <span className="sr-only">{t('common.actions')}</span>, num: true, cell: (s) => <div className="flex flex-wrap items-start justify-end gap-2">{open(s)}{approve(s)}</div> },
              ]}
              stacked={{
                title: (s) => where(s),
                figure: (s) => difference(s.reconciliation?.variance ?? '0'),
                meta: (s) => (
                  <>
                    <Serial>{s.openedByName ?? person(s.openedBy)} · {formatDateTime(s.closedAt, lang)}</Serial>
                    <span className="mt-1 block text-[0.875rem] text-muted">{t('doc.expectedCash')} {peso(s.reconciliation?.expectedCash)} · {t('doc.countedCash')} {peso(s.reconciliation?.countedCash)}</span>
                    <div className="mt-2 flex flex-wrap gap-2">{open(s)}{approve(s)}</div>
                  </>
                ),
              }}
            />
          ) : (
            <Empty>{waiting ? t('drawers.noneWaiting') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      {/* Shifts open at a till now, newest first: who is on which register. */}
      <section aria-labelledby="open-now">
        <h2 id="open-now" className="section-title mb-3">{t('drawers.openNow')}</h2>
        <Note className="pr-2">
          {openNow && openNow.data.length > 0 ? (
            <RecordTable
              rows={openNow.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('drawers.register'), cell: (s) => <Link href={`/shifts/${s.id}`} className="serial underline">{where(s)}</Link> },
                { header: t('drawers.cashier'), cell: (s) => s.openedByName ?? person(s.openedBy) },
                { header: t('drawers.openedAt'), cell: (s) => <span className="text-muted">{formatDateTime(s.openedAt, lang)}</span> },
                { header: t('doc.openingFloat'), num: true, cell: (s) => <span className="money">{peso(s.openingFloat)}</span> },
              ]}
              stacked={{
                title: (s) => <Link href={`/shifts/${s.id}`} className="underline">{where(s)}</Link>,
                meta: (s) => <Serial>{s.openedByName ?? person(s.openedBy)} · {formatDateTime(s.openedAt, lang)}</Serial>,
                figure: (s) => <span className="money">{peso(s.openingFloat)}</span>,
              }}
            />
          ) : (
            <Empty>{openNow ? t('drawers.noneOpen') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section aria-labelledby="recent">
        <h2 id="recent" className="section-title mb-3">{t('drawers.recent')}</h2>
        <Note className="pr-2">
          {recent.length > 0 ? (
            <RecordTable
              rows={recent}
              rowKey={(s) => s.id}
              columns={[
                { header: t('drawers.register'), cell: (s) => <><Link href={`/shifts/${s.id}`} className="serial underline">{where(s)}</Link><span className="block text-[0.8125rem] text-muted">{s.openedByName ?? person(s.openedBy)}</span></> },
                { header: t('drawers.countedAt'), cell: (s) => <span className="text-muted">{formatDateTime(s.closedAt, lang)}</span> },
                { header: t('doc.variance'), num: true, cell: (s) => difference(s.reconciliation?.variance ?? '0') },
                {
                  header: t('doc.approvedBy'),
                  cell: (s) =>
                    s.reconciliation?.approvedBy ? (
                      <>{s.reconciliation.approvedByName ?? person(s.reconciliation.approvedBy)}{s.reconciliation.approvalNote && <span className="block text-[0.8125rem] text-muted">{s.reconciliation.approvalNote}</span>}</>
                    ) : (
                      <span className="text-muted">{t('doc.noApproval')}</span>
                    ),
                },
              ]}
              stacked={{
                title: (s) => <Link href={`/shifts/${s.id}`} className="underline">{where(s)}</Link>,
                meta: (s) => <Serial>{s.openedByName ?? person(s.openedBy)} · {formatDateTime(s.closedAt, lang)}</Serial>,
                figure: (s) => difference(s.reconciliation?.variance ?? '0'),
              }}
            />
          ) : (
            <Empty>{t('drawers.noneRecent')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
