import Link from 'next/link';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import type { PrescriptionBook } from '@/lib/api';
import { formatDate, qty } from '@/lib/format';
import { genericLabel } from '@/lib/pharmacy';
import { getT } from '@/i18n/server';
import { DrugBadge } from '../../products/drug-fields';
import { loadReport } from '../../reports/chrome';
import { BookRangeForm, PharmacyChrome, bookRange, pharmacyBranch } from '../chrome';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.prescription-book');

/**
 * The prescription book (ADR-0025 §10): every medicine dispensed against a prescription at the branch
 * in the range, oldest first, with the patient, the prescriber and their licences, the brand given
 * and the pharmacist. For printing and filing; CSV for a spreadsheet.
 */
export default async function PrescriptionBookPage({ searchParams }: { searchParams: Promise<{ branch?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await pharmacyBranch(sp.branch);
  const { from, to } = bookRange(sp);
  const r = branch ? await loadReport<PrescriptionBook>(`/reports/prescription-book?branchId=${branch.id}&from=${from}&to=${to}`) : null;
  const rows = r?.data?.data ?? [];
  return (
    <PharmacyChrome tab="book" branches={branches} branch={branch} extra={{ from, to }}>
      {branch && <BookRangeForm tab="book" branch={branch} from={from} to={to} report="prescriptionBook" />}
      <p className="max-w-[68ch] text-[0.875rem] text-muted print:hidden">{t('pha.bookLede')}</p>
      {r?.error ? (
        <Callout tone="error">{r.error}</Callout>
      ) : (
        <Note denom="ink" className="pr-2">
          {rows.length ? (
            <RecordTable
              rows={rows}
              rowKey={(x) => `${x.saleId}:${x.prescriptionId}:${x.genericName}:${x.quantity}:${x.returned}`}
              columns={[
                { header: t('common.date'), cell: (x) => <Serial className="text-ink">{formatDate(x.day, lang)}</Serial> },
                { header: t('pha.sale'), cell: (x) => <Link href={`/sales/${x.saleId}`} className="serial underline">{x.saleReference}</Link> },
                { header: t('pha.patient'), cell: (x) => <Link href={`/pharmacy/prescriptions/${x.prescriptionId}`} className="font-semibold underline" data-book-row>{x.patientName}</Link> },
                { header: t('pha.prescriber'), cell: (x) => <>{x.prescriberName}<Serial className="block">{t('pha.prcShort', { no: x.prescriberLicenseNo })}{x.prescriberS2No && ` · S2 ${x.prescriberS2No}`}{x.yellowFormNo && ` · ${t('pha.yellowShort', { no: x.yellowFormNo })}`}</Serial></> },
                { header: t('pha.medicine'), cell: (x) => <>{genericLabel(t, x)} <DrugBadge drugClass={x.drugClass} /><span className="block text-[0.8125rem] text-muted">{x.brand}</span></> },
                { header: t('common.quantity'), num: true, cell: (x) => <b>{qty(x.quantity)}</b> },
                { header: t('pha.pharmacist'), cell: (x) => <>{x.pharmacist ?? '—'}{x.returned && <span className="tag ml-1">{t('pha.returned')}</span>}{x.needsReview && <span className="tag tag-warn ml-1">{t('pha.needsReview')}</span>}</> },
              ]}
              stacked={{
                title: (x) => <Link href={`/pharmacy/prescriptions/${x.prescriptionId}`} className="underline">{x.patientName}</Link>,
                meta: (x) => <Serial>{formatDate(x.day, lang)} · {x.saleReference} · {genericLabel(t, x)} · {x.brand}{x.returned ? ` · ${t('pha.returned')}` : ''}</Serial>,
                figure: (x) => <b>{qty(x.quantity)}</b>,
              }}
            />
          ) : (
            <Empty>{t('pha.bookEmpty')}</Empty>
          )}
        </Note>
      )}
      <p className="max-w-[68ch] text-[0.8125rem] text-muted">{t('pha.healthData')}</p>
    </PharmacyChrome>
  );
}
