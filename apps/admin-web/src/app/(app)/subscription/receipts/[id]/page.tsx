import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Note, Serial } from '@/components/note';
import { PrintButton } from '@/components/print-button';
import { apiOrNull, type BillingReceipt } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { en, type MessageKey } from '@/i18n/messages';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('subscription.receipts.item');

/**
 * A system-generated receipt for a subscription payment (ADR-0027), as issued: Tilvara's and the business's
 * details as they were that day. The same receipt was mailed to the owners; Print saves it as PDF too.
 */
export default async function BillingReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const r = await apiOrNull<BillingReceipt>(`/subscription/receipts/${id}`);
  if (!r) notFound();
  const methodKey = `rcpt.method.${r.method}`;
  const method = methodKey in en ? t(methodKey as MessageKey) : r.method;
  const row = (label: string, value: string | null | undefined) =>
    value ? (
      <div className="flex justify-between gap-4">
        <dt className="text-muted">{label}</dt>
        <dd className="text-right">{value}</dd>
      </div>
    ) : null;

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <Link href="/subscription" className="text-[0.875rem] text-muted underline">{t('rcpt.back')}</Link>
          <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{t('rcpt.title', { number: r.number })}</h1>
        </div>
        <PrintButton />
      </div>

      <div data-testid="billing-receipt">
      <Note className="flex flex-col gap-5 px-6 py-6" as="article">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-dashed border-hair pb-4">
          <div>
            <div className="text-[1.25rem] font-bold">{r.seller.registeredName}</div>
            {r.seller.tradeName && <div className="text-[0.875rem]">{r.seller.tradeName}</div>}
            {r.seller.tin && <div className="text-[0.875rem]">{t(r.seller.vatRegistered ? 'rcpt.vatTin' : 'rcpt.tin')} {r.seller.tin}</div>}
            {r.seller.address && <div className="text-[0.875rem] text-muted">{r.seller.address}</div>}
          </div>
          <div className="text-right">
            <Serial className="block">{t('rcpt.receipt')}</Serial>
            <div className="serial text-[1.125rem] font-semibold">{r.number}</div>
            <div className="text-[0.875rem] text-muted">{formatDateTime(r.issuedAt, lang)}</div>
          </div>
        </header>

        <section>
          <Serial className="mb-1 block">{t('rcpt.to')}</Serial>
          <div className="font-semibold">{r.buyer.registeredName ?? r.buyer.businessName}</div>
          {r.buyer.registeredName && r.buyer.businessName !== r.buyer.registeredName && <div className="text-[0.875rem]">{r.buyer.businessName}</div>}
          {r.buyer.tin && <div className="text-[0.875rem]">{t('rcpt.tin')} {r.buyer.tin}</div>}
          {r.buyer.address && <div className="text-[0.875rem] text-muted">{r.buyer.address}</div>}
        </section>

        <section className="border-t border-dashed border-hair pt-4">
          <div className="flex justify-between gap-4">
            <span>{r.description}</span>
            <span className="tabular-nums">{peso(r.amount)}</span>
          </div>
          <dl className="mt-4 flex flex-col gap-1 text-[0.9375rem] tabular-nums">
            {r.seller.vatRegistered && row(t('rcpt.vatable'), peso(r.vatableAmount))}
            {r.seller.vatRegistered && row(t('rcpt.vat'), peso(r.vatAmount))}
            <div className="flex justify-between gap-4 border-t border-hair pt-2 text-[1.125rem] font-bold">
              <dt>{t('rcpt.total')}</dt>
              <dd>{peso(r.amount)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[0.875rem]">{t('rcpt.paidBy', { method, reference: r.reference })}</p>
        </section>

        <footer className="border-t border-dashed border-hair pt-3 text-[0.8125rem] text-muted">
          <p>{t('rcpt.system')}</p>
          {r.seller.permitNote && <p>{r.seller.permitNote}</p>}
        </footer>
      </Note>
      </div>
    </div>
  );
}
