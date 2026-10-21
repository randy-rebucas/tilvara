import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton, ReasonAction } from '@/components/actions';
import { Callout, Note, Serial } from '@/components/note';
import { apiOrNull, type Appointment, type Branch } from '@/lib/api';
import { isOpen, localParts } from '@/lib/calendar';
import { formatDate, formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { appointmentsAccess, StatusTag, staffColor } from '../chrome';
import { bookableServices, branchStaff } from '../data';
import { ChangeAppointment } from './forms';

export const metadata = { title: 'Appointment' };

/**
 * One appointment (ADR-0022 §4): who, what, with whom and when; change it, mark the client arrived
 * or a no-show, or cancel with a reason. It is rung up at the till, which completes it; the sale is linked.
 */
export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t, lang } = await getT();
  const [a, branches] = await Promise.all([apiOrNull<Appointment>(`/appointments/${id}`), apiOrNull<{ data: Branch[] }>('/branches')]);
  if (!a) notFound();
  const { canBook, canCustomers } = await appointmentsAccess();
  const branch = branches?.data.find((b) => b.id === a.branchId);
  const tz = branch?.timezone || 'Asia/Manila';
  const when = (iso: string) => localParts(iso, tz);
  const start = when(a.startsAt);
  const open = isOpen(a.status);
  const manage = canBook && open;
  const [services, staff] = manage ? await Promise.all([bookableServices(), branchStaff(a.branchId)]) : [[], []];
  const status = t(`appt.status.${a.status}` as MessageKey);
  const back = `/appointments?${new URLSearchParams({ branch: a.branchId, date: start.date })}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={back} className="text-[0.875rem] text-muted underline">{t('appt.title')}</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">
          {a.customerName ?? a.guestName ?? '—'} <StatusTag status={a.status} label={status} />
        </h1>
        <Serial className="mt-1 block">
          {branch?.code ?? '—'} · {formatDate(start.date, lang)} · {start.time}–{when(a.endsAt).time}
          {a.customerId ? (
            <> · <Link href={`/customers/${a.customerId}`} className="underline">{t('appt.customerRecord')}</Link></>
          ) : (
            <> · {t('appt.guest')}</>
          )}
          {a.customerPhone && <> · {a.customerPhone}</>}
        </Serial>
      </div>

      {a.status === 'COMPLETED' && a.saleId && (
        <Callout>
          {t('appt.rungUp')}{' '}
          <Link href={`/sales/${a.saleId}`} className="font-semibold underline">{t('appt.openSale')}</Link>
        </Callout>
      )}
      {a.status === 'CANCELLED' && <Callout>{t('appt.cancelledBecause', { reason: a.cancelReason ?? '—' })}</Callout>}
      {a.status === 'NO_SHOW' && <Callout>{t('appt.noShowNote')}</Callout>}
      {open && <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('appt.ringAtTill')}</p>}

      <Note denom="none" className="px-5 py-4 pr-8">
        <h2 className="section-title mb-2">{t('appt.services')}</h2>
        <ul className="grid">
          {a.services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-hair-soft py-2 first:border-t-0">
              <span className="flex items-center gap-2">
                <span aria-hidden className="inline-block size-3 rounded-full" style={{ background: staffColor(s.staffColor) }} />
                <span className="font-semibold">{s.name}</span>
                <span className="text-muted">· {s.staffName}</span>
              </span>
              <Serial className="text-ink">{when(s.startsAt).time}–{when(s.endsAt).time}</Serial>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid gap-2 border-t border-hair-soft pt-3 text-[0.9375rem] sm:grid-cols-2">
          <div>
            <dt className="text-[0.8125rem] text-muted">{t('appt.notes')}</dt>
            <dd>{a.notes ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted">{t('appt.reminder')}</dt>
            <dd>
              {a.remindedAt
                ? t('appt.remindedAt', { at: formatDateTime(a.remindedAt, lang) })
                : a.remind && a.hasEmail
                  ? t('appt.remindOn')
                  : t('appt.remindOff')}
            </dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted">{t('appt.booked')}</dt>
            <dd>{formatDateTime(a.createdAt, lang)}</dd>
          </div>
        </dl>
      </Note>

      {manage && (
        <div className="flex flex-wrap items-start gap-2">
          {a.status === 'BOOKED' && <ActionButton url={`/api/v1/appointments/${a.id}/status`} body={{ status: 'ARRIVED' }} label={t('appt.markArrived')} primary />}
          <ChangeAppointment
            branch={{ id: a.branchId, timezone: tz }}
            services={services}
            staff={staff}
            canSearchCustomers={canCustomers}
            initial={{
              appointmentId: a.id,
              customer: a.customerId ? { id: a.customerId, name: a.customerName ?? '—', hasEmail: a.hasEmail } : null,
              guestName: a.guestName,
              notes: a.notes,
              remind: a.remind,
              services: a.services.map((s) => ({ variantId: s.variantId, staffId: s.staffId, date: when(s.startsAt).date, time: when(s.startsAt).time })),
            }}
          />
          <ActionButton url={`/api/v1/appointments/${a.id}/status`} body={{ status: 'NO_SHOW' }} label={t('appt.markNoShow')} confirmText={t('appt.noShowConfirm')} />
          <ReasonAction url={`/api/v1/appointments/${a.id}/status`} body={{ status: 'CANCELLED' }} label={t('appt.cancel')} reasonLabel={t('common.reason')} danger />
        </div>
      )}
    </div>
  );
}
