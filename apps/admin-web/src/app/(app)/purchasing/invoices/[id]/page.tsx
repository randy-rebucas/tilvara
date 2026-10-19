import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { api, apiOrNull, type Branch, type Me, type SupplierInvoice } from '@/lib/api';
import { formatDate, formatDateTime, peso, signOf } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { PaymentForm } from '../forms';

export const metadata = { title: 'Supplier invoice' };

/** One supplier invoice: amounts, the receipts it covers, its payments and entries; pay or cancel. */
export default async function SupplierInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, invoice, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<SupplierInvoice>(`/supplier-invoices/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!invoice) notFound();
  const permissions = me.activeTenant?.permissions ?? [];
  const canPay = permissions.includes('accounting.post') && invoice.status === 'OPEN';
  const canCancel = (permissions.includes('purchasing.manage') || permissions.includes('accounting.post')) && invoice.status === 'OPEN' && signOf(invoice.paidAmount) === 0;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: branches?.data.find((b) => b.id === invoice.branchId)?.timezone ?? 'Asia/Manila' }).format(new Date());
  const books = (entryId: string) => `/books/entries/${entryId}?entity=${invoice.legalEntityId}`;

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
        {canPay && <PaymentForm invoiceId={invoice.id} balance={invoice.balance} today={today} />}
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
                { header: t('ap.paymentNo'), cell: (p) => <Link href={`/books?entity=${invoice.legalEntityId}&source=${p.id}`} className="serial font-semibold underline">{docNo(p.paymentNumber)}</Link> },
                { header: t('ap.paidOn'), cell: (p) => formatDate(p.paidOn, lang) },
                { header: t('ap.method'), cell: (p) => t(`ap.method.${p.method}`) },
                { header: t('ap.reference'), cell: (p) => <span className="text-muted">{p.reference ?? ''}</span> },
                { header: t('ap.amount'), num: true, cell: (p) => <span className="money font-semibold">{peso(p.amount)}</span> },
              ]}
              stacked={{
                title: (p) => `${t('ap.paymentNo')} ${docNo(p.paymentNumber)}`,
                meta: (p) => <Serial>{formatDate(p.paidOn, lang)} · {t(`ap.method.${p.method}`)}{p.reference ? ` · ${p.reference}` : ''}</Serial>,
                figure: (p) => <span className="money font-semibold">{peso(p.amount)}</span>,
              }}
            />
          ) : (
            <Empty>{t('ap.noPayments')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
