import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { apiOrNull, type Branch, type Member, type ServiceStaffDetail } from '@/lib/api';
import { localParts } from '@/lib/calendar';
import { formatDate, percentFromRate } from '@/lib/format';
import { isUuid } from '@/lib/options';
import { getT } from '@/i18n/server';
import { appointmentsAccess, staffColor } from '../../chrome';
import { bookableServices, hoursLine } from '../../data';
import { AddTimeOff, EditStaff, RemoveTimeOff, StaffHours, StaffServices } from '../forms';

export const metadata = { title: 'Staff member' };

/** One staff member: details, the services they do, weekly hours and time off; archive or bring back. */
export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [s, branches] = await Promise.all([apiOrNull<ServiceStaffDetail>(`/service-staff/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!s) notFound();
  const { canStaff, canBook } = await appointmentsAccess();
  const manage = s.canManage && canStaff;
  const branch = branches?.data.find((b) => b.id === s.branchId);
  const tz = branch?.timezone || 'Asia/Manila';
  const [services, members] = await Promise.all([bookableServices(), manage ? apiOrNull<{ data: Member[] }>('/members') : null]);
  const showRate = s.commissionRate !== undefined;
  const nameOf = new Map(services.map((x) => [x.id, x.label]));
  const at = (iso: string) => {
    const p = localParts(iso, tz);
    return `${formatDate(p.date, lang)} ${p.time}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/appointments/staff?branch=${s.branchId}`} className="text-[0.875rem] text-muted underline">{t('appt.tab.staff')}</Link>
        <h1 className="mt-1 flex items-center gap-3 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">
          <span aria-hidden className="inline-block size-4 rounded-full" style={{ background: staffColor(s.color) }} />
          {s.displayName}
          {s.archivedAt && <span className="tag">{t('prod.archived')}</span>}
        </h1>
        <Serial className="mt-1 block">
          {branch?.code ?? '—'}
          {s.memberName && <> · {t('sstaff.signsInAs', { name: s.memberName })}</>}
          {showRate && <> · {t('sstaff.commission')} {percentFromRate(s.commissionRate!)}%</>}
        </Serial>
      </div>

      {s.archivedAt && <Callout>{t('sstaff.archivedNote')}</Callout>}

      {manage && (
        <div className="flex flex-wrap items-start gap-2">
          <EditStaff branchId={s.branchId} staff={s} members={members ? members.data.filter((m) => m.status === 'ACTIVE').map((m) => ({ id: m.membershipId, name: m.user.displayName })) : null} showRate={showRate} />
          {s.archivedAt ? (
            <ActionButton method="PATCH" url={`/api/v1/service-staff/${s.id}`} body={{ archived: false }} label={t('sstaff.restore')} />
          ) : (
            <ActionButton method="PATCH" url={`/api/v1/service-staff/${s.id}`} body={{ archived: true }} label={t('sstaff.archive')} confirmText={t('sstaff.archiveConfirm', { name: s.displayName })} />
          )}
        </div>
      )}

      <section aria-labelledby="does" className="grid gap-3">
        <h2 id="does" className="section-title">{t('sstaff.does')}</h2>
        <Note denom="green" className="px-5 py-4 pr-8">
          {manage ? (
            <StaffServices staff={s} services={services} showRate={showRate} />
          ) : s.services.length === 0 ? (
            <p>{t('sstaff.everyService')}</p>
          ) : (
            <ul className="grid gap-1">
              {s.services.map((x) => <li key={x.variantId}>{nameOf.get(x.variantId) ?? '—'}</li>)}
            </ul>
          )}
        </Note>
      </section>

      <section aria-labelledby="hours" className="grid gap-3">
        <h2 id="hours" className="section-title">{t('sstaff.hours')}</h2>
        <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('sstaff.hoursLede')}</p>
        <Note denom="green" className="px-5 py-4 pr-8">
          {manage ? <StaffHours staff={s} /> : <p>{hoursLine(s, t)}</p>}
        </Note>
      </section>

      <section aria-labelledby="off" className="grid gap-3">
        <h2 id="off" className="section-title">{t('sstaff.timeOff')}</h2>
        <Note denom="none" className="pr-2">
          {s.timeOff.length === 0 ? (
            <Empty>{t('sstaff.noTimeOff')}</Empty>
          ) : (
            <ul>
              {s.timeOff.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0">
                  <span>
                    <Serial className="text-ink">{at(o.startsAt)} – {at(o.endsAt)}</Serial>
                    {o.reason && <span className="block text-[0.875rem] text-muted">{o.reason}</span>}
                  </span>
                  {(canStaff || canBook) && <RemoveTimeOff staffId={s.id} timeOffId={o.id} />}
                </li>
              ))}
            </ul>
          )}
        </Note>
        {!s.archivedAt && (canStaff || canBook) && <div><AddTimeOff staffId={s.id} timezone={tz} /></div>}
      </section>
    </div>
  );
}
