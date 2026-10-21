'use client';

import { Plus, Search, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Callout } from '@/components/note';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Availability, CustomerSummary, ServiceStaff } from '@/lib/api';
import { localParts, zonedInstant } from '@/lib/calendar';

export interface BookableService {
  id: string;
  label: string;
  minutes: number | null;
}
export interface BookingInitial {
  appointmentId: string;
  customer: { id: string; name: string; hasEmail: boolean } | null;
  guestName: string | null;
  notes: string | null;
  remind: boolean;
  services: { variantId: string; staffId: string; date: string; time: string }[];
}
type Row = { key: number; variantId: string; staffId: string; date: string; time: string };
type Picked = { id: string; name: string; hasEmail: boolean };

/** Free times shown per staff member before "more". */
const SLOTS_SHOWN = 12;

/**
 * Book or change an appointment (ADR-0022 §4): a customer (searched) or a guest's name, one or more
 * services each with its staff member and start, free times from the server, notes and the email
 * reminder. Outside the staff's hours the server refuses; "Book anyway" sends it again on purpose.
 */
export function BookingForm({
  branch,
  services,
  staff,
  initial,
  defaults,
  canSearchCustomers,
  onDone,
}: {
  branch: { id: string; timezone: string };
  services: BookableService[];
  staff: ServiceStaff[];
  initial?: BookingInitial;
  defaults: { date: string; staffId?: string; time?: string };
  canSearchCustomers: boolean;
  /** Changing an existing appointment: close the panel instead of going to the calendar. */
  onDone?: () => void;
}) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, error, setError } = useSubmit();
  const [customer, setCustomer] = useState<Picked | null>(initial?.customer ?? null);
  const [guestName, setGuestName] = useState(initial?.guestName ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [remind, setRemind] = useState(initial ? initial.remind : false);
  const [remindTouched, setRemindTouched] = useState(Boolean(initial));
  const [rows, setRows] = useState<Row[]>(() =>
    initial?.services.length
      ? initial.services.map((s, i) => ({ key: i, ...s }))
      : [{ key: 0, variantId: '', staffId: defaults.staffId ?? '', date: defaults.date, time: defaults.time ?? '' }],
  );
  const [next, setNext] = useState(rows.length);
  const [outside, setOutside] = useState<string | null>(null);
  const update = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  function pick(c: Picked | null) {
    setCustomer(c);
    // Ticked by default when the customer has an email (the reminder goes there), unless already chosen.
    if (!remindTouched) setRemind(Boolean(c?.hasEmail));
  }

  const doesService = (s: ServiceStaff, variantId: string) => !variantId || s.services.length === 0 || s.services.some((x) => x.variantId === variantId);

  async function send(outsideHours: boolean) {
    setOutside(null);
    const body = {
      ...(initial ? {} : { branchId: branch.id }),
      ...(customer ? { customerId: customer.id, guestName: null } : { customerId: null, guestName: guestName.trim() || null }),
      services: rows.map((r) => ({ variantId: r.variantId, staffId: r.staffId, startsAt: r.date && r.time ? zonedInstant(r.date, r.time, branch.timezone) : '' })),
      notes: notes.trim() || null,
      remind: customer ? remind : false,
      outsideHours,
    };
    const r = initial
      ? await submit('PATCH', `/api/v1/appointments/${initial.appointmentId}`, body)
      : await submit<{ id: string }>('POST', '/api/v1/appointments', body, { idempotencyKey: key, refresh: false });
    if (r.ok) {
      if (onDone) onDone();
      else router.push(`/appointments?${new URLSearchParams({ branch: branch.id, date: rows[0]!.date })}`);
      return;
    }
    if (r.error.code === 'OUTSIDE_WORKING_HOURS') {
      setOutside(r.error.message);
      setError(null);
    }
  }

  const missing = rows.some((r) => !r.variantId || !r.staffId || !r.date || !r.time) || (!customer && !guestName.trim());

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void send(false);
      }}
    >
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('appt.client')}</legend>
        {customer ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag h-8! px-3! text-[0.9375rem]! text-ink!" data-testid="picked-customer">{customer.name}</span>
            <button type="button" className="btn" onClick={() => pick(null)}>
              <X aria-hidden className="size-4" /> {t('appt.changeClient')}
            </button>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {canSearchCustomers && <CustomerSearch onPick={pick} />}
            <TextField label={t('appt.guestName')} name="guestName" value={guestName} onChange={(e) => setGuestName(e.target.value)} hint={t('appt.guestHint')} maxLength={120} />
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('appt.services')}</legend>
        {services.length === 0 && <Callout tone="warn">{t('appt.noServices')}</Callout>}
        {rows.map((r, i) => {
          const options = staff.filter((s) => doesService(s, r.variantId));
          return (
            <div key={r.key} className="grid gap-3 rounded-[5px] border border-hair-soft p-3" data-row={i}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.4fr_1fr_0.8fr_auto] lg:items-end">
                <SelectField label={t('appt.service')} name={`service-${i}`} value={r.variantId} onChange={(e) => update(r.key, { variantId: e.target.value })}>
                  <option value="">—</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.minutes}>
                      {s.label}{s.minutes ? ` · ${t('appt.minutes', { n: s.minutes })}` : ` · ${t('appt.noDuration')}`}
                    </option>
                  ))}
                </SelectField>
                <SelectField label={t('appt.staff')} name={`staff-${i}`} value={r.staffId} onChange={(e) => update(r.key, { staffId: e.target.value })}>
                  <option value="">—</option>
                  {options.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
                  {/* Keep a chosen staff member visible even if they no longer do the service: the server says why. */}
                  {r.staffId && !options.some((s) => s.id === r.staffId) && <option value={r.staffId}>{staff.find((s) => s.id === r.staffId)?.displayName ?? '—'}</option>}
                </SelectField>
                <TextField label={t('common.date')} name={`date-${i}`} type="date" value={r.date} onChange={(e) => update(r.key, { date: e.target.value })} />
                <TextField label={t('appt.time')} name={`time-${i}`} type="time" step={300} value={r.time} onChange={(e) => update(r.key, { time: e.target.value })} />
                {rows.length > 1 && (
                  <button type="button" className="btn btn-danger" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={t('appt.removeService')}>
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                )}
              </div>
              {r.variantId && r.date && (
                <FreeTimes
                  branch={branch}
                  variantId={r.variantId}
                  date={r.date}
                  selected={{ staffId: r.staffId, time: r.time }}
                  onPick={(staffId, time) => update(r.key, { staffId, time })}
                />
              )}
            </div>
          );
        })}
        {rows.length < 10 && (
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const last = rows.at(-1);
                setRows((rs) => [...rs, { key: next, variantId: '', staffId: last?.staffId ?? '', date: last?.date ?? defaults.date, time: '' }]);
                setNext((n) => n + 1);
              }}
            >
              <Plus aria-hidden className="size-4" /> {t('appt.addService')}
            </button>
          </div>
        )}
      </fieldset>

      <div className="grid gap-3">
        <TextField label={`${t('appt.notes')} (${t('common.optional')})`} name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} hint={t('appt.notesHint')} />
        {customer && (
          <label className="flex items-start gap-2 text-[0.9375rem]">
            <input
              type="checkbox"
              name="remind"
              checked={remind}
              onChange={(e) => {
                setRemind(e.target.checked);
                setRemindTouched(true);
              }}
              className="mt-1 size-4 accent-[var(--color-blue)]"
            />
            <span>
              {t('appt.remind')}
              <span className="block text-[0.8125rem] text-muted">{customer.hasEmail ? t('appt.remindHint') : t('appt.remindNoEmail')}</span>
            </span>
          </label>
        )}
      </div>

      {outside && (
        <div className="flex flex-col gap-2 rounded-[5px] border border-[#ead3a6] bg-amber-bg px-4 py-3 text-[0.875rem] text-[#6b4a12]" role="status" data-testid="outside-hours">
          <p>
            <b>{outside}.</b> {t('appt.outsideHint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={pending} onClick={() => void send(true)}>{t('appt.bookAnyway')}</button>
            <button type="button" className="btn" onClick={() => setOutside(null)}>{t('appt.pickAnother')}</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || missing}>{initial ? t('appt.saveChanges') : t('appt.book')}</button>
        {onDone && <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>}
        <FormError message={error?.message} />
      </div>
    </form>
  );
}

/** Search customers by name, phone, email or code (GET through the BFF) and pick one. */
export function CustomerSearch({ onPick }: { onPick: (c: Picked) => void }) {
  const { t } = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CustomerSummary[] | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v1/customers?${new URLSearchParams({ q: term, limit: '8' })}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((r: { data: CustomerSummary[] }) => setFound(r.data.filter((c) => !c.archivedAt && !c.anonymisedAt)))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q]);
  return (
    <div className="field relative">
      <label htmlFor={id}>{t('appt.findCustomer')}</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <input id={id} name="customerSearch" className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" placeholder={t('appt.findCustomerHint')} />
      </div>
      {found && (
        <ul className="mt-1 grid gap-1 rounded-[5px] border border-hair bg-white p-1" aria-label={t('appt.matches')}>
          {found.length === 0 && <li className="px-2 py-1.5 text-[0.875rem] text-muted">{t('appt.noMatch')}</li>}
          {found.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full rounded-[4px] px-2 py-1.5 text-left hover:bg-paper-deep"
                data-customer={c.id}
                onClick={() => onPick({ id: c.id, name: c.displayName, hasEmail: Boolean(c.email) })}
              >
                <span className="font-semibold">{c.displayName}</span>
                <span className="block text-[0.8125rem] text-muted">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The server's free times for a service on a day, per staff member who does it; a pick fills the row. */
function FreeTimes({ branch, variantId, date, selected, onPick }: { branch: { id: string; timezone: string }; variantId: string; date: string; selected: { staffId: string; time: string }; onPick: (staffId: string, time: string) => void }) {
  const { t } = useT();
  const [data, setData] = useState<Availability | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const ctl = new AbortController();
    setFailed(null);
    fetch(`/api/v1/appointments/availability?${new URLSearchParams({ branchId: branch.id, variantId, date })}`, { signal: ctl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (r.ok) setData(body as Availability);
        else {
          setData(null);
          setFailed((body as { error?: { message?: string } } | null)?.error?.message ?? '');
        }
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [branch.id, variantId, date]);
  if (failed !== null) return <p className="text-[0.8125rem] text-muted">{failed || t('appt.freeFailed')}</p>;
  if (!data) return <p className="text-[0.8125rem] text-muted">{t('appt.freeLoading')}</p>;
  if (data.staff.length === 0) return <p className="text-[0.8125rem] text-muted">{t('appt.noOneDoesIt')}</p>;
  return (
    <div className="grid gap-2" data-testid="free-times">
      <p className="text-[0.8125rem] text-muted">{t('appt.freeTimes', { n: data.minutes })}</p>
      {data.staff.map((s) => {
        const shown = more[s.staffId] ? s.slots : s.slots.slice(0, SLOTS_SHOWN);
        return (
          <div key={s.staffId} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 flex min-w-[7rem] items-center gap-1.5 text-[0.875rem] font-semibold">
              <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: s.color ?? '#8a8f99' }} />
              {s.displayName}
            </span>
            {s.slots.length === 0 && <span className="text-[0.8125rem] text-muted">{t('appt.fullyBooked')}</span>}
            {shown.map((iso) => {
              const time = localParts(iso, branch.timezone).time;
              const on = selected.staffId === s.staffId && selected.time === time;
              return (
                <button
                  key={iso}
                  type="button"
                  data-slot={`${s.displayName} ${time}`}
                  aria-pressed={on}
                  onClick={() => onPick(s.staffId, time)}
                  className={`tag h-7! cursor-pointer px-2! serial ${on ? 'border-blue! bg-blue! text-white!' : 'hover:border-ink/40 hover:text-ink'}`}
                >
                  {time}
                </button>
              );
            })}
            {s.slots.length > SLOTS_SHOWN && !more[s.staffId] && (
              <button type="button" className="text-[0.8125rem] text-blue underline" onClick={() => setMore((m) => ({ ...m, [s.staffId]: true }))}>
                {t('appt.moreTimes', { n: s.slots.length - SLOTS_SHOWN })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
