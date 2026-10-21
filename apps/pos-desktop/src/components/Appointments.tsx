import { CalendarPlus, ChevronLeft, ChevronRight, ShoppingCart } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import { api, ApiFailure, uuid } from '../lib/api';
import { addDays, clockTime, hhmmOf, minutesOf, weekdayOf, zonedDay, zonedInstant, zonedMinutes } from '../lib/calendar';
import { useTill } from '../lib/till';
import type { Appointment, AppointmentStatus, Availability, CounterCustomer, ServiceStaff } from '../types';
import { CustomerPanel } from './CounterTools';
import { errorText, unanswered, type Notice } from './Payment';
import type { Shift } from './Registers';
import { Callout, Empty, Field, Note } from './ui';

/** A service that can be booked: it has a duration (ADR-0022 §3). */
interface BookableService {
  variantId: string;
  name: string;
  minutes: number;
}

/** One column of the day: a staff member (an archived one still shows where they were booked). */
interface Column {
  id: string;
  name: string;
  color: string | null;
  hours: { startsAt: string; endsAt: string }[];
}

/** Height of one minute in the day view; 30 minutes = 36 px, enough for a two-line block. */
const PX_PER_MINUTE = 1.2;
const OPEN_STATUSES: AppointmentStatus[] = ['BOOKED', 'ARRIVED'];

/** What the server's refusals mean at the front desk (the server's own message otherwise). */
const BOOKING_ERRORS: Record<string, MessageKey> = {
  STAFF_DOUBLE_BOOKED: 'appt.err.doubleBooked',
  OUTSIDE_WORKING_HOURS: 'appt.err.outsideHours',
  STAFF_DOES_NOT_DO_SERVICE: 'appt.err.notTheirService',
  SERVICE_HAS_NO_DURATION: 'appt.err.noDuration',
  APPOINTMENT_NOT_OPEN: 'appt.err.notOpen',
};

/**
 * The appointment book at the counter (ADR-0022 §4): one day of the shift's branch, a column per staff
 * member, each booking as a block. Tap one to mark the customer arrived, a no-show or cancelled, or to
 * ring it up on Sell. Booking needs `appointments.manage`. Online only: the server keeps the book.
 */
