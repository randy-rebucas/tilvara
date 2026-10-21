import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Callout, Note } from '@/components/note';
import { apiOrNull, type CustomerSummary, type Prescription } from '@/lib/api';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { PharmacyChrome, pharmacyAccess, pharmacyBranch } from '../../../chrome';
import { PrescriptionForm } from '../../../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.prescriptions.item.edit');

/** Correct a prescription while nothing is dispensed on it (the API refuses afterwards). */
export default async function EditPrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t } = await getT();
  const rx = await apiOrNull<Prescription>(`/prescriptions/${id}`);
  if (!rx) notFound();
  const { branches, branch } = await pharmacyBranch(rx.branchId);
  const { canDispense, canCustomers } = await pharmacyAccess();
  const customers = canCustomers ? await apiOrNull<{ data: CustomerSummary[] }>('/customers?limit=100') : null;
  const options = (customers?.data ?? []).filter((c) => !c.archivedAt && !c.anonymisedAt).map((c) => ({ id: c.id, label: `${c.displayName}${c.phone ? ` · ${c.phone}` : ''}` }));
  return (
    <PharmacyChrome tab="prescriptions" branches={branches} branch={branch}>
      <div>
        <Link href={`/pharmacy/prescriptions/${rx.id}`} className="text-[0.875rem] text-muted underline">{t('pha.backToRx')}</Link>
        <h2 className="mt-1 text-[1.0625rem] font-semibold">{t('pha.editRx')}</h2>
      </div>
      {!canDispense || !rx.editable ? (
        <Callout>{rx.editable ? t('pha.cannotRecord') : t('pha.notEditable')}</Callout>
      ) : (
        <Note className="px-5 py-5 pr-8">
          <PrescriptionForm branchId={rx.branchId} prescription={rx} customers={options} />
        </Note>
      )}
    </PharmacyChrome>
  );
}
