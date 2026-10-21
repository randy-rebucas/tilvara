'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/note';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { LodgingAvailability, Room, RoomType, Stay } from '@/lib/api';
import { send } from '@/lib/client-api';
import { CustomerSearch } from '../../appointments/booking-form';

const SOURCES = ['WALK_IN', 'PHONE', 'ONLINE', 'OTA', 'OTHER'] as const;
const money = (s: string) => /^\d{1,16}(\.\d{1,4})?$/.test(s);

/**
 * Book a room (ADR-0023 §3): the dates, a room (the server's free rooms for those nights are marked),
 * the customer (searched) or a guest's name, guests, an agreed rate (`lodging.rates`), charges to the
 * room and their limit, and a deposit paid by bank transfer. The server refuses a double booking.
 */
export function StayBookingForm({
  branchId,
  rooms,
  types,
  defaults,
  canRates,
  canSearchCustomers,
}: {
  branchId: string;
  rooms: Room[];
  types: RoomType[];
  defaults: { arrival: string; departure: string; roomId: string };
  canRates: boolean;
  canSearchCustomers: boolean;
}) {
  const { t } = useT();
  const router = useRouter();
  const key = useFormKey();
  const depositKey = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const [arrival, setArrival] = useState(defaults.arrival);
  const [departure, setDeparture] = useState(defaults.departure);
  const [roomId, setRoomId] = useState(defaults.roomId || '');
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [guestName, setGuestName] = useState('');
  const [free, setFree] = useState<LodgingAvailability | null>(null);
  const [freeError, setFreeError] = useState<string | null>(null);
  const [allowCharges, setAllowCharges] = useState(true);
  const [depositIssue, setDepositIssue] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ id: string; depositError: string } | null>(null);

  useEffect(() => {
    setFree(null);
    setFreeError(null);
    if (!arrival || !departure || departure <= arrival) return;
    const ctl = new AbortController();
    fetch(`/api/v1/lodging/availability?${new URLSearchParams({ branchId, from: arrival, to: departure })}`, { signal: ctl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (r.ok) setFree(body as LodgingAvailability);
        else setFreeError((body as { error?: { message?: string } } | null)?.error?.message ?? '');
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [branchId, arrival, departure]);

  const freeRoom = (id: string) => free?.rooms.find((r) => r.roomId === id)?.availableAllNights ?? null;
  const typeOf = (r: Room) => types.find((x) => x.id === r.roomTypeId);
  const room = rooms.find((r) => r.id === roomId);
  const max = room ? typeOf(room)?.maxOccupancy : undefined;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const rate = s('nightlyRate');
    const limit = s('chargeLimit');
    const ref = s('externalReference');
    const notes = s('stayNotes');
    const deposit = s('depositAmount');
    setDepositIssue(null);
    if (canRates && deposit && (!money(deposit) || !s('depositReference'))) {
      setDepositIssue(t('lod.depositNeedsReference'));
      return;
    }
    const r = await submit<Stay>('POST', '/api/v1/stays', {
      branchId,
      roomId,
      arrivalDate: arrival,
      departureDate: departure,
      ...(customer ? { customerId: customer.id } : { guestName: guestName.trim() }),
      adults: Number.parseInt(s('adults') || '1', 10),
      children: Number.parseInt(s('children') || '0', 10),
      source: s('source') || 'WALK_IN',
      allowCharges,
      ...(rate && { nightlyRate: rate }),
      ...(allowCharges && limit && { chargeLimit: limit }),
      ...(ref && { externalReference: ref }),
      ...(notes && { notes }),
    }, { idempotencyKey: key, refresh: false });
    if (!r.ok) return;
    if (canRates && deposit) {
      // The stay is booked; the deposit is its own record (bank transfer: no drawer in the back office).
      const d = await send('POST', `/api/v1/stays/${r.data.id}/deposits`, { method: 'BANK_TRANSFER', amount: deposit, reference: s('depositReference') }, { idempotencyKey: depositKey });
      if (!d.ok) {
        setBooked({ id: r.data.id, depositError: d.error.message });
        return;
      }
    }
    router.push(`/lodging/stays/${r.data.id}`);
  }

  if (booked) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="warn">{t('lod.bookedDepositFailed', { message: booked.depositError })}</Callout>
        <div><Link href={`/lodging/stays/${booked.id}`} className="btn btn-primary">{t('lod.openStay')}</Link></div>
      </div>
    );
  }

  const missing = !roomId || !arrival || !departure || departure <= arrival || (!customer && !guestName.trim());

  return (
    <form noValidate className="flex flex-col gap-5" onSubmit={onSubmit}>
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('lod.dates')}</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label={t('lod.arrival')} name="arrivalDate" type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} required error={fieldError('arrivalDate')} />
          <TextField label={t('lod.departure')} name="departureDate" type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} required error={fieldError('departureDate')} />
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('lod.room')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label={t('lod.room')} name="roomId" value={roomId} onChange={(e) => setRoomId(e.target.value)} error={fieldError('roomId')}>
            <option value="">—</option>
            {rooms.map((r) => {
              const ok = freeRoom(r.id);
              return (
                <option key={r.id} value={r.id}>
                  {r.number} · {typeOf(r)?.name ?? r.roomType?.name ?? ''}{ok === null ? '' : ok ? ` · ${t('lod.free')}` : ` · ${t('lod.taken')}`}
                </option>
              );
            })}
          </SelectField>
        </div>
        {freeError !== null ? (
          <p className="text-[0.8125rem] text-muted">{freeError || t('lod.freeFailed')}</p>
        ) : free ? (
          <div className="flex flex-wrap gap-1.5" data-testid="free-rooms">
            <span className="mr-1 text-[0.8125rem] text-muted">{t('lod.freeRooms')}</span>
            {free.rooms.filter((r) => r.availableAllNights).length === 0 && <span className="text-[0.8125rem] text-muted">{t('lod.noFreeRooms')}</span>}
            {free.rooms.filter((r) => r.availableAllNights).map((r) => (
              <button
                key={r.roomId}
                type="button"
                data-free-room={r.number}
                aria-pressed={roomId === r.roomId}
                onClick={() => setRoomId(r.roomId)}
                className={`tag h-7! cursor-pointer px-2! serial ${roomId === r.roomId ? 'border-blue! bg-blue! text-white!' : 'hover:border-ink/40 hover:text-ink'}`}
              >
                {r.number} · {t(`lod.hk.${r.housekeepingStatus}` as MessageKey)}
              </button>
            ))}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('lod.guest')}</legend>
        {customer ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag h-8! px-3! text-[0.9375rem]! text-ink!" data-testid="picked-customer">{customer.name}</span>
            <button type="button" className="btn" onClick={() => setCustomer(null)}><X aria-hidden className="size-4" /> {t('appt.changeClient')}</button>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {canSearchCustomers && <CustomerSearch onPick={(c) => setCustomer({ id: c.id, name: c.name })} />}
            <TextField label={t('lod.guestName')} name="guestName" value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={120} hint={t('lod.guestNameHint')} error={fieldError('guestName')} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label={t('lod.adults')} name="adults" type="number" min={1} max={20} defaultValue="1" hint={max ? t('lod.maxGuests', { n: max }) : undefined} error={fieldError('adults')} />
          <TextField label={t('lod.children')} name="children" type="number" min={0} max={20} defaultValue="0" error={fieldError('children')} />
          <SelectField label={t('lod.source')} name="source" defaultValue="WALK_IN">
            {SOURCES.map((s) => <option key={s} value={s}>{t(`lod.source.${s}` as MessageKey)}</option>)}
          </SelectField>
          <TextField label={`${t('lod.externalReference')} (${t('common.optional')})`} name="externalReference" maxLength={64} error={fieldError('externalReference')} />
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 font-semibold">{t('lod.rateAndCharges')}</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {canRates && (
            <TextField label={`${t('lod.nightlyRate')} (${t('common.optional')})`} name="nightlyRate" inputMode="decimal" hint={t('lod.nightlyRateHint')} error={fieldError('nightlyRate')} />
          )}
          {allowCharges && <TextField label={`${t('lod.chargeLimit')} (${t('common.optional')})`} name="chargeLimit" inputMode="decimal" hint={t('lod.chargeLimitHint')} error={fieldError('chargeLimit')} />}
        </div>
        <label className="flex items-start gap-2 text-[0.9375rem]">
          <input type="checkbox" name="allowCharges" checked={allowCharges} onChange={(e) => setAllowCharges(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
          <span>
            {t('lod.allowCharges')}
            <span className="block text-[0.8125rem] text-muted">{t('lod.allowChargesHint')}</span>
          </span>
        </label>
        {!canRates && <p className="text-[0.8125rem] text-muted">{t('lod.rackRateOnly')}</p>}
      </fieldset>

      {canRates && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 font-semibold">{t('lod.deposit')}</legend>
          <p className="-mt-1 text-[0.8125rem] text-muted">{t('lod.depositHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={`${t('lod.depositAmount')} (${t('common.optional')})`} name="depositAmount" inputMode="decimal" />
            <TextField label={t('lod.bankReference')} name="depositReference" maxLength={64} error={depositIssue ?? undefined} />
          </div>
        </fieldset>
      )}

      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="stayNotes" maxLength={500} error={fieldError('notes')} />

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || missing}>{t('lod.book')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : error ? t('lod.checkFields') : null} />
      </div>
    </form>
  );
}
