'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { HousekeepingStatus, LodgingSettings, Room, RoomType } from '@/lib/api';
import { percentFromRate, rateFromPercent } from '@/lib/format';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const int = (f: FormData, k: string) => Number.parseInt(str(f, k), 10);

/** The night audit now for a branch (ADR-0023 §7): says how many nights it charged. */
export function NightAuditButton({ branchId }: { branchId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={async () => {
          setDone(null);
          const r = await submit<{ nights: number }>('POST', '/api/v1/lodging/night-audit', { branchId });
          if (r.ok) setDone(r.data.nights);
        }}
      >
        {t('lod.runNightAudit')}
      </button>
      {done !== null && <span role="status" className="text-[0.875rem]" data-testid="night-audit-result">{done === 0 ? t('lod.nightAuditNone') : t('lod.nightAuditDone', { n: done })}</span>}
      <FormError message={error?.message} />
    </div>
  );
}

const STATUSES: HousekeepingStatus[] = ['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER'];

/** Housekeeping (§9): one press per status; out of order asks why. */
export function RoomStatusButtons({ roomId, number, status }: { roomId: string; number: string; status: HousekeepingStatus }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [ooo, setOoo] = useState(false);
  const set = (to: HousekeepingStatus, note?: string) => submit('POST', `/api/v1/rooms/${roomId}/status`, { status: to, ...(note && { note }) });
  if (ooo) {
    return (
      <form
        noValidate
        className="grid gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await set('OUT_OF_ORDER', str(new FormData(e.currentTarget), 'note'));
          if (r.ok) setOoo(false);
        }}
      >
        <TextField label={t('lod.oooWhy')} name="note" required autoFocus maxLength={200} error={fieldError('note')} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={pending}>{t('lod.hk.OUT_OF_ORDER')}</button>
          <button type="button" className="btn" onClick={() => setOoo(false)}>{t('common.cancel')}</button>
        </div>
        <FormError message={general(error)} />
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-room-actions={number}>
      {STATUSES.filter((s) => s !== status).map((s) => (
        <button
          key={s}
          type="button"
          className="btn btn-sm"
          disabled={pending}
          data-set={s}
          onClick={() => (s === 'OUT_OF_ORDER' ? setOoo(true) : void set(s))}
        >
          {t(`lod.set.${s}` as MessageKey)}
        </button>
      ))}
      <FormError message={error?.message} />
    </div>
  );
}

// ---------------------------------------------------------------- set-up (§2, §9, §10)

