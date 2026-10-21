import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type PrescriptionRow } from '@/lib/api';
import { formatDate, qty } from '@/lib/format';
import { branchLabel } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { PrescriptionTag } from '../../pharmacy/chrome';

/**
 * A customer's prescriptions with something left to dispense (ADR-0025 §6), each linking to its
 * record. Health data: shown only to those who may read prescriptions (the API answers nothing otherwise).
 */
export async function CustomerPrescriptions({ customerId, branches, canRecord }: { customerId: string; branches: Branch[] | undefined; canRecord: boolean }) {
  const { t, lang } = await getT();
  const list = await apiOrNull<{ data: PrescriptionRow[] }>(`/customers/${customerId}/prescriptions`);
  if (!list) return null;
  return (
    <section aria-labelledby="customer-rx" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="customer-rx" className="section-title">{t('pha.customerRx')}</h2>
        {canRecord && branches?.[0] && <Link href={`/pharmacy/prescriptions/new?${new URLSearchParams({ branch: branches[0].id, customer: customerId })}`} className="btn">{t('pha.newRx')}</Link>}
      </div>
      <Note denom="none" className="pr-2">
        {list.data.length > 0 ? (
          <RecordTable
            rows={list.data}
            rowKey={(r) => r.id}
            columns={[
              { header: t('pha.patient'), cell: (r) => <Link href={`/pharmacy/prescriptions/${r.id}`} className="font-semibold underline" data-customer-rx>{r.patientName}</Link> },
              { header: t('common.branch'), cell: (r) => <Serial className="text-ink">{branchLabel(branches, r.branchId)}</Serial> },
              { header: t('pha.prescriber'), cell: (r) => r.prescriberName },
              { header: t('pha.issuedOn'), cell: (r) => formatDate(r.issuedOn, lang) },
              { header: t('pha.dispensedOf'), num: true, cell: (r) => <Serial className="text-ink">{qty(r.dispensed)} / {qty(r.prescribed)}</Serial> },
              { header: t('common.status'), cell: (r) => <PrescriptionTag status={r.status} label={t(`pha.status.${r.status}` as MessageKey)} /> },
            ]}
            stacked={{
              title: (r) => <Link href={`/pharmacy/prescriptions/${r.id}`} className="underline">{r.patientName}</Link>,
              meta: (r) => <Serial>{r.prescriberName} · {formatDate(r.issuedOn, lang)}</Serial>,
              figure: (r) => <PrescriptionTag status={r.status} label={t(`pha.status.${r.status}` as MessageKey)} />,
            }}
          />
        ) : (
          <Empty>{t('pha.customerNoRx')}</Empty>
        )}
      </Note>
    </section>
  );
}
