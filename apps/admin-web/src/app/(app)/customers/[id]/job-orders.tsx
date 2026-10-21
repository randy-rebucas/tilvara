import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type JobOrderRow } from '@/lib/api';
import { formatDateTime, peso } from '@/lib/format';
import { branchLabel } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { JobTag } from '../../laundry/chrome';

/** A customer's laundry (ADR-0024): open and past job orders, each linking to its job. */
export async function CustomerJobOrders({ customerId, branches }: { customerId: string; branches: Branch[] | undefined }) {
  const { t, lang } = await getT();
  const jobs = await apiOrNull<{ data: JobOrderRow[] }>(`/job-orders?${new URLSearchParams({ customerId, limit: '50' })}`);
  if (!jobs) return null;
  const status = (s: JobOrderRow['status']) => t(`lau.status.${s}` as MessageKey);
  return (
    <section aria-labelledby="customer-jobs" className="grid gap-3">
      <h2 id="customer-jobs" className="section-title">{t('lau.customerJobs')}</h2>
      <Note denom="none" className="pr-2">
        {jobs.data.length > 0 ? (
          <RecordTable
            rows={jobs.data}
            rowKey={(j) => j.id}
            dimmed={(j) => j.status === 'CANCELLED' || j.status === 'DISPOSED'}
            columns={[
              { header: t('lau.job'), cell: (j) => <Link href={`/laundry/jobs/${j.id}`} className="serial font-semibold underline">{j.reference}</Link> },
              { header: t('common.branch'), cell: (j) => <Serial className="text-ink">{branchLabel(branches, j.branchId)}</Serial> },
              { header: t('lau.received'), cell: (j) => <Serial className="text-ink">{formatDateTime(j.createdAt, lang)}</Serial> },
              { header: t('lau.total'), num: true, cell: (j) => <span className="money">{peso(j.amountDue)}</span> },
              { header: t('common.status'), cell: (j) => <JobTag status={j.status} label={status(j.status)} /> },
            ]}
            stacked={{
              title: (j) => <Link href={`/laundry/jobs/${j.id}`} className="underline">{j.reference}</Link>,
              meta: (j) => <Serial>{formatDateTime(j.createdAt, lang)} · {peso(j.amountDue)}</Serial>,
              figure: (j) => <JobTag status={j.status} label={status(j.status)} />,
            }}
          />
        ) : (
          <Empty>{t('lau.customerNoJobs')}</Empty>
        )}
      </Note>
    </section>
  );
}
