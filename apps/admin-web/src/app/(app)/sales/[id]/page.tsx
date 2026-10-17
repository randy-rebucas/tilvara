import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { apiOrNull, type Branch, type Member, type Register, type Sale, type SaleReturnDoc } from '@/lib/api';
import { formatDateTime, peso, qty, signOf } from '@/lib/format';
import { docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';

export const metadata = { title: 'Sale' };

/** A sale as recorded: lines (with what came back), charges, tenders, and its returns and voids, each with its journal entry. */
export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [sale, returns, branches, registers, members] = await Promise.all([
    apiOrNull<Sale>(`/sales/${id}`),
    apiOrNull<{ data: SaleReturnDoc[] }>(`/sales/${id}/returns`),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: Register[] }>('/registers'),
    apiOrNull<{ data: Member[] }>('/members'),
  ]);
  if (!sale) notFound();
  const branch = branches?.data.find((b) => b.id === sale.branchId);
  const register = registers?.data.find((r) => r.id === sale.registerId);
  const person = (userId: string) => members?.data.find((m) => m.user.id === userId)?.user.displayName ?? '—';
  const lineName = (lineId: string) => sale.lines.find((l) => l.id === lineId)?.name ?? '—';
  const journal = (sourceId: string) => (branch ? `/books?entity=${branch.legalEntityId}&source=${sourceId}` : null);
  const anyReturned = sale.lines.some((l) => signOf(l.returnedQuantity) > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/shifts/${sale.cashierSessionId}`} className="text-[0.875rem] text-muted underline">{t('doc.shift')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('doc.saleTitle', { n: docNo(sale.saleNumber) })}</h1>
        <Serial className="mt-1 block">
          {branch?.code ?? '—'} · {register ? `${register.code} ${register.name}` : '—'} · {person(sale.cashierUserId)} · {formatDateTime(sale.completedAt, lang)}
          {sale.offlineReference && ` · ${t('doc.offline', { ref: sale.offlineReference })}`}
        </Serial>
      </div>

      <Note denom="none" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <Figure label={t('doc.amountDue')}>{peso(sale.amountDue)}</Figure>
        <Figure label={t('doc.vat')}>{peso(sale.vatAmount)}</Figure>
        <Figure label={t('doc.discounts')}>{peso(sale.discount)}</Figure>
        {journal(sale.id) && (
          <div className="self-end">
            <Link href={journal(sale.id)!} className="btn">{t('common.journalEntry')}</Link>
          </div>
        )}
      </Note>

      <Note denom="none" className="pr-2">
        <RecordTable
          rows={sale.lines}
          rowKey={(l) => l.id}
          columns={[
            { header: t('common.item'), cell: (l) => <span className={l.parentLineId ? 'pl-4 text-muted' : ''}>{l.name}</span> },
            { header: t('common.quantity'), num: true, cell: (l) => qty(l.quantity) },
            ...(anyReturned ? [{ header: t('doc.returned'), num: true, cell: (l: Sale['lines'][number]) => (signOf(l.returnedQuantity) > 0 ? qty(l.returnedQuantity) : '') }] : []),
            { header: t('doc.unitPrice'), num: true, cell: (l) => <span className="money">{peso(l.unitPrice)}</span> },
            { header: t('doc.amountDue'), num: true, cell: (l) => <span className="money font-semibold">{peso(l.amountDue)}</span> },
          ]}
          stacked={{
            title: (l) => l.name,
            meta: (l) => <Serial>{qty(l.quantity)} × {peso(l.unitPrice)}{signOf(l.returnedQuantity) > 0 && ` · ${t('doc.returned')} ${qty(l.returnedQuantity)}`}</Serial>,
            figure: (l) => <span className="money font-semibold">{peso(l.amountDue)}</span>,
          }}
        />
        {(sale.charges.length > 0 || sale.tenders.length > 0) && (
          <dl className="grid gap-1 border-t border-hair-soft px-4 py-3 text-[0.9375rem]">
            {sale.charges.map((c) => (
              <div key={c.id} className="flex justify-between gap-3"><dt>{t('doc.serviceCharge')}</dt><dd className="money">{peso(c.amountDue)}</dd></div>
            ))}
            {sale.tenders.map((tn) => (
              <div key={tn.id} className="flex justify-between gap-3 text-muted"><dt>{tn.method}</dt><dd className="money">{peso(tn.amount)}</dd></div>
            ))}
            {signOf(sale.changeDue) > 0 && <div className="flex justify-between gap-3 text-muted"><dt>{t('doc.change')}</dt><dd className="money">{peso(sale.changeDue)}</dd></div>}
          </dl>
        )}
      </Note>

      <section>
        <h2 className="section-title mb-3">{t('doc.returns')}</h2>
        {returns && returns.data.length > 0 ? (
          <div className="flex flex-col gap-3">
            {returns.data.map((r) => (
              <Note key={r.id} denom="none" className="px-4 py-3 pr-6" id={`return-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{t(r.kind === 'VOID' ? 'doc.voidTitle' : 'doc.returnTitle', { n: docNo(r.returnNumber) })}</p>
                    <p className="text-[0.9375rem]">{r.reason}</p>
                    <Serial>{person(r.processedBy)} · {formatDateTime(r.createdAt, lang)}</Serial>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="money font-semibold">{peso(`-${r.amountDue}`)}</span>
                    {journal(r.id) && <Link href={journal(r.id)!} className="btn">{t('common.journalEntry')}</Link>}
                  </div>
                </div>
                <ul className="mt-2 grid gap-0.5 text-[0.875rem] text-muted">
                  {r.lines.map((l) => (
                    <li key={l.id} className="flex justify-between gap-3">
                      <span>{qty(l.quantity)} × {lineName(l.saleLineId)} · {t(l.disposition === 'RESTOCK' ? 'doc.restocked' : 'doc.damaged')}</span>
                      <span className="money">{peso(l.amountDue)}</span>
                    </li>
                  ))}
                </ul>
              </Note>
            ))}
          </div>
        ) : (
          <Note denom="none"><Empty>{returns ? t('doc.noReturns') : t('common.noAccess')}</Empty></Note>
        )}
      </section>
    </div>
  );
}
