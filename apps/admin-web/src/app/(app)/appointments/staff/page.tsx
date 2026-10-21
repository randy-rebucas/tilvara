import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Member, type ServiceStaff } from '@/lib/api';
import { percentFromRate } from '@/lib/format';
import { getT } from '@/i18n/server';
import { AppointmentsChrome, appointmentsAccess, appointmentsBranch, staffColor } from '../chrome';
import { hoursLine } from '../data';
import { STAFF_COLOURS } from '@/lib/calendar';
import { AddStaff } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('appointments.staff');

/**
 * Service staff of a branch (ADR-0022 §2): the people who perform services, whether or not they sign
 * in. Commission rates show only to those who may manage staff.
 */
export default async function StaffPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await appointmentsBranch(sp.branch);
  const { canStaff } = await appointmentsAccess();
  const [list, members] = branch
    ? await Promise.all([apiOrNull<{ data: ServiceStaff[] }>(`/service-staff?branchId=${branch.id}&includeArchived=true`), canStaff ? apiOrNull<{ data: Member[] }>('/members') : null])
    : [null, null];
  const staff = list?.data ?? [];
  const showRate = staff.some((s) => s.commissionRate !== undefined) || canStaff;
  const used = new Set(staff.map((s) => s.color));
  const memberOptions = members ? members.data.filter((m) => m.status === 'ACTIVE').map((m) => ({ id: m.membershipId, name: m.user.displayName })) : null;

  return (
    <AppointmentsChrome tab="staff" branches={branches} branch={branch}>
      <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('sstaff.lede')}</p>
      {canStaff && branch && (
        <div>
          <AddStaff branchId={branch.id} members={memberOptions} suggestColour={STAFF_COLOURS.find((c) => !used.has(c)) ?? STAFF_COLOURS[0]!} showRate />
        </div>
      )}
      <Note denom="green" className="pr-2">
        {staff.length > 0 ? (
          <RecordTable
            rows={staff}
            rowKey={(s) => s.id}
            dimmed={(s) => Boolean(s.archivedAt)}
            columns={[
              {
                header: t('sstaff.name'),
                cell: (s) => (
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="inline-block size-3 shrink-0 rounded-full" style={{ background: staffColor(s.color) }} />
                    <Link href={`/appointments/staff/${s.id}`} className="font-semibold underline">{s.displayName}</Link>
                    {s.archivedAt && <span className="tag">{t('prod.archived')}</span>}
                  </span>
                ),
              },
              { header: t('sstaff.member'), cell: (s) => s.memberName ?? <span className="text-muted">—</span> },
              { header: t('sstaff.does'), cell: (s) => (s.services.length ? t('sstaff.nServices', { n: s.services.length }) : t('sstaff.everyService')) },
              { header: t('sstaff.hours'), cell: (s) => <span className="text-[0.875rem]">{hoursLine(s, t)}</span> },
              ...(showRate ? [{ header: t('sstaff.commission'), num: true, cell: (s: ServiceStaff) => (s.commissionRate !== undefined ? <Serial className="text-ink">{percentFromRate(s.commissionRate)}%</Serial> : '—') }] : []),
            ]}
            stacked={{
              title: (s) => (
                <span className="flex items-center gap-2">
                  <span aria-hidden className="inline-block size-3 shrink-0 rounded-full" style={{ background: staffColor(s.color) }} />
                  <Link href={`/appointments/staff/${s.id}`} className="underline">{s.displayName}</Link>
                </span>
              ),
              meta: (s) => <span>{hoursLine(s, t)}</span>,
              figure: (s) => (s.commissionRate !== undefined ? <Serial className="text-ink">{percentFromRate(s.commissionRate)}%</Serial> : null),
            }}
          />
        ) : (
          <Empty>{list ? t('sstaff.empty') : t('common.noAccess')}</Empty>
        )}
      </Note>
    </AppointmentsChrome>
  );
}
