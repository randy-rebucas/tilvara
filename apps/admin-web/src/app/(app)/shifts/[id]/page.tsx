import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Branch, type CashierSession, type Member, type Register, type Sale } from '@/lib/api';
import { formatDateTime, peso, signed, signOf } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Shift' };

/** A cashier shift: the drawer from float to count, its pay-ins and pay-outs, the variance and its approval, and its sales. */
export default async function ShiftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [shift, sales, branches, registers, members] = await Promise.all([
    apiOrNull<CashierSession>(`/cashier-sessions/${id}`),
    apiOrNull<{ data: Sale[] }>(`/sales?cashierSessionId=${id}&limit=200`),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: Register[] }>('/registers'),
    apiOrNull<{ data: Member[] }>('/members'),
  ]);
  if (!shift) notFound();
  const branch = branches?.data.find((b) => b.id === shift.branchId);
  const register = registers?.data.find((r) => r.id === shift.registerId);
  const person = (userId: string | null) => (userId ? members?.data.find((m) => m.user.id === userId)?.user.displayName ?? '—' : '—');
  const journal = (sourceId: string) => (branch ? `/books?entity=${branch.legalEntityId}&source=${sourceId}` : null);
  const rec = shift.reconciliation;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('doc.shiftTitle', { register: register ? `${register.code} ${register.name}` : '—' })}</h1>
        <Serial className="mt-1 block">
          {branch?.code ?? '—'} · {person(shift.openedBy)} · {formatDateTime(shift.openedAt, lang)}{shift.closedAt && ` – ${formatDateTime(shift.closedAt, lang)}`}
        </Serial>
      </div>

      <Note className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
        <div>
          <div className="text-[0.8125rem] text-muted">{t('common.status')}</div>
          <span className="tag mt-1">{t(`doc.shift.${shift.status}` as MessageKey)}</span>
        </div>
        <Figure label={t('doc.openingFloat')}>{peso(shift.openingFloat)}</Figure>
        <Figure label={t('doc.salesTotal', { n: shift.sales.count })}>{peso(shift.sales.total)}</Figure>
        <Figure label={t('doc.expectedCash')}>{peso(rec?.expectedCash ?? shift.expectedCash)}</Figure>
      </Note>

      {rec && (
        <section>
          <h2 className="section-title mb-3">{t('doc.count')}</h2>
          <Note className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-4">
            <Figure label={t('doc.countedCash')}>{peso(rec.countedCash)}</Figure>
            <div>
              <div className="text-[0.8125rem] text-muted">{t('doc.variance')}</div>
              <div className={`money mt-1 text-[1.25rem] font-semibold ${signOf(rec.variance) !== 0 ? 'text-red' : ''}`}>
                {signOf(rec.variance) === 0 ? peso('0') : signed(rec.variance, peso)} {signOf(rec.variance) < 0 ? t('doc.short') : signOf(rec.variance) > 0 ? t('doc.over') : ''}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[0.8125rem] text-muted">{t('doc.countedBy')}</div>
              <div className="mt-1">{person(rec.countedBy)}{rec.note && <span className="block text-[0.875rem] text-muted">{rec.note}</span>}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[0.8125rem] text-muted">{t('doc.approvedBy')}</div>
              <div className="mt-1">
                {rec.approvedBy ? `${person(rec.approvedBy)} · ${formatDateTime(rec.approvedAt, lang)}` : signOf(rec.variance) === 0 ? t('doc.noApproval') : t('doc.awaitingApproval')}
                {rec.approvalNote && <span className="block text-[0.875rem] text-muted">{rec.approvalNote}</span>}
              </div>
            </div>
          </Note>
          {signOf(rec.variance) !== 0 && journal(shift.id) && (
            <Link href={journal(shift.id)!} className="btn mt-3">{t('common.journalEntry')}</Link>
          )}
        </section>
      )}

      <section>
        <h2 className="section-title mb-3">{t('doc.payInOut')}</h2>
        <Note>
          {shift.payInOut.length > 0 ? (
            <ul>
              {shift.payInOut.map((m) => (
                <li key={m.id} id={`movement-${m.id}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <p className="font-semibold">{t(m.type === 'PAY_IN' ? 'doc.payIn' : 'doc.payOut')}: {m.reason ?? ''}</p>
                    <Serial>{person(m.createdBy)} · {formatDateTime(m.createdAt, lang)}</Serial>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="money font-semibold">{peso(m.amount)}</span>
                    {journal(m.id) && <Link href={journal(m.id)!} className="btn">{t('common.journalEntry')}</Link>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('doc.noPayInOut')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('doc.sales')}</h2>
        <Note className="pr-2">
          {sales && sales.data.length > 0 ? (
            <RecordTable
              rows={sales.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('doc.saleNo'), cell: (s) => <Link href={`/sales/${s.id}`} className="serial font-semibold underline">{docNo(s.saleNumber)}</Link> },
                { header: t('common.date'), cell: (s) => <span className="text-muted">{formatDateTime(s.completedAt, lang)}</span> },
                { header: t('doc.amountDue'), num: true, cell: (s) => <span className="money font-semibold">{peso(s.amountDue)}</span> },
              ]}
              stacked={{
                title: (s) => <Link href={`/sales/${s.id}`} className="serial underline">{docNo(s.saleNumber)}</Link>,
                meta: (s) => <Serial>{formatDateTime(s.completedAt, lang)}</Serial>,
                figure: (s) => <span className="money font-semibold">{peso(s.amountDue)}</span>,
              }}
            />
          ) : (
            <Empty>{sales ? t('doc.noSales') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