/** A room type with its room-night item made at the rack rate (or an existing service item). */
export function AddRoomType() {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.addRoomType')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const max = str(f, 'maxOccupancy');
            const r = await submit('POST', '/api/v1/room-types', {
              code: str(f, 'typeCode'),
              name: str(f, 'typeName'),
              baseOccupancy: int(f, 'baseOccupancy'),
              ...(max && { maxOccupancy: Number.parseInt(max, 10) }),
              rackRate: str(f, 'rackRate'),
            }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <TextField label={t('lod.code')} name="typeCode" required maxLength={20} placeholder="STD" error={fieldError('code')} />
            <TextField label={t('common.name')} name="typeName" required maxLength={80} placeholder={t('lod.typeNameHint')} error={fieldError('name')} />
            <TextField label={t('lod.baseOccupancy')} name="baseOccupancy" type="number" min={1} max={20} defaultValue="2" required error={fieldError('baseOccupancy')} />
            <TextField label={t('lod.maxOccupancy')} name="maxOccupancy" type="number" min={1} max={20} error={fieldError('maxOccupancy')} />
            <TextField label={t('lod.rackRate')} name="rackRate" inputMode="decimal" required placeholder="2500.00" error={fieldError('rackRate')} />
          </div>
          <p className="text-[0.8125rem] text-muted">{t('lod.rackRateHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.addRoomType')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

export function EditRoomType({ type }: { type: RoomType }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind="edit" label={t('lod.edit')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('PATCH', `/api/v1/room-types/${type.id}`, { name: str(f, 'typeName'), baseOccupancy: int(f, 'baseOccupancy'), maxOccupancy: int(f, 'maxOccupancy') });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={t('common.name')} name="typeName" required maxLength={80} defaultValue={type.name} error={fieldError('name')} />
            <TextField label={t('lod.baseOccupancy')} name="baseOccupancy" type="number" min={1} max={20} defaultValue={String(type.baseOccupancy)} error={fieldError('baseOccupancy')} />
            <TextField label={t('lod.maxOccupancy')} name="maxOccupancy" type="number" min={1} max={20} defaultValue={String(type.maxOccupancy)} error={fieldError('maxOccupancy')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={async () => { if ((await submit('PATCH', `/api/v1/room-types/${type.id}`, { archived: true })).ok) close(); }}>
              {t('common.archive')}
            </button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

export function AddRoom({ branchId, types }: { branchId: string; types: RoomType[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.addRoom')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const floor = str(f, 'floor');
            const notes = str(f, 'roomNotes');
            const r = await submit('POST', '/api/v1/rooms', { branchId, roomTypeId: str(f, 'roomTypeId'), number: str(f, 'roomNumber'), ...(floor && { floor }), ...(notes && { notes }) }, { idempotent: true });
            // The panel stays open for the next room (each submit its own key: a room is not a stock or books document).
            if (r.ok) (e.target as HTMLFormElement).reset();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('lod.roomNumber')} name="roomNumber" required maxLength={20} placeholder="101" error={fieldError('number')} />
            <SelectField label={t('lod.roomType')} name="roomTypeId" required error={fieldError('roomTypeId')}>
              {types.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
            </SelectField>
            <TextField label={`${t('lod.floor')} (${t('common.optional')})`} name="floor" maxLength={20} error={fieldError('floor')} />
            <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="roomNotes" maxLength={500} error={fieldError('notes')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.addRoom')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.done')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

export function EditRoom({ room, types }: { room: Room; types: RoomType[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind="edit" label={t('lod.edit')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('PATCH', `/api/v1/rooms/${room.id}`, { number: str(f, 'roomNumber'), roomTypeId: str(f, 'roomTypeId'), floor: str(f, 'floor') || null, notes: str(f, 'roomNotes') || null });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t('lod.roomNumber')} name="roomNumber" required maxLength={20} defaultValue={room.number} error={fieldError('number')} />
            <SelectField label={t('lod.roomType')} name="roomTypeId" defaultValue={room.roomTypeId} error={fieldError('roomTypeId')}>
              {types.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
            </SelectField>
            <TextField label={`${t('lod.floor')} (${t('common.optional')})`} name="floor" maxLength={20} defaultValue={room.floor ?? ''} />
            <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="roomNotes" maxLength={500} defaultValue={room.notes ?? ''} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={async () => { if ((await submit('PATCH', `/api/v1/rooms/${room.id}`, { archived: true })).ok) close(); }}>
              {t('common.archive')}
            </button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Dates a room cannot be sold (repairs): nights from the first date up to the night before the last. */
export function AddBlock({ rooms, today }: { rooms: Room[]; today: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.addBlock')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('POST', '/api/v1/room-blocks', { roomId: str(f, 'blockRoom'), startsOn: str(f, 'startsOn'), endsOn: str(f, 'endsOn'), reason: str(f, 'blockReason') }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField label={t('lod.room')} name="blockRoom" error={fieldError('roomId')}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.roomType?.code ?? ''}</option>)}
            </SelectField>
            <TextField label={t('lod.blockFrom')} name="startsOn" type="date" defaultValue={today} required error={fieldError('startsOn')} />
            <TextField label={t('lod.blockUntil')} name="endsOn" type="date" required hint={t('lod.blockUntilHint')} error={fieldError('endsOn')} />
            <TextField label={t('common.reason')} name="blockReason" required maxLength={200} error={fieldError('reason')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.addBlock')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** A DELETE with a confirmation (a room block, a registry entry, an SC/PWD guest). */
export function RemoveButton({ url, label, confirmText }: { url: string; label: string; confirmText?: string }) {
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm btn-danger" disabled={pending} onClick={() => { if (!confirmText || window.confirm(confirmText)) void submit('DELETE', url); }}>
        {label}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

/**
 * A branch's lodging settings (§7, §10, §6): when nights are charged, the local accommodation tax
 * (unverified: the business confirms rate and base with its tax adviser), and the cancellation default.
 */
export function LodgingSettingsForm({ settings }: { settings: LodgingSettings }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const f = new FormData(e.currentTarget);
        const pct = str(f, 'taxPercent');
        const rate = pct ? rateFromPercent(pct) : null;
        const r = await submit('PATCH', `/api/v1/branches/${settings.branchId}/lodging-settings`, {
          nightAuditTime: str(f, 'nightAuditTime'),
          accommodationTaxRate: pct ? (rate ?? pct) : null,
          forfeitOnCancel: f.get('forfeitOnCancel') === 'on',
        });
        if (r.ok) setSaved(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('lod.nightAuditTime')} name="nightAuditTime" type="time" required defaultValue={settings.nightAuditTime} hint={t('lod.nightAuditTimeHint')} error={fieldError('nightAuditTime')} />
        <TextField
          label={`${t('lod.accommodationTax')} % (${t('common.optional')})`}
          name="taxPercent"
          inputMode="decimal"
          defaultValue={settings.accommodationTaxRate ? percentFromRate(settings.accommodationTaxRate) : ''}
          hint={t('lod.accommodationTaxHint')}
          error={fieldError('accommodationTaxRate')}
        />
      </div>
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="forfeitOnCancel" defaultChecked={settings.forfeitOnCancel} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>
          {t('lod.forfeitOnCancel')}
          <span className="block text-[0.8125rem] text-muted">{t('lod.forfeitOnCancelHint')}</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        {saved && <span role="status" className="text-[0.875rem]">{t('common.saved')}</span>}
        <FormError message={general(error)} />
      </div>
    </form>
  );
}
