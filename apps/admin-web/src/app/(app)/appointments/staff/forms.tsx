'use client';

import { Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { ServiceStaff } from '@/lib/api';
import { STAFF_COLOURS, zonedInstant } from '@/lib/calendar';
import { percentFromRate, rateFromPercent } from '@/lib/format';

export interface MemberOption {
  id: string;
  name: string;
}
export interface ServiceOption {
  id: string;
  label: string;
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);

// ---------------------------------------------------------------- the staff member
function StaffFields({ close, branchId, staff, members, suggestColour, showRate }: { close: () => void; branchId: string; staff?: ServiceStaff; members: MemberOption[] | null; suggestColour: string; showRate: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const { pending, submit, fieldError, error, setError } = useSubmit();
  const [rateError, setRateError] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const percent = text(f, 'commission');
    const rate = percent === '' ? '0' : rateFromPercent(percent);
    if (rate === null) {
      setRateError(t('sstaff.rateInvalid'));
      return;
    }
    setRateError(null);
    setError(null);
    const body = {
      displayName: text(f, 'displayName'),
      membershipId: members ? text(f, 'membershipId') || null : undefined,
      color: text(f, 'color') || null,
      ...(showRate ? { commissionRate: rate } : {}),
    };
    if (staff) {
      const r = await submit('PATCH', `/api/v1/service-staff/${staff.id}`, body);
      if (r.ok) close();
      return;
    }
    const r = await submit<{ id: string }>('POST', '/api/v1/service-staff', { branchId, ...body }, { idempotencyKey: key, refresh: false });
    if (r.ok) router.push(`/appointments/staff/${r.data.id}`);
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <TextField label={t('sstaff.name')} name="displayName" required autoFocus maxLength={80} defaultValue={staff?.displayName} hint={t('sstaff.nameHint')} error={fieldError('displayName')} />
      {members && (
        <SelectField label={`${t('sstaff.member')} (${t('common.optional')})`} name="membershipId" defaultValue={staff?.membershipId ?? ''} hint={t('sstaff.memberHint')} error={fieldError('membershipId')}>
          <option value="">{t('sstaff.noMember')}</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </SelectField>
      )}
      <div className="field">
        <label htmlFor="staff-colour">{t('sstaff.colour')}</label>
        <input id="staff-colour" name="color" type="color" className="input h-[38.4px] w-24 p-1" defaultValue={staff?.color ?? suggestColour} />
      </div>
      {showRate && (
        <TextField
          label={t('sstaff.commission')}
          name="commission"
          inputMode="decimal"
          placeholder="0"
          defaultValue={staff?.commissionRate ? percentFromRate(staff.commissionRate) : ''}
          hint={t('sstaff.commissionHint')}
          error={rateError ?? fieldError('commissionRate')}
        />
      )}
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{staff ? t('common.save') : t('sstaff.add')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function AddStaff(props: { branchId: string; members: MemberOption[] | null; suggestColour: string; showRate: boolean }) {
  const { t } = useT();
  return <Disclosure label={t('sstaff.add')}>{(close) => <StaffFields close={close} {...props} />}</Disclosure>;
}

export function EditStaff(props: { branchId: string; staff: ServiceStaff; members: MemberOption[] | null; showRate: boolean }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('sstaff.edit')}>{(close) => <StaffFields close={close} suggestColour={props.staff.color ?? STAFF_COLOURS[0]!} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- services they do
/** Every service, or only some (each with an optional rate of its own). Saving replaces the list. */
export function StaffServices({ staff, services, showRate }: { staff: ServiceStaff; services: ServiceOption[]; showRate: boolean }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [every, setEvery] = useState(staff.services.length === 0);
  const [chosen, setChosen] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(staff.services.map((s) => [s.variantId, s.commissionRate ? percentFromRate(s.commissionRate) : ''])),
  );
  const [rateError, setRateError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save() {
    setSaved(false);
    const list: { variantId: string; commissionRate?: string | null }[] = [];
    if (!every) {
      for (const [variantId, percent] of Object.entries(chosen)) {
        if (percent === null) continue;
        const rate = percent === '' ? null : rateFromPercent(percent);
        if (percent !== '' && rate === null) {
          setRateError(t('sstaff.rateInvalid'));
          return;
        }
        list.push({ variantId, ...(showRate ? { commissionRate: rate } : {}) });
      }
    }
    setRateError(null);
    const r = await submit('PUT', `/api/v1/service-staff/${staff.id}/services`, { services: list });
    if (r.ok) setSaved(true);
  }
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-4 text-[0.9375rem]">
        <label className="flex items-center gap-2">
          <input type="radio" name="every" checked={every} onChange={() => setEvery(true)} className="accent-[var(--color-blue)]" /> {t('sstaff.everyService')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="every" checked={!every} onChange={() => setEvery(false)} className="accent-[var(--color-blue)]" /> {t('sstaff.onlySome')}
        </label>
      </div>
      {!every && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {services.length === 0 && <li className="text-[0.875rem] text-muted">{t('appt.noServices')}</li>}
          {services.map((s) => {
            const on = chosen[s.id] !== undefined && chosen[s.id] !== null;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 flex-1 items-start gap-2 text-[0.9375rem]">
                  <input
                    type="checkbox"
                    name="service"
                    value={s.id}
                    checked={on}
                    onChange={(e) => setChosen((c) => ({ ...c, [s.id]: e.target.checked ? (c[s.id] ?? '') : null }))}
                    className="mt-1 size-4 accent-[var(--color-blue)]"
                  />
                  <span className="min-w-0">{s.label}</span>
                </label>
                {on && showRate && (
                  <input
                    aria-label={t('sstaff.ownRate', { name: s.label })}
                    className="input h-8! w-24"
                    inputMode="decimal"
                    placeholder={t('sstaff.defaultRate')}
                    value={chosen[s.id] ?? ''}
                    onChange={(e) => setChosen((c) => ({ ...c, [s.id]: e.target.value }))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!every && showRate && <p className="text-[0.8125rem] text-muted">{t('sstaff.ownRateHint')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void save()}>{t('sstaff.saveServices')}</button>
        {saved && <span role="status" className="text-[0.875rem] text-muted">{t('common.saved')}</span>}
        <FormError message={rateError ?? error?.message} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- weekly hours
type Span = { key: number; startsAt: string; endsAt: string };
/** Monday first, as a week is read; the API numbers Sunday 0. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The weekly hours, a day at a time (several spans for a split shift). Saving replaces them all. */
export function StaffHours({ staff }: { staff: ServiceStaff }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [seq, setSeq] = useState(staff.hours.length);
  const [days, setDays] = useState<Record<number, Span[]>>(() =>
    Object.fromEntries(WEEK.map((d) => [d, staff.hours.filter((h) => h.weekday === d).map((h, i) => ({ key: d * 100 + i, startsAt: h.startsAt, endsAt: h.endsAt }))])),
  );
  const [saved, setSaved] = useState(false);
  const nextKey = () => {
    setSeq((s) => s + 1);
    return 10_000 + seq;
  };
  const setDay = (d: number, spans: Span[]) => {
    setSaved(false);
    setDays((all) => ({ ...all, [d]: spans }));
  };
  async function save() {
    const hours = WEEK.flatMap((d) => days[d]!.filter((s) => s.startsAt && s.endsAt).map((s) => ({ weekday: d, startsAt: s.startsAt, endsAt: s.endsAt })));
    const r = await submit('PUT', `/api/v1/service-staff/${staff.id}/hours`, { hours });
    if (r.ok) setSaved(true);
  }
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {WEEK.map((d) => (
          <li key={d} className="grid items-start gap-2 border-t border-hair-soft pt-2 first:border-t-0 first:pt-0 sm:grid-cols-[7rem_1fr]" data-weekday={d}>
            <span className="pt-1.5 font-semibold">{t(`appt.weekday.${d}` as MessageKey)}</span>
            <div className="flex flex-wrap items-center gap-2">
              {days[d]!.length === 0 && <span className="text-[0.875rem] text-muted">{t('sstaff.dayOff')}</span>}
              {days[d]!.map((s) => (
                <span key={s.key} className="flex items-center gap-1">
                  <input
                    type="time"
                    aria-label={t('sstaff.from', { day: t(`appt.weekday.${d}` as MessageKey) })}
                    name={`from-${d}`}
                    className="input h-8! w-[7.5rem]"
                    value={s.startsAt}
                    onChange={(e) => setDay(d, days[d]!.map((x) => (x.key === s.key ? { ...x, startsAt: e.target.value } : x)))}
                  />
                  <span aria-hidden>–</span>
                  <input
                    type="time"
                    aria-label={t('sstaff.until', { day: t(`appt.weekday.${d}` as MessageKey) })}
                    name={`until-${d}`}
                    className="input h-8! w-[7.5rem]"
                    value={s.endsAt}
                    onChange={(e) => setDay(d, days[d]!.map((x) => (x.key === s.key ? { ...x, endsAt: e.target.value } : x)))}
                  />
                  <button type="button" className="grid size-8 place-items-center rounded-[4px] text-muted hover:text-red" aria-label={t('sstaff.removeSpan')} onClick={() => setDay(d, days[d]!.filter((x) => x.key !== s.key))}>
                    <X aria-hidden className="size-4" />
                  </button>
                </span>
              ))}
              <button type="button" className="btn h-8! px-2.5!" onClick={() => setDay(d, [...days[d]!, { key: nextKey(), startsAt: days[d]!.at(-1)?.endsAt ?? '09:00', endsAt: '18:00' }])}>
                <Plus aria-hidden className="size-4" /> {t('sstaff.addSpan')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void save()}>{t('sstaff.saveHours')}</button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const monday = days[1]!;
            setSaved(false);
            setDays((all) => ({ ...all, ...Object.fromEntries([2, 3, 4, 5].map((d) => [d, monday.map((s, i) => ({ ...s, key: d * 100 + i + 50 }))])) }));
          }}
        >
          {t('sstaff.copyMonday')}
        </button>
        {saved && <span role="status" className="text-[0.875rem] text-muted">{t('common.saved')}</span>}
        <FormError message={error?.code === 'VALIDATION_FAILED' ? t('sstaff.hoursInvalid') : error?.message} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- time off
function TimeOffFields({ close, staffId, timezone }: { close: () => void; staffId: string; timezone: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const at = (k: string) => {
      const v = text(f, k);
      return v ? zonedInstant(v.slice(0, 10), v.slice(11, 16), timezone) : '';
    };
    const reason = text(f, 'reason');
    const r = await submit('POST', `/api/v1/service-staff/${staffId}/time-off`, { startsAt: at('startsAt'), endsAt: at('endsAt'), ...(reason ? { reason } : {}) }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <TextField label={t('sstaff.offFrom')} name="startsAt" type="datetime-local" required error={fieldError('startsAt')} />
      <TextField label={t('sstaff.offUntil')} name="endsAt" type="datetime-local" required error={fieldError('endsAt')} />
      <TextField label={`${t('common.reason')} (${t('common.optional')})`} name="reason" maxLength={200} error={fieldError('reason')} />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.add')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

export function AddTimeOff(props: { staffId: string; timezone: string }) {
  const { t } = useT();
  return <Disclosure label={t('sstaff.addTimeOff')}>{(close) => <TimeOffFields close={close} {...props} />}</Disclosure>;
}

/** DELETE through the BFF (narrowly allowed for this path), then refresh the page. */
export function RemoveTimeOff({ staffId, timeOffId }: { staffId: string; timeOffId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-danger h-8!"
        disabled={pending}
        onClick={() => {
          if (window.confirm(t('sstaff.removeTimeOffConfirm'))) void submit('DELETE', `/api/v1/service-staff/${staffId}/time-off/${timeOffId}`);
        }}
      >
        <Trash2 aria-hidden className="size-4" /> {t('sstaff.removeTimeOff')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}