export function Appointments({ shift, permissions, active, onRingUp }: {
  shift: Shift;
  permissions: string[];
  active: boolean;
  onRingUp: (a: Appointment) => void;
}) {
  const { t } = useT();
  const till = useTill();
  const offline = till.mode === 'ready' && !till.online;
  const tz = shift.branch.timezone;
  const today = zonedDay(new Date(), tz);
  const [day, setDay] = useState(today);
  const [staff, setStaff] = useState<ServiceStaff[] | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [services, setServices] = useState<BookableService[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const canManage = permissions.includes('appointments.manage');
  const canRingUp = permissions.includes('sales.create');

  async function load() {
    const from = zonedInstant(day, '00:00', tz);
    const to = zonedInstant(addDays(day, 1), '00:00', tz);
    try {
      const [s, a] = await Promise.all([
        api<{ data: ServiceStaff[] }>('GET', `/v1/service-staff?branchId=${shift.branch.id}`),
        api<{ data: Appointment[] }>('GET', `/v1/appointments?branchId=${shift.branch.id}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
      ]);
      setStaff(s.data.filter((x) => !x.archivedAt));
      setAppointments(a.data);
      setNotice((n) => (n?.kind === 'error' ? null : n));
    } catch (err) {
      if (unanswered(err)) till.reportUnreachable();
      setNotice({ kind: 'error', text: errorText(err, t('common.error'), t('common.network')) });
    }
  }

  // Re-read on opening the tab, changing day, and every minute while open (another desk may book too).
  useEffect(() => {
    if (!active || offline) return;
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [active, offline, day, shift.branch.id]);

  // The services that can be booked (those with a duration), once, for the booking form.
  useEffect(() => {
    if (!booking || services || offline) return;
    void loadServices().then(setServices, () => setServices([]));
  }, [booking, offline]);

  if (offline) {
    return (
      <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
        <h1 className="text-[1.5rem] font-bold">{t('nav.appointments')}</h1>
        <div data-testid="appointments-offline"><Callout kind="warn">{t('appt.offline')}</Callout></div>
      </div>
    );
  }

  const selected = appointments.find((a) => a.id === selectedId) ?? null;
  const dayLabel = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`));

  return (
    <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-[1.5rem] font-bold">{t('nav.appointments')}</h1>
        <div className="flex items-center gap-1" role="group" aria-label={t('appt.day')}>
          <button type="button" className="btn btn-sm" aria-label={t('appt.prevDay')} onClick={() => setDay(addDays(day, -1))}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" className="btn btn-sm" disabled={day === today} onClick={() => setDay(today)}>{t('appt.today')}</button>
          <button type="button" className="btn btn-sm" aria-label={t('appt.nextDay')} onClick={() => setDay(addDays(day, 1))}>
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
        {canManage && !booking && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { setBooking(true); setSelectedId(null); }}>
            <CalendarPlus className="size-4" aria-hidden /> {t('appt.new')}
          </button>
        )}
      </div>
      <p className="-mt-2 font-semibold" data-testid="appointments-day">{dayLabel}</p>

      {notice && <Callout kind={notice.kind}>{notice.text}</Callout>}

      {booking && staff && (
        <BookingForm
          shift={shift}
          day={day}
          dayLabel={dayLabel}
          staff={staff}
          services={services}
          canAddCustomer={permissions.includes('customers.manage')}
          canFindCustomer={permissions.includes('customers.read') || permissions.includes('customers.manage')}
          onBooked={(a) => {
            setBooking(false);
            setSelectedId(a.id);
            setNotice({ kind: 'info', text: t('appt.booked', { time: clockTime(a.startsAt, tz) }) });
            void load();
          }}
          onCancel={() => setBooking(false)}
        />
      )}

      {selected && (
        <AppointmentPanel
          key={selected.id}
          appointment={selected}
          timezone={tz}
          canManage={canManage}
          canRingUp={canRingUp}
          onChanged={(text) => { setNotice(text ? { kind: 'info', text } : null); void load(); }}
          onRingUp={() => onRingUp(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {staff === null ? null : staff.length === 0 && appointments.length === 0 ? (
        <Note><Empty>{t('appt.noStaff')}</Empty></Note>
      ) : (
        <DayView day={day} timezone={tz} staff={staff} appointments={appointments} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setBooking(false); }} />
      )}
    </div>
  );
}

/** Every bookable service (a SERVICE item's variants with a duration), read page by page. */
async function loadServices(): Promise<BookableService[]> {
  type Product = { name: string; productType?: string; archivedAt: string | null; variants: { id: string; name: string | null; serviceMinutes?: number | null; archivedAt: string | null }[] };
  const out: BookableService[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const r: { data: Product[]; nextCursor: string | null } = await api('GET', `/v1/products?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    for (const p of r.data) {
      if (p.productType !== 'SERVICE' || p.archivedAt) continue;
      for (const v of p.variants) {
        if (v.archivedAt || !v.serviceMinutes) continue;
        out.push({ variantId: v.id, name: v.name ? `${p.name} — ${v.name}` : p.name, minutes: v.serviceMinutes });
      }
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The day: time down the side, a column per staff member, their working hours light, bookings as blocks. */
function DayView({ day, timezone, staff, appointments, selectedId, onSelect }: {
  day: string;
  timezone: string;
  staff: ServiceStaff[];
  appointments: Appointment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const weekday = weekdayOf(day);
  const columns: Column[] = staff.map((s) => ({ id: s.id, name: s.displayName, color: s.color, hours: s.hours.filter((h) => h.weekday === weekday) }));
  // A booking with someone no longer on the list keeps its own column.
  for (const a of appointments) {
    for (const x of a.services) {
      if (!columns.some((c) => c.id === x.staffId)) columns.push({ id: x.staffId, name: x.staffName, color: x.staffColor, hours: [] });
    }
  }
  const onDay = (iso: string) => zonedDay(iso, timezone) === day;
  const blocks = appointments.flatMap((a) => a.services.filter((x) => onDay(x.startsAt)).map((x) => ({ a, x, start: zonedMinutes(x.startsAt, timezone), end: onDay(x.endsAt) ? zonedMinutes(x.endsAt, timezone) : 24 * 60 })));
  const marks = [...columns.flatMap((c) => c.hours.flatMap((h) => [minutesOf(h.startsAt), minutesOf(h.endsAt)])), ...blocks.flatMap((b) => [b.start, b.end])];
  const first = Math.floor(Math.min(9 * 60, ...marks) / 60) * 60;
  const last = Math.min(24 * 60, Math.ceil(Math.max(18 * 60, ...marks) / 60) * 60);
  const height = (last - first) * PX_PER_MINUTE;
  const y = (m: number) => (m - first) * PX_PER_MINUTE;
  const hours = Array.from({ length: (last - first) / 60 }, (_, i) => first + i * 60);
  const grid: CSSProperties = { gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(9.5rem, 1fr))` };
  const rules: CSSProperties = { height, backgroundImage: `repeating-linear-gradient(to bottom, var(--color-hair-soft) 0 1px, transparent 1px ${60 * PX_PER_MINUTE}px)` };

  return (
    <Note className="p-0">
      {/* The day scrolls sideways inside its card when the staff do not fit (phones), never the page. */}
      <div className="overflow-x-auto" data-testid="day-view">
        <div className="grid min-w-full" style={grid}>
          <div className="sticky left-0 z-[2] border-b border-hair bg-table-head" />
          {columns.map((c) => (
            <div key={c.id} className="flex items-center gap-2 border-b border-l border-hair bg-table-head px-2 py-2 text-[0.875rem] font-semibold">
              <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: c.color ?? 'var(--color-muted)' }} />
              <span className="truncate">{c.name}</span>
            </div>
          ))}
          <div className="sticky left-0 z-[2] bg-note" style={{ height }}>
            {hours.map((h) => (
              <span key={h} className="serial absolute pl-1 text-[0.6875rem] text-muted" style={{ top: y(h) + 2 }}>{hhmmOf(h)}</span>
            ))}
          </div>
          {columns.map((c) => (
            <div key={c.id} className="relative border-l border-hair bg-paper-deep" style={rules} aria-label={c.name} role="group">
              {c.hours.map((h, i) => (
                <div key={i} aria-hidden className="absolute inset-x-0 bg-note" style={{ top: y(minutesOf(h.startsAt)), height: (minutesOf(h.endsAt) - minutesOf(h.startsAt)) * PX_PER_MINUTE }} />
              ))}
              {blocks.filter((b) => b.x.staffId === c.id).map(({ a, x, start, end }) => {
                const closed = a.status === 'CANCELLED' || a.status === 'NO_SHOW';
                const who = a.customerName ?? a.guestName ?? '';
                return (
                  <button
                    key={x.id}
                    type="button"
                    data-testid="appointment-block"
                    data-status={a.status}
                    aria-pressed={selectedId === a.id}
                    aria-label={`${clockTime(x.startsAt, timezone)} ${who} · ${x.name} · ${t(`appt.status.${a.status}` as MessageKey)}`}
                    onClick={() => onSelect(a.id)}
                    className={`absolute inset-x-1 z-[1] overflow-hidden rounded-[4px] border border-hair bg-white px-2 py-1 text-left text-[0.8125rem] leading-tight shadow-sm hover:border-blue ${selectedId === a.id ? 'ring-2 ring-blue' : ''} ${closed ? 'opacity-60' : ''}`}
                    style={{ top: y(start) + 1, height: Math.max(28, (end - start) * PX_PER_MINUTE - 2), borderLeft: `4px solid ${x.staffColor ?? c.color ?? 'var(--color-muted)'}` }}
                  >
                    <span className="flex items-baseline justify-between gap-1">
                      <span className={`truncate font-semibold ${closed ? 'line-through' : ''}`}>{who}</span>
                      <StatusTag status={a.status} />
                    </span>
                    <span className="block truncate text-muted">{clockTime(x.startsAt, timezone)} · {x.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Note>
  );
}

function StatusTag({ status }: { status: AppointmentStatus }) {
  const { t } = useT();
  const tone = status === 'ARRIVED' ? 'tag-warn' : status === 'NO_SHOW' || status === 'CANCELLED' ? 'tag-bad' : '';
  return <span className={`tag shrink-0 ${tone}`}>{t(`appt.status.${status}` as MessageKey)}</span>;
}

/** One appointment: who, what, with whom, and what can be done with it now. */
function AppointmentPanel({ appointment: a, timezone, canManage, canRingUp, onChanged, onRingUp, onClose }: {
  appointment: Appointment;
  timezone: string;
  canManage: boolean;
  canRingUp: boolean;
  onChanged: (text: string | null) => void;
  onRingUp: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = OPEN_STATUSES.includes(a.status);

  async function setStatus(body: { status: 'ARRIVED' | 'NO_SHOW' } | { status: 'CANCELLED'; reason: string }) {
    setBusy(true);
    try {
      await api('POST', `/v1/appointments/${a.id}/status`, body);
      setError(null);
      onChanged(t(`appt.marked.${body.status}` as MessageKey));
    } catch (err) {
      const code = err instanceof ApiFailure ? err.error.code : '';
      setError(BOOKING_ERRORS[code] ? t(BOOKING_ERRORS[code]!) : errorText(err, t('common.error'), t('common.network')));
    } finally {
      setBusy(false);
    }
  }

  function cancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('cancelReason') ?? '').trim();
    if (reason) void setStatus({ status: 'CANCELLED', reason });
  }

  return (
    <Note denom="violet" className="grid gap-3 p-4" aria-label={t('appt.details')} data-testid="appointment-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[1.125rem] font-semibold">
            {clockTime(a.startsAt, timezone)}–{clockTime(a.endsAt, timezone)} · {a.customerName ?? a.guestName}
            {!a.customerId && <span className="ml-2 text-[0.8125rem] font-normal text-muted">{t('appt.guest')}</span>}
          </p>
          {a.customerPhone && <p className="serial text-[0.8125rem] text-muted">{a.customerPhone}</p>}
        </div>
        <span className="flex items-center gap-2">
          <StatusTag status={a.status} />
          <button type="button" className="btn btn-sm" onClick={onClose}>{t('appt.close')}</button>
        </span>
      </div>
      <ul className="grid gap-1 text-[0.9375rem]">
        {a.services.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: x.staffColor ?? 'var(--color-muted)' }} />
            <span className="serial text-[0.8125rem] text-muted">{clockTime(x.startsAt, timezone)}</span>
            <span>{x.name}</span>
            <span className="text-muted">· {x.staffName}</span>
          </li>
        ))}
      </ul>
      {a.notes && <p className="whitespace-pre-line text-[0.9375rem]">{a.notes}</p>}
      {a.cancelReason && <p className="text-[0.875rem] text-muted">{t('appt.cancelledBecause', { reason: a.cancelReason })}</p>}
      {open && (
        <div className="flex flex-wrap gap-2">
          {canRingUp && (
            <button type="button" className="btn btn-primary" onClick={onRingUp}>
              <ShoppingCart className="size-4" aria-hidden /> {t('appt.ringUp')}
            </button>
          )}
          {canManage && a.status === 'BOOKED' && <button type="button" className="btn" disabled={busy} onClick={() => void setStatus({ status: 'ARRIVED' })}>{t('appt.arrived')}</button>}
          {canManage && <button type="button" className="btn" disabled={busy} onClick={() => void setStatus({ status: 'NO_SHOW' })}>{t('appt.noShow')}</button>}
          {canManage && !cancelling && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setCancelling(true)}>{t('appt.cancel')}</button>}
        </div>
      )}
      {cancelling && open && (
        <form className="grid gap-3 rounded-[5px] border border-hair bg-white p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end" onSubmit={cancel}>
          <Field id="cancelReason" name="cancelReason" required autoFocus maxLength={200} label={t('appt.cancelReason')} />
          <button className="btn btn-danger sm:mb-[2px]" disabled={busy}>{t('appt.cancelConfirm')}</button>
          <button type="button" className="btn sm:mb-[2px]" onClick={() => setCancelling(false)}>{t('common.back')}</button>
        </form>
      )}
      {error && <Callout kind="error">{error}</Callout>}
    </Note>
  );
}

interface ServiceRow {
  key: string;
  variantId: string;
  staffId: string;
  time: string;
}

/**
 * A new appointment: a customer on file (found or added, as at the till) or a walk-in's name, then
 * each service with its staff member and time. Free times come from the server; a time outside the
 * staff member's hours is refused unless the desk presses "Book anyway".
 */
function BookingForm({ shift, day, dayLabel, staff, services, canAddCustomer, canFindCustomer, onBooked, onCancel }: {
  shift: Shift;
  day: string;
  dayLabel: string;
  staff: ServiceStaff[];
  services: BookableService[] | null;
  canAddCustomer: boolean;
  canFindCustomer: boolean;
  onBooked: (a: Appointment) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [who, setWho] = useState<'customer' | 'guest'>(canFindCustomer ? 'customer' : 'guest');
  const [customer, setCustomer] = useState<CounterCustomer | null>(null);
  const [guestName, setGuestName] = useState('');
  const [rows, setRows] = useState<ServiceRow[]>([{ key: uuid(), variantId: '', staffId: '', time: '' }]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<{ text: string; outsideHours?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per attempt, kept when the answer is lost (a retry cannot book twice), new after a refusal.
  const key = useRef(uuid());

  const patch = (k: string, p: Partial<ServiceRow>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...p } : r)));
  const ready = (who === 'customer' ? Boolean(customer) : guestName.trim() !== '') && rows.every((r) => r.variantId && r.staffId && /^\d{2}:\d{2}$/.test(r.time));

  async function book(outsideHours = false) {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const a = await api<Appointment>('POST', '/v1/appointments', {
        branchId: shift.branch.id,
        ...(who === 'customer' && customer ? { customerId: customer.id } : { guestName: guestName.trim() }),
        services: rows.map((r) => ({ variantId: r.variantId, staffId: r.staffId, startsAt: zonedInstant(day, r.time, shift.branch.timezone).toISOString() })),
        ...(notes.trim() && { notes: notes.trim() }),
        ...(outsideHours && { outsideHours: true }),
      }, { 'idempotency-key': key.current });
      key.current = uuid();
      onBooked(a);
    } catch (err) {
      if (!unanswered(err)) key.current = uuid();
      const code = err instanceof ApiFailure ? err.error.code : '';
      const known = BOOKING_ERRORS[code];
      setError({ text: known ? t(known) : errorText(err, t('common.error'), t('common.network')), outsideHours: code === 'OUTSIDE_WORKING_HOURS' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Note denom="violet" className="grid gap-4 p-4" aria-label={t('appt.new')} data-testid="booking-form">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="section-title">{t('appt.newOn', { day: dayLabel })}</h2>
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('appt.who')}>
          {canFindCustomer && <button type="button" className="btn btn-sm" aria-pressed={who === 'customer'} onClick={() => setWho('customer')}>{t('appt.onFile')}</button>}
          <button type="button" className="btn btn-sm" aria-pressed={who === 'guest'} onClick={() => setWho('guest')}>{t('appt.walkIn')}</button>
        </div>
        {who === 'customer' ? (
          customer ? (
            <p className="flex flex-wrap items-center gap-2" data-testid="booking-customer">
              <span className="font-semibold">{customer.displayName}</span>
              {customer.phone && <span className="serial text-[0.8125rem] text-muted">{customer.phone}</span>}
              <button type="button" className="btn btn-sm" onClick={() => setCustomer(null)}>{t('appt.changeCustomer')}</button>
            </p>
          ) : (
            <CustomerPanel title={t('appt.customer')} canAdd={canAddCustomer} onPick={setCustomer} onCancel={() => setWho('guest')} />
          )
        ) : (
          <Field id="guestName" label={t('appt.guestName')} value={guestName} maxLength={120} autoComplete="off" onChange={(e) => setGuestName(e.target.value)} />
        )}
      </div>

      {services && services.length === 0 && <Callout kind="warn">{t('appt.noServices')}</Callout>}
      {rows.map((r, i) => (
        <ServiceRowFields
          key={r.key}
          row={r}
          n={i + 1}
          shift={shift}
          day={day}
          staff={staff}
          services={services ?? []}
          onChange={(p) => patch(r.key, p)}
          onRemove={rows.length > 1 ? () => setRows((rs) => rs.filter((x) => x.key !== r.key)) : undefined}
        />
      ))}
      {rows.length < 10 && (
        <button type="button" className="btn btn-sm justify-self-start" onClick={() => setRows((rs) => [...rs, { key: uuid(), variantId: '', staffId: '', time: '' }])}>
          {t('appt.addService')}
        </button>
      )}

      <div className="field">
        <label htmlFor="apptNotes">{t('appt.notes')}</label>
        <textarea id="apptNotes" className="input min-h-16 py-2" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error && (
        <div className="grid gap-2" data-testid="booking-error">
          <Callout kind={error.outsideHours ? 'warn' : 'error'}>{error.text}</Callout>
          {error.outsideHours && (
            <button type="button" className="btn justify-self-start" disabled={busy} onClick={() => void book(true)}>{t('appt.bookAnyway')}</button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void book()}>{t('appt.book')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </Note>
  );
}

/** One service of the booking: which, with whom, when; with the free times of whoever does it that day. */
function ServiceRowFields({ row, n, shift, day, staff, services, onChange, onRemove }: {
  row: ServiceRow;
  n: number;
  shift: Shift;
  day: string;
  staff: ServiceStaff[];
  services: BookableService[];
  onChange: (p: Partial<ServiceRow>) => void;
  onRemove?: (() => void) | undefined;
}) {
  const { t } = useT();
  const tz = shift.branch.timezone;
  const [free, setFree] = useState<Availability | null>(null);
  const [freeError, setFreeError] = useState<string | null>(null);
  const doers = staff.filter((s) => !row.variantId || s.services.length === 0 || s.services.some((x) => x.variantId === row.variantId));

  useEffect(() => {
    setFree(null);
    setFreeError(null);
    if (!row.variantId) return;
    let live = true;
    api<Availability>('GET', `/v1/appointments/availability?branchId=${shift.branch.id}&variantId=${row.variantId}&date=${day}${row.staffId ? `&staffId=${row.staffId}` : ''}`)
      .then((r) => live && setFree(r))
      .catch((err) => live && setFreeError(errorText(err, t('common.error'), t('common.network'))));
    return () => {
      live = false;
    };
  }, [row.variantId, row.staffId, day, shift.branch.id]);

  const id = (f: string) => `${f}-${row.key}`;
  return (
    <fieldset className="grid gap-3 rounded-[5px] border border-hair bg-white p-3" data-testid="booking-service">
      <legend className="px-1 text-[0.8125rem] font-semibold text-muted">{t('appt.serviceN', { n: String(n) })}</legend>
      <div className="grid gap-3 sm:grid-cols-[2fr_1.4fr_8rem_auto] sm:items-end">
        <div className="field">
          <label htmlFor={id('service')}>{t('appt.service')}</label>
          <select id={id('service')} className="input" value={row.variantId} onChange={(e) => onChange({ variantId: e.target.value })}>
            <option value="">{t('appt.chooseService')}</option>
            {services.map((s) => <option key={s.variantId} value={s.variantId}>{s.name} · {t('appt.minutes', { n: String(s.minutes) })}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('staff')}>{t('appt.staff')}</label>
          <select id={id('staff')} className="input" value={row.staffId} onChange={(e) => onChange({ staffId: e.target.value })}>
            <option value="">{t('appt.anyStaff')}</option>
            {doers.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('time')}>{t('appt.time')}</label>
          <input id={id('time')} type="time" step={300} className="input" value={row.time} onChange={(e) => onChange({ time: e.target.value })} />
        </div>
        {onRemove && <button type="button" className="btn btn-sm btn-danger sm:mb-[6px]" onClick={onRemove}>{t('appt.removeService')}</button>}
      </div>
      {freeError && <p className="text-[0.8125rem] text-red">{freeError}</p>}
      {free && (
        <div className="grid gap-2" data-testid="free-times">
          <p className="text-[0.8125rem] text-muted">{t('appt.freeTimes')}</p>
          {free.staff.filter((s) => !row.staffId || s.staffId === row.staffId).map((s) => (
            <div key={s.staffId} className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:items-start">
              <span className="flex items-center gap-2 text-[0.875rem] font-semibold">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: s.color ?? 'var(--color-muted)' }} />
                <span className="truncate">{s.displayName}</span>
              </span>
              {s.slots.length === 0 ? (
                <span className="text-[0.8125rem] text-muted">{t('appt.noFreeTimes')}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {(row.staffId ? s.slots : s.slots.slice(0, 16)).map((slot) => {
                    const hhmm = clockTime(slot, tz);
                    const picked = row.staffId === s.staffId && row.time === hhmm;
                    return (
                      <button key={slot} type="button" className="btn btn-sm serial h-8 px-2" aria-pressed={picked} data-slot={hhmm} data-staff={s.displayName} onClick={() => onChange({ staffId: s.staffId, time: hhmm })}>
                        {hhmm}
                      </button>
                    );
                  })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
