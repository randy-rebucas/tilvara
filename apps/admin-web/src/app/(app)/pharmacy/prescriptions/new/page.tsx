import { Callout, Note } from '@/components/note';
import { apiOrNull, type CustomerSummary } from '@/lib/api';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { PharmacyChrome, pharmacyAccess, pharmacyBranch } from '../../chrome';
import { PrescriptionForm } from '../../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('pharmacy.prescriptions.new');

/** Record a prescription before the patient comes to the counter (ADR-0025 §6); the till fills it later. */
export default async function NewPrescriptionPage({ searchParams }: { searchParams: Promise<{ branch?: string; customer?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await pharmacyBranch(sp.branch);
  const { canDispense, canCustomers } = await pharmacyAccess();
  const customers = canCustomers ? await apiOrNull<{ data: CustomerSummary[] }>('/customers?limit=100') : null;
  const options = (customers?.data ?? []).filter((c) => !c.archivedAt && !c.anonymisedAt).map((c) => ({ id: c.id, label: `${c.displayName}${c.phone ? ` · ${c.phone}` : ''}` }));
  return (
    <PharmacyChrome tab="prescriptions" branches={branches} branch={branch}>
      <h2 className="text-[1.0625rem] font-semibold">{t('pha.newRx')}</h2>
      {!canDispense ? (
        <Callout>{t('pha.cannotRecord')}</Callout>
      ) : (
        <Note className="px-5 py-5 pr-8">
          <PrescriptionForm branchId={branch!.id} customers={options} customerId={sp.customer && isUuid(sp.customer) ? sp.customer : undefined} />
        </Note>
      )}
    </PharmacyChrome>
  );
}
