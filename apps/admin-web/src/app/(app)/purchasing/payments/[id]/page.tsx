import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Callout, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { Figure } from '@/components/scope';
import { api, apiOrNull, type Branch, type Me, type SupplierPayment } from '@/lib/api';
import { formatDate, formatDateTime, peso } from '@/lib/format';
import { branchLabel, docNo, isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('purchasing.payments.item');

/**
 * One supplier payment (session 22): the invoices it settles, its journal entry, and voiding it when it
 * was recorded by mistake (the entry is reversed; the invoices are open again by its amounts).
 */
export default async function SupplierPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [me, payment, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<SupplierPayment>(`/supplier-payments/${id}`),
    apiOrNull<{ data: Branch[] }>('/branches'),
  ]);
  if (!payment) notFound();
  const canVoid = (me.activeTenant?.permissions ?? []).includes('accounting.post') && payment.status === 'RECORDED' && !me.support;
  const books = (entryId: string) => `/books/entries/${entryId}?entity=${payment.legalEntityId}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/purchasing/invoices?entity=${payment.legalEntityId}`} className="text-[0.875rem] text-muted underline">{t('ap.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('ap.paymentTitle', { n: docNo(payment.paymentNumber) })}</h1>
        <Serial className="mt-1 block">
          <Link href={`/purchasing/suppliers/${payment.supplier.id}`} className="font-semibold text-gold underline">{payment.supplier.code}</Link> · {payment.supplier.name} · {branchLabel(branches?.data, payment.branchId)} · <span className={`tag ${payment.status === 'VOIDED' ? 'tag-bad' : ''}`}>{t(`ap.status.${payment.status}`)}</span>
        </Serial>
      </div>

      {payment.status === 'VOIDED' && payment.voidedAt && <Callout>{t('ap.voided', { date: formatDateTime(payment.voidedAt, lang), reason: payment.voidReason ?? '' })}</Callout>}

      <Note denom="green" className="grid grid-cols-2 gap-4 px-5 py-4 pr-8 sm:grid-cols-4">
        <Figure label={t('ap.amount')}>{peso(payment.amount)}</Figure>
        <Figure label={t('ap.paidOn')}>{formatDate(payment.paidOn, lang)}</Figure>
        <Figure label={t('ap.method')}>{t(`ap.method.${payment.method}`)}</Figure>
        <Figure label={t('ap.reference')}>{payment.reference ?? '—'}</Figure>
      </Note>

      <div className="flex flex-wrap items-start gap-2">
        {payment.journalEntryId && <Link href={books(payment.journalEntryId)} className="btn">{t('common.journalEntry')}</Link>}
        {payment.reversalEntryId && <Link href={books(payment.reversalEntryId)} className="btn">{t('ap.reversal')}</Link>}
        {canVoid && <ReasonAction url={`/api/v1/supplier-payments/${payment.id}/void`} label={t('ap.voidPayment')} reasonLabel={t('common.reason')} hint={t('ap.voidHint')} danger idempotent />}
      </div>

      <section>
        <h2 className="section-title mb-3">{t('ap.settles')}</h2>
        <Note denom="gold" className="pr-2">
          <RecordTable
            rows={payment.allocations}
            rowKey={(a) => a.supplierInvoiceId}
            columns={[
              { header: t('ap.invoiceNo'), cell: (a) => <Link href={`/purchasing/invoices/${a.supplierInvoiceId}`} className="serial font-semibold text-gold underline">{a.invoiceNumber}</Link> },
              { header: t('common.branch'), cell: (a) => <Serial className="text-ink">{branchLabel(branches?.data, a.branchId)}</Serial> },
              { header: t('ap.amount'), num: true, cell: (a) => <span className="money font-semibold">{peso(a.amount)}</span> },
            ]}
            stacked={{
              title: (a) => <Link href={`/purchasing/invoices/${a.supplierInvoiceId}`} className="underline">{a.invoiceNumber}</Link>,
              meta: (a) => <Serial>{branchLabel(branches?.data, a.branchId)}</Serial>,
              figure: (a) => <span className="money font-semibold">{peso(a.amount)}</span>,
            }}
          />
        </Note>
      </section>
    </div>
  );
}
