import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { SubNav } from '@/components/sub-nav';
import { apiOrNull, type Appointment, type ServiceStaff } from '@/lib/api';
import { addDays, dayWindow, fromMinutes, isDate, localParts, mondayOf, toMinutes, weekdayOf, zonedInstant } from '@/lib/calendar';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { AppointmentsChrome, appointmentsAccess, appointmentsBranch, StatusTag, staffColor } from './chrome';

export const metadata = { title: 'Appointments' };

/** Pixels per minute in the day view: an hour is 72px, a 15-minute service still shows its time. */
const PX = 1.2;
const OFF_CALENDAR = ['CANCELLED', 'NO_SHOW'];

/**
 * The appointment calendar (ADR-0022 §4): a day per branch with a column per staff member and the
 * bookings as blocks in the staff member's colour (their hours white, the rest shaded), or a week as
 * a list. Booking from an empty slot opens the booking form with the staff member and time filled.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ branch?: string; date?: string; view?: string }> }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const { branches, branch } = await appointmentsBranch(sp.branch);
  const { canBook } = await appointmentsAccess();
  const tz = branch?.timezone || 'Asia/Manila';
  const today = localParts(new Date().toISOString(), tz).date;
  const date = isDate(sp.date) ? sp.date : today;
  const view = sp.view === 'week' ? 'week' : 'day';
  const first = view === 'week' ? mondayOf(date) : date;
  const days = view === 'week' ? 7 : 1;

  const [appts, staffList] = branch
    ? await Promise.all([
        apiOrNull<{ data: Appointment[] }>(`/appointments?${new URLSearchParams({ branchId: branch.id, from: zonedInstant(first, '00:00', tz), to: zonedInstant(addDays(first, days), '00:00', tz) })}`),
        apiOrNull<{ data: ServiceStaff[] }>(`/service-staff?branchId=${branch.id}`),
      ])
    : [null, null];
  const all = appts?.data ?? [];
  const staff = staffList?.data ?? [];

  const q = (extra: Record<string, string>) => `/appointments?${new URLSearchParams({ ...(branch && { branch: branch.id }), view, date, ...extra })}`;
  const step = view === 'week' ? 7 : 1;
  const who = (a: Appointment) => a.customerName ?? a.guestName ?? '—';
  const status = (s: string) => t(`appt.status.${s}` as MessageKey);
  const time = (iso: string) => localParts(iso, tz).time;

  return (
    <AppointmentsChrome tab="calendar" branches={branches} branch={branch} extra={{ date, view }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={q({ date: addDays(date, -step) })} className="btn" aria-label={t(view === 'week' ? 'appt.prevWeek' : 'appt.prevDay')}>
            <ChevronLeft aria-hidden className="size-4" />
          </Link>
          <Link href={q({ date: today })} className="btn" aria-current={date === today ? 'date' : undefined}>{t('appt.today')}</Link>
          <Link href={q({ date: addDays(date, step) })} className="btn" aria-label={t(view === 'week' ? 'appt.nextWeek' : 'appt.nextDay')}>
            <ChevronRight aria-hidden className="size-4" />
          </Link>
          <h2 className="ml-1 text-[1.0625rem] font-semibold" data-testid="calendar-date">
            {view === 'week' ? t('appt.weekOf', { from: formatDate(first, lang), to: formatDate(addDays(first, 6), lang) }) : `${t(`appt.weekday.${weekdayOf(date)}` as MessageKey)}, ${formatDate(date, lang)}`}
          </h2>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <form method="get" action="/appointments" className="flex items-end gap-2">
            {branch && <input type="hidden" name="branch" value={branch.id} />}
            <input type="hidden" name="view" value={view} />
            <label className="sr-only" htmlFor="cal-date">{t('common.date')}</label>
            <input id="cal-date" name="date" type="date" className="input w-auto" defaultValue={date} />
            <button className="btn">{t('common.show')}</button>
          </form>
          {canBook && branch && (
            <Link href={`/appointments/new?${new URLSearchParams({ branch: branch.id, date })}`} className="btn btn-primary">
              <Plus aria-hidden className="size-4" /> {t('appt.new')}
            </Link>
          )}
        </div>
      </div>
      <SubNav
        level={2}
        label={t('appt.view')}
        active={view}
        items={[
          { key: 'day', href: `/appointments?${new URLSearchParams({ ...(branch && { branch: branch.id }), date, view: 'day' })}`, label: t('appt.viewDay') },
          { key: 'week', href: `/appointments?${new URLSearchParams({ ...(branch && { branch: branch.id }), date, view: 'week' })}`, label: t('appt.viewWeek') },
        ]}
      />

      {!appts ? (
        <Note><Empty>{t('common.noAccess')}</Empty></Note>
      ) : view === 'day' ? (
        <DayView date={date} tz={tz} appointments={all} staff={staff} canBook={canBook} branchId={branch!.id} />
      ) : null}

      {appts && (
        <section aria-labelledby="day-list">
          <h2 id="day-list" className="section-title mb-3">{view === 'week' ? t('appt.thisWeek') : t('appt.thisDay')}</h2>
          <Note denom="none" className="pr-2">
            {all.length > 0 ? (
              <RecordTable
                rows={all}
                rowKey={(a) => a.id}
                dimmed={(a) => OFF_CALENDAR.includes(a.status)}
                columns={[
                  {
                    header: t('appt.when'),
                    cell: (a) => (
                      <Serial className="text-ink">
                        {view === 'week' && <>{t(`appt.weekdayShort.${weekdayOf(localParts(a.startsAt, tz).date)}` as MessageKey)} {localParts(a.startsAt, tz).date.slice(5)} · </>}
                        {time(a.startsAt)}–{time(a.endsAt)}
                      </Serial>
                    ),
                  },
                  { header: t('appt.client'), cell: (a) => <Link href={`/appointments/${a.id}`} className="font-semibold underline">{who(a)}</Link> },
                  { header: t('appt.services'), cell: (a) => <ServicesCell a={a} /> },
                  { header: t('common.status'), cell: (a) => <StatusTag status={a.status} label={status(a.status)} /> },
                ]}
                stacked={{
                  title: (a) => <Link href={`/appointments/${a.id}`} className="underline">{who(a)}</Link>,
                  meta: (a) => (
                    <>
                      <Serial>{view === 'week' && `${localParts(a.startsAt, tz).date.slice(5)} · `}{time(a.startsAt)}–{time(a.endsAt)}</Serial>
                      <span className="block">{a.services.map((s) => `${s.name} · ${s.staffName}`).join(', ')}</span>
                    </>
                  ),
                  figure: (a) => <StatusTag status={a.status} label={status(a.status)} />,
                }}
              />
            ) : (
              <Empty action={canBook && branch ? <Link href={`/appointments/new?${new URLSearchParams({ branch: branch.id, date })}`} className="btn">{t('appt.new')}</Link> : undefined}>
                {staff.length === 0 ? t('appt.noStaffYet') : view === 'week' ? t('appt.noneThisWeek') : t('appt.noneThisDay')}
              </Empty>
            )}
          </Note>
        </section>
      )}
    </AppointmentsChrome>
  );
}

function ServicesCell({ a }: { a: Appointment }) {
  return (
    <ul className="grid gap-0.5">
      {a.services.map((s) => (
        <li key={s.id} className="flex items-center gap-1.5 text-[0.875rem]">
          <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: staffColor(s.staffColor) }} />
          {s.name} <span className="text-muted">· {s.staffName}</span>
        </li>
      ))}
    </ul>
  );
}

/** One column per staff member, rows by time; empty half-hours link to the booking form. */
async function DayView({ date, tz, appointments, staff, canBook, branchId }: { date: string; tz: string; appointments: Appointment[]; staff: ServiceStaff[]; canBook: boolean; branchId: string }) {
  const { t } = await getT();
  const weekday = weekdayOf(date);
  const live = appointments.filter((a) => !OFF_CALENDAR.includes(a.status));
  // Staff on the calendar: the branch's active staff, plus anyone booked today who has since been archived.
  const columns: { id: string; name: string; color: string | null; hours: { start: number; end: number }[] | null }[] = staff.map((s) => ({
    id: s.id,
    name: s.displayName,
    color: s.color,
    // No hours set at all: the whole day is open (the business has not planned shifts).
    hours: s.hours.length ? s.hours.filter((h) => h.weekday === weekday).map((h) => ({ start: toMinutes(h.startsAt), end: toMinutes(h.endsAt) })) : null,
  }));
  for (const a of live) {
    for (const s of a.services) {
      if (!columns.some((c) => c.id === s.staffId)) columns.push({ id: s.staffId, name: s.staffName, color: s.staffColor, hours: [] });
    }
  }
  if (columns.length === 0) return null;

  const minuteOf = (iso: string, end = false) => {
    const p = localParts(iso, tz);
    if (p.date < date) return 0;
    if (p.date > date) return 24 * 60;
    return end && p.minutes === 0 ? 24 * 60 : p.minutes;
  };
  const blocks = live.flatMap((a) => a.services.map((s) => ({ a, s, start: minuteOf(s.startsAt), end: minuteOf(s.endsAt, true) })));
  const win = dayWindow([...columns.flatMap((c) => c.hours ?? []), ...blocks]);
  const height = (win.end - win.start) * PX;
  const hourMarks = Array.from({ length: (win.end - win.start) / 60 + 1 }, (_, i) => win.start + i * 60);
  const halfHours = Array.from({ length: (win.end - win.start) / 30 }, (_, i) => win.start + i * 30);
  const y = (m: number) => (Math.max(win.start, Math.min(win.end, m)) - win.start) * PX;

  return (
    <Note denom="none" className="p-2 pr-3">
      {/* The grid scrolls inside its note on a phone; the page itself never scrolls sideways. */}
      <div className="overflow-x-auto" data-testid="day-view">
        <div className="grid min-w-full" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(150px, 1fr))` }}>
          <div />
          {columns.map((c) => (
            <div key={c.id} className="flex min-w-0 items-center justify-between gap-1 border-b border-hair px-2 pb-2">
              <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                <span aria-hidden className="inline-block size-3 shrink-0 rounded-full" style={{ background: staffColor(c.color) }} />
                <span className="truncate">{c.name}</span>
              </span>
              {canBook && (
                <Link
                  href={`/appointments/new?${new URLSearchParams({ branch: branchId, date, staff: c.id })}`}
                  className="grid size-7 shrink-0 place-items-center rounded-[4px] text-muted hover:bg-paper-deep hover:text-ink"
                  title={t('appt.bookWith', { name: c.name })}
                >
                  <Plus aria-hidden className="size-4" />
                  <span className="sr-only">{t('appt.bookWith', { name: c.name })}</span>
                </Link>
              )}
            </div>
          ))}

          {/* Time gutter */}
          <div className="relative" style={{ height }} aria-hidden>
            {hourMarks.slice(0, -1).map((m) => (
              <span key={m} className="serial absolute right-2 -translate-y-1/2 text-[0.75rem] text-muted first:translate-y-0" style={{ top: y(m) }}>{fromMinutes(m)}</span>
            ))}
          </div>

          {columns.map((c) => (
            <div
              key={c.id}
              className="relative border-l border-hair-soft"
              // Off hours shaded (paper), working hours white.
              style={{ height, background: c.hours === null ? '#fff' : 'var(--color-paper)' }}
              data-staff={c.name}
            >
              {(c.hours ?? []).map((h) => (
                <div key={h.start} aria-hidden className="absolute inset-x-0 bg-white" style={{ top: y(h.start), height: y(h.end) - y(h.start) }} />
              ))}
              {/* Hour rules above the hours, under the bookings. */}
              <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `repeating-linear-gradient(to bottom, var(--color-hair-soft) 0, var(--color-hair-soft) 1px, transparent 1px, transparent ${60 * PX}px)` }} />
              {canBook &&
                halfHours.map((m) => (
                  <Link
                    key={m}
                    href={`/appointments/new?${new URLSearchParams({ branch: branchId, date, staff: c.id, time: fromMinutes(m) })}`}
                    tabIndex={-1}
                    aria-hidden
                    data-slot={fromMinutes(m)}
                    className="group absolute inset-x-0 block hover:bg-blue/5"
                    style={{ top: y(m), height: 30 * PX }}
                  >
                    <span className="serial hidden px-1.5 text-[0.6875rem] text-blue group-hover:inline">+ {fromMinutes(m)}</span>
                  </Link>
                ))}
              {blocks
                .filter((b) => b.s.staffId === c.id)
                .map(({ a, s, start, end }) => (
                  <Link
                    key={s.id}
                    href={`/appointments/${a.id}`}
                    data-appointment={a.id}
                    className="absolute inset-x-1 overflow-hidden rounded-[4px] border border-hair px-2 py-1 text-[0.8125rem] leading-tight shadow-[0_1px_2px_rgb(60_50_20/0.08)] hover:border-ink/40"
                    style={{
                      top: y(start) + 1,
                      height: Math.max(22, y(end) - y(start) - 2),
                      background: `color-mix(in srgb, ${staffColor(s.staffColor)} 16%, white)`,
                      borderLeft: `4px solid ${staffColor(s.staffColor)}`,
                    }}
                  >
                    <span className="serial block text-[0.75rem] text-ink">
                      {fromMinutes(start)}–{fromMinutes(end)} ·{t(`appt.status.${a.status}` as MessageKey)}
                    </span>
                    <span className="block truncate font-semibold">{a.customerName ?? a.guestName}</span>
                    <span className="block truncate text-muted">{s.name}</span>
                  </Link>
                ))}
            </div>
          ))}
        </div>
      </div>
    </Note>
  );
}
