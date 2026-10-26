import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { api, apiOrNull, type Branch, type CashierSessionRow, type Me, type Register, type SupplierInvoice } from '@/lib/api';
import { formatDate, formatDateTime, peso, signOf } from '@/lib/format';
import { branchLabel, docNo, drawerOptions, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { NoteForm, PaymentForm } from '../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('purchasing.invoices.item');

/** One supplier invoice: amounts, the receipts it covers, its payments and entries; pay or cancel. */
export default async function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, invoice, branches, openShifts, registers] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<SupplierInvoice>(`/supplier-invoices/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
    // Shifts whose drawer can pay in cash (listed only to people who may see them).
    apiOrNull<{ data: CashierSessionRow[] }>('/cashier-sessions?status=OPEN'),
    apiOrNull<{ data: Register[] }>('/registers'),
  ]);
  if (!invoice) notFound();
  const permissions = me.activeTenant?.permissions ?? [];
  const canPay = permissions.includes('accounting.post') && invoice.status === 'OPEN';
  const canEnter = permissions.includes('purchasing.manage') || permissions.includes('accounting.post');
  // An invoice with notes is not cancelled (a wrong note is corrected by an opposite one).
  const canCancel = canEnter && invoice.status === 'OPEN' && signOf(invoice.paidAmount) === 0 && invoice.adjustments.length === 0;
  const canNote = canEnter && invoice.status !== 'CANCELLED';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: branches?.data.find((b) => b.id === invoice.branchId)?.timezone ?? 'Asia/Manila' }).format(new Date());
  const books = (entryId: string) => `/books/entries/${entryId}?entity=${invoice.legalEntityId}`;
  /** What a payment settles of this invoice, and the whole payment when it also settles others. */
  const paymentAmount = (p: SupplierInvoice['payments'][number]) => (
    <span className={`money font-semibold ${p.status === 'VOIDED' ? 'line-through' : ''}`}>
      {peso(p.amount)}
      {p.paymentAmount !== p.amount && <span className="block text-[0.75rem] font-normal text-muted">{t('ap.ofPayment', { amount: peso(p.paymentAmount) })}</span>}
    </span>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/purchasing/invoices?entity=${invoice.legalEntityId}`} className="text-[0.875rem] text-muted underline">{t('ap.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('ap.invoiceTitle', { n: invoice.invoiceNumber })}</h1>
        <Serial className="mt-1 block">
          <Link href={`/purchasing/suppliers/${invoice.supplier.id}`} className="font-semibold text-gold underline">{invoice.supplier.code}</Link> · {invoice.supplier.name} · {branchLabel(branches?.data, invoice.branchId)} · {t('ap.entryNo')} {docNo(invoice.entryNumber)} · <span className="tag">{t(`ap.status.${invoice.status}`)}</span>
        </Serial>
      </div>

      {invoice.status === 'CANCELLED' && invoice.cancelledAt && (
        <Callout>{t('ap.cancelled', { date: formatDateTime(invoice.cancelledAt, lang), reason: invoice.cancelReason ?? '' })}</Callout>
      )}

      <Note denom="gold" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <Figure label={t('ap.invoiceDate')}>{formatDate(invoice.invoiceDate, lang)}</Figure>
        <Figure label={t('ap.dueDate')}>{formatDate(invoice.dueDate, lang)}</Figure>
        <Figure label={t('ap.net')}>{peso(invoice.netAmount)}</Figure>
        <Figure label={t('ap.vat')}>{peso(invoice.vatAmount)}</Figure>
        <Figure label={t('ap.total')}>{peso(invoice.totalAmount)}</Figure>
        {signOf(invoice.creditedAmount) !== 0 && <Figure label={t('ap.credited')}>−{peso(invoice.creditedAmount)}</Figure>}
        {signOf(invoice.debitedAmount) !== 0 && <Figure label={t('ap.debited')}>{peso(invoice.debitedAmount)}</Figure>}
        <Figure label={t('ap.paid')}>{peso(invoice.paidAmount)}</Figure>
        <Figure label={t('ap.balance')} tone={invoice.status === 'OPEN' ? 'red' : undefined}>{peso(invoice.balance)}</Figure>
      </Note>

      <Note denom="ink" className="grid grid-cols-1 gap-4 px-5 py-4 pr-8 sm:grid-cols-3">
        <Figure label={t('ap.matched')}>{peso(invoice.matchedAmount)}</Figure>
        <Figure label={t('ap.inputVat')}>{peso(invoice.inputVat)}</Figure>
        <div>
          <Figure label={t('ap.variance')}>{peso(invoice.priceVariance)}</Figure>
          <p className="mt-1 text-[0.8125rem] text-muted">{t('ap.varianceHint')}</p>
        </div>
      </Note>

      {invoice.notes && <p className="text-[0.875rem]"><span className="text-muted">{t('common.notes')}:</span> {invoice.notes}</p>}

      <div className="flex flex-wrap items-start gap-2">
        {invoice.journalEntryId && <Link href={books(invoice.journalEntryId)} className="btn">{t('common.journalEntry')}</Link>}
        {invoice.reversalEntryId && <Link href={books(invoice.reversalEntryId)} className="btn">{t('ap.reversal')}</Link>}
        {canPay && <PaymentForm invoiceId={invoice.id} balance={invoice.balance} today={today} drawers={drawerOptions(openShifts?.data, registers?.data, branches?.data, (amount) => t('ap.inDrawer', { amount }), [invoice.branchId])} />}
        {canNote && <NoteForm invoiceId={invoice.id} today={today} />}
        {canCancel && (
          <ReasonAction url={`/api/v1/supplier-invoices/${invoice.id}/cancel`} label={t('ap.cancel')} reasonLabel={t('common.reason')} hint={t('ap.cancelHint')} danger idempotent />
        )}
      </div>

      <section>
        <h2 className="section-title mb-3">{t('ap.receipts')}</h2>
        <Note denom="gold" className="pr-2">
          <ul>
            {invoice.receipts.map((r) => (
              <li key={r.goodsReceiptId} className={`flex flex-wrap items-center justify-between gap-2 border-b border-hair-soft px-4 py-3 last:border-b-0 ${r.active ? '' : 'text-muted'}`}>
                <Link href={`/purchasing/receipts/${r.goodsReceiptId}`} className="font-semibold underline">{t('pur.receiptTitle', { n: docNo(r.receiptNumber) })}</Link>
                <span className="money">{peso(r.matchedAmount)}</span>
              </li>
            ))}
          </ul>
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('ap.payments')}</h2>
        <Note denom="green" className="pr-2">
          {invoice.payments.length > 0 ? (
            <RecordTable
              rows={invoice.payments}
              rowKey={(p) => p.id}
              columns={[
                { header: t('ap.paymentNo'), cell: (p) => <Link href={`/purchasing/payments/${p.id}`} className="serial font-semibold underline">{docNo(p.paymentNumber)}</Link> },
                { header: t('ap.paidOn'), cell: (p) => formatDate(p.paidOn, lang) },
                { header: t('ap.method'), cell: (p) => t(`ap.method.${p.method}`) },
                { header: t('ap.reference'), cell: (p) => <span className="text-muted">{p.reference ?? ''}</span> },
                { header: t('common.status'), cell: (p) => <span className={`tag ${p.status === 'VOIDED' ? 'tag-bad' : ''}`}>{t(`ap.status.${p.status}`)}</span> },
                { header: t('ap.amount'), num: true, cell: (p) => paymentAmount(p) },
              ]}
              dimmed={(p) => p.status === 'VOIDED'}
              stacked={{
                title: (p) => <Link href={`/purchasing/payments/${p.id}`} className="underline">{`${t('ap.paymentNo')} ${docNo(p.paymentNumber)}`}</Link>,
                meta: (p) => <Serial>{formatDate(p.paidOn, lang)} · {t(`ap.method.${p.method}`)}{p.reference ? ` · ${p.reference}` : ''} · {t(`ap.status.${p.status}`)}</Serial>,
                figure: (p) => paymentAmount(p),
              }}
            />
          ) : (
            <Empty>{t('ap.noPayments')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('ap.notes')}</h2>
        <Note denom="ink" className="pr-2">
          {invoice.adjustments.length > 0 ? (
            <RecordTable
              rows={invoice.adjustments}
              rowKey={(n) => n.id}
              columns={[
                { header: t('ap.entryNo'), cell: (n) => <Link href={`/books?entity=${invoice.legalEntityId}&source=${n.id}`} className="serial font-semibold underline">{docNo(n.entryNumber)}</Link> },
                { header: t('ap.noteKind'), cell: (n) => <span className="tag">{t(`ap.noteKindShort.${n.kind}`)}</span> },
                { header: t('ap.noteNo'), cell: (n) => <Serial className="text-ink">{n.noteNumber}</Serial> },
                { header: t('ap.noteDate'), cell: (n) => formatDate(n.noteDate, lang) },
                { header: t('common.reason'), cell: (n) => <span className="text-muted">{n.reason}</span> },
                { header: t('ap.grniCleared'), num: true, cell: (n) => <span className="money">{signOf(n.grniCleared) !== 0 ? peso(n.grniCleared) : ''}</span> },
                { header: t('ap.amount'), num: true, cell: (n) => <span className="money font-semibold">{n.kind === 'CREDIT' ? '−' : ''}{peso(n.totalAmount)}</span> },
              ]}
              stacked={{
                title: (n) => `${t(`ap.noteKindShort.${n.kind}`)} ${n.noteNumber}`,
                meta: (n) => <Serial>{formatDate(n.noteDate, lang)} · {n.reason}</Serial>,
                figure: (n) => <span className="money font-semibold">{n.kind === 'CREDIT' ? '−' : ''}{peso(n.totalAmount)}</span>,
              }}
            />
          ) : (
            <Empty>{t('ap.noNotes')}</Empty>
          )}
        </Note>
        {invoice.adjustments.length > 0 && invoice.status !== 'CANCELLED' && <p className="mt-2 text-[0.8125rem] text-muted">{t('ap.notesHasHint')}</p>}
      </section>
    </div>
  );
}

