import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Prescription } from '@/lib/api';
import { formatDate, formatDateTime, qty, signOf } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { genericLabel } from '@/lib/pharmacy';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { DrugBadge } from '../../../products/drug-fields';
import { PharmacyChrome, PrescriptionTag, pharmacyAccess, pharmacyBranch } from '../../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.prescriptions.item');

/**
 * One prescription (ADR-0025 §6): who it is for and who wrote it, what it orders with what was
 * dispensed and what is left, and each fill with its sale. Edited while nothing is dispensed;
 * voided (with a reason) only then too.
 */
export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const rx = await apiOrNull<Prescription>(`/prescriptions/${id}`);
  if (!rx) notFound();
  const { branches, branch } = await pharmacyBranch(rx.branchId);
  const { canDispense } = await pharmacyAccess();
  const nothingDispensed = rx.items.every((i) => signOf(i.dispensed) <= 0);
  const canVoid = canDispense && rx.status !== 'VOIDED' && nothingDispensed;
  const item = (itemId: string) => rx.items.find((i) => i.id === itemId);
  const row = (label: string, value: ReactNode) => (
    <div><dt className="text-[0.8125rem] text-muted">{label}</dt><dd>{value || '—'}</dd></div>
  );

  return (
    <PharmacyChrome tab="prescriptions" branches={branches} branch={branch}>
      <div>
        <Link href={`/pharmacy?branch=${rx.branchId}`} className="text-[0.875rem] text-muted underline">{t('pha.tab.prescriptions')}</Link>
        <h2 className="mt-1 flex flex-wrap items-center gap-2 text-[1.375rem] font-bold leading-tight" data-testid="rx-title">
          {rx.patientName} <PrescriptionTag status={rx.status} label={t(`pha.status.${rx.status}` as MessageKey)} />
        </h2>
        <Serial className="mt-1 block">
          {rx.branchName} · {t('pha.issuedOn')} {formatDate(rx.issuedOn, lang)} · {t(`pha.source.${rx.source}` as MessageKey)} · {t('pha.recordedAt', { at: formatDateTime(rx.createdAt, lang) })}
        </Serial>
      </div>

      {rx.voidedAt && <Callout tone="warn">{t('pha.voidedNote', { at: formatDateTime(rx.voidedAt, lang), reason: rx.voidReason ?? '' })}</Callout>}

      {(canVoid || (rx.editable && canDispense)) && (
        <div className="flex flex-wrap items-start gap-2">
          {rx.editable && canDispense && <Link href={`/pharmacy/prescriptions/${rx.id}/edit`} className="btn">{t('pha.editRx')}</Link>}
          {canVoid && <ReasonAction url={`/api/v1/prescriptions/${rx.id}/void`} label={t('pha.voidRx')} reasonLabel={t('common.reason')} hint={t('pha.voidHint')} danger />}
        </div>
      )}

      <Note className="px-5 py-4 pr-8">
        <dl className="grid gap-3 text-[0.9375rem] sm:grid-cols-2 lg:grid-cols-3">
          {row(t('pha.patient'), rx.patientName)}
          {row(t('pha.patientAddress'), rx.patientAddress)}
          {row(t('pha.customer'), rx.customerId ? <Link href={`/customers/${rx.customerId}`} className="underline">{rx.customerName ?? t('doc.customer')}</Link> : null)}
          {row(t('pha.prescriber'), rx.prescriberName)}
          {row(t('pha.prcNo'), <Serial className="text-ink">{rx.prescriberLicenseNo}</Serial>)}
          {row(t('pha.s2No'), rx.prescriberS2No ? <Serial className="text-ink">{rx.prescriberS2No}</Serial> : null)}
          {row(t('pha.yellowForm'), rx.yellowFormNo ? <Serial className="text-ink">{rx.yellowFormNo}</Serial> : null)}
          {rx.notes && <div className="sm:col-span-2 lg:col-span-3">{row(t('common.notes'), rx.notes)}</div>}
        </dl>
      </Note>

      <section aria-labelledby="rx-items" className="flex flex-col gap-3">
        <h3 id="rx-items" className="section-title">{t('pha.itemsSection')}</h3>
        <Note className="pr-2">
          <RecordTable
            rows={rx.items}
            rowKey={(i) => i.id}
            columns={[
              { header: t('pha.medicine'), cell: (i) => <><b data-rx-item-name>{genericLabel(t, i)}</b>{i.directions && <span className="block text-[0.8125rem] text-muted">{i.directions}</span>}</> },
              { header: t('drug.class'), cell: (i) => <DrugBadge drugClass={i.drugClass} /> },
              { header: t('pha.prescribed'), num: true, cell: (i) => qty(i.quantity) },
              { header: t('pha.dispensed'), num: true, cell: (i) => qty(i.dispensed) },
              { header: t('pha.left'), num: true, cell: (i) => <b data-rx-left>{qty(i.left)}</b> },
            ]}
            stacked={{
              title: (i) => genericLabel(t, i),
              meta: (i) => <><DrugBadge drugClass={i.drugClass} /> <Serial>{t('pha.dispensedOfN', { done: qty(i.dispensed), of: qty(i.quantity) })}</Serial>{i.directions && <span className="block text-[0.8125rem] text-muted">{i.directions}</span>}</>,
              figure: (i) => <span>{t('pha.leftN', { n: qty(i.left) })}</span>,
            }}
          />
        </Note>
      </section>

      <section aria-labelledby="rx-fills" className="flex flex-col gap-3">
        <h3 id="rx-fills" className="section-title">{t('pha.fills')}</h3>
        <Note className="pr-2">
          {rx.fills.length ? (
            <RecordTable
              rows={rx.fills}
              rowKey={(f) => f.id}
              columns={[
                { header: t('common.date'), cell: (f) => <Serial className="text-ink">{formatDateTime(f.at, lang)}</Serial> },
                { header: t('pha.sale'), cell: (f) => <Link href={`/sales/${f.saleId}`} className="serial font-semibold underline" data-fill-sale>{f.reference}</Link> },
                { header: t('pha.medicine'), cell: (f) => { const i = item(f.itemId); return i ? genericLabel(t, i) : '—'; } },
                { header: t('common.quantity'), num: true, cell: (f) => qty(f.quantity) },
                { header: t('pha.pharmacist'), cell: (f) => f.dispensedBy ?? '—' },
                { header: '', cell: (f) => <>{f.returned && <span className="tag">{t('pha.returned')}</span>}{f.needsReview && <span className="tag tag-warn ml-1">{t('pha.needsReview')}</span>}</> },
              ]}
              stacked={{
                title: (f) => <Link href={`/sales/${f.saleId}`} className="underline">{f.reference}</Link>,
                meta: (f) => <Serial>{formatDateTime(f.at, lang)} · {f.dispensedBy ?? '—'}{f.returned ? ` · ${t('pha.returned')}` : ''}{f.needsReview ? ` · ${t('pha.needsReview')}` : ''}</Serial>,
                figure: (f) => qty(f.quantity),
              }}
            />
          ) : (
            <Empty>{t('pha.noFills')}</Empty>
          )}
        </Note>
        <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('pha.healthData')}</p>
      </section>
    </PharmacyChrome>
  );
}
