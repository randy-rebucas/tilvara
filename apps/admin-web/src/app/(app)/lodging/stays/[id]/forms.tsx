'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { HousekeepingStatus, Room, Stay, StayGuest } from '@/lib/api';
import { peso, signOf } from '@/lib/format';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const Check = ({ name, label, hint, defaultChecked = false }: { name: string; label: string; hint?: string; defaultChecked?: boolean }) => (
  <label className="flex items-start gap-2 text-[0.9375rem]">
    <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-1 size-4 accent-[var(--color-blue)]" />
    <span>
      {label}
      {hint && <span className="block text-[0.8125rem] text-muted">{hint}</span>}
    </span>
  </label>
);

/** Move, extend, shorten, change the guests, rate or charges (§3); the server re-checks double booking. */
export function EditStay({ stay, rooms, canRates }: { stay: Stay; rooms: Room[]; canRates: boolean }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const inHouse = stay.status === 'IN_HOUSE';
  return (
    <Disclosure kind="edit" label={t('lod.editStay')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const rate = str(f, 'nightlyRate');
            const limit = str(f, 'chargeLimit');
            const allow = f.get('allowCharges') === 'on';
            const body: Record<string, unknown> = {
              roomId: str(f, 'roomId'),
              departureDate: str(f, 'departureDate'),
              adults: Number.parseInt(str(f, 'adults'), 10),
              children: Number.parseInt(str(f, 'children') || '0', 10),
              allowCharges: allow,
              chargeLimit: allow && limit ? limit : null,
              notes: str(f, 'stayNotes') || null,
            };
            if (!inHouse) body.arrivalDate = str(f, 'arrivalDate');
            if (!stay.customerId) body.guestName = str(f, 'guestName') || null;
            if (canRates) body.nightlyRate = rate || null;
            // Only what changed: an unchanged rate or room needs no permission and no re-check.
            for (const [k, v] of Object.entries(body)) if (v === (stay as unknown as Record<string, unknown>)[k]) delete body[k];
            if (Object.keys(body).length === 0) return close();
            const r = await submit('PATCH', `/api/v1/stays/${stay.id}`, body);
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField label={t('lod.room')} name="roomId" defaultValue={stay.roomId} error={fieldError('roomId')}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.roomType?.name ?? ''}</option>)}
            </SelectField>
            <TextField label={t('lod.arrival')} name="arrivalDate" type="date" defaultValue={stay.arrivalDate} disabled={inHouse} hint={inHouse ? t('lod.arrivalFixed') : undefined} error={fieldError('arrivalDate')} />
            <TextField label={t('lod.departure')} name="departureDate" type="date" defaultValue={stay.departureDate} error={fieldError('departureDate')} />
            {!stay.customerId && <TextField label={t('lod.guestName')} name="guestName" defaultValue={stay.guestName ?? ''} maxLength={120} error={fieldError('guestName')} />}
            <TextField label={t('lod.adults')} name="adults" type="number" min={1} max={20} defaultValue={String(stay.adults)} error={fieldError('adults')} />
            <TextField label={t('lod.children')} name="children" type="number" min={0} max={20} defaultValue={String(stay.children)} error={fieldError('children')} />
            {canRates && <TextField label={`${t('lod.nightlyRate')} (${t('common.optional')})`} name="nightlyRate" inputMode="decimal" defaultValue={stay.nightlyRate ?? ''} hint={t('lod.nightlyRateHint')} error={fieldError('nightlyRate')} />}
            <TextField label={`${t('lod.chargeLimit')} (${t('common.optional')})`} name="chargeLimit" inputMode="decimal" defaultValue={stay.chargeLimit ?? ''} error={fieldError('chargeLimit')} />
          </div>
          <Check name="allowCharges" label={t('lod.allowCharges')} defaultChecked={stay.allowCharges} />
          <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="stayNotes" defaultValue={stay.notes ?? ''} maxLength={500} />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error) ?? (error ? t('lod.checkFields') : null)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Check in (§4): the room ready (or overridden, audited), the primary guest in the registry, deposits now or at check-out. */
export function CheckIn({ stayId, roomStatus, hasPrimary, depositsHeld }: { stayId: string; roomStatus: HousekeepingStatus | undefined; hasPrimary: boolean; depositsHeld: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [open, setOpen] = useState(false);
  const ready = roomStatus === 'CLEAN' || roomStatus === 'INSPECTED';
  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{t('lod.checkIn')}</button>;
  return (
    <form
      noValidate
      className="flex w-full flex-col gap-3 rounded-[5px] border border-hair bg-white p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await submit('POST', `/api/v1/stays/${stayId}/check-in`, { overrideHousekeeping: f.get('override') === 'on', applyDeposits: f.get('applyDeposits') === 'on' });
        if (r.ok) setOpen(false);
      }}
    >
      <p className="font-semibold">{t('lod.checkIn')}</p>
      {!hasPrimary && <p className="text-[0.875rem] text-[#6b4a12]" role="status">{t('lod.needPrimaryGuest')}</p>}
      {!ready && roomStatus && <Check name="override" label={t('lod.overrideHousekeeping')} hint={t('lod.overrideHousekeepingHint')} />}
      {signOf(depositsHeld) > 0 && <Check name="applyDeposits" label={t('lod.applyDepositsNow', { amount: peso(depositsHeld) })} hint={t('lod.applyDepositsHint')} />}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('lod.checkIn')}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        <FormError message={error?.message} />
      </div>
    </form>
  );
}

/** Cancel a booking or mark a no-show (§3, §6), with what happens to the deposit held. */
export function EndStay({ stayId, kind, depositsHeld, forfeitDefault, canRates }: { stayId: string; kind: 'cancel' | 'no-show'; depositsHeld: string; forfeitDefault: boolean; canRates: boolean }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<'FORFEIT' | 'REFUND'>(forfeitDefault ? 'FORFEIT' : 'REFUND');
  const held = signOf(depositsHeld) > 0;
  const label = kind === 'cancel' ? t('lod.cancelBooking') : t('lod.markNoShow');
  if (!open) return <button type="button" className={`btn ${kind === 'cancel' ? 'btn-danger' : ''}`} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form
      noValidate
      className="flex w-full flex-col gap-3 rounded-[5px] border border-hair bg-white p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await submit('POST', `/api/v1/stays/${stayId}/${kind}`, {
          reason: str(f, 'reason'),
          ...(held && { deposits: choice }),
          ...(held && choice === 'REFUND' && { refund: { method: 'BANK_TRANSFER', reference: str(f, 'refundReference') } }),
        });
        if (r.ok) setOpen(false);
      }}
    >
      <p className="font-semibold">{label}</p>
      <TextField label={t('common.reason')} name="reason" required autoFocus maxLength={200} error={fieldError('reason')} />
      {held && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.875rem] font-semibold">{t('lod.depositHeldIs', { amount: peso(depositsHeld) })}</legend>
          {(['FORFEIT', 'REFUND'] as const).map((c) => (
            <label key={c} className="flex items-start gap-2 text-[0.9375rem]">
              <input type="radio" name="deposits" value={c} checked={choice === c} onChange={() => setChoice(c)} disabled={c === 'REFUND' && forfeitDefault && !canRates} className="mt-1" />
              <span>
                {t(c === 'FORFEIT' ? 'lod.keepDeposit' : 'lod.refundDeposit')}
                {(c === 'FORFEIT') === forfeitDefault && <span className="text-muted"> · {t('lod.branchDefault')}</span>}
              </span>
            </label>
          ))}
          {choice === 'REFUND' && <TextField label={t('lod.bankReference')} name="refundReference" required maxLength={64} hint={t('lod.refundBankHint')} error={fieldError('refund.reference')} />}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className={`btn ${kind === 'cancel' ? 'btn-danger' : 'btn-primary'}`} disabled={pending}>{label}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

/**
 * Check-out (§4): charge every night still due and apply the deposits, then check out once the folio
 * is at zero. Payments are taken at the till (a drawer); the back office settles nothing itself.
 */
export function CheckOut({ stayId, balance }: { stayId: string; balance: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [early, setEarly] = useState(false);
  const [ready, setReady] = useState<{ balance: string; depositsHeld: string } | null>(null);
  const zero = signOf(ready?.balance ?? balance) === 0;
  return (
    <div className="flex w-full flex-col gap-3 rounded-[5px] border border-hair bg-white p-4" data-testid="check-out">
      <p className="font-semibold">{t('lod.checkOut')}</p>
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="departEarly" checked={early} onChange={(e) => setEarly(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>
          {t('lod.departEarly')}
          <span className="block text-[0.8125rem] text-muted">{t('lod.departEarlyHint')}</span>
        </span>
      </label>
      {ready && (
        <p role="status" className="text-[0.875rem]" data-testid="prepared">
          {t('lod.preparedBalance', { balance: peso(ready.balance) })}
          {signOf(ready.depositsHeld) > 0 && <> {t('lod.preparedDeposit', { amount: peso(ready.depositsHeld) })}</>}
        </p>
      )}
      {!zero && <p className="text-[0.8125rem] text-muted">{t('lod.payAtTill')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn ${zero ? '' : 'btn-primary'}`}
          disabled={pending}
          onClick={async () => {
            const r = await submit<{ balance: string; depositsHeld: string }>('POST', `/api/v1/stays/${stayId}/prepare-check-out`, { departEarly: early });
            if (r.ok) setReady(r.data);
          }}
        >
          {t('lod.prepareCheckOut')}
        </button>
        <button type="button" className={`btn ${zero ? 'btn-primary' : ''}`} disabled={pending || !zero} onClick={() => void submit('POST', `/api/v1/stays/${stayId}/check-out`, { departEarly: early })}>
          {t('lod.checkOut')}
        </button>
        <FormError message={error?.message} />
      </div>
    </div>
  );
}

const GUEST_FIELDS = ['fullName', 'nationality', 'idType', 'idNumber', 'address', 'birthDate', 'contact'] as const;

/** A registry entry (§8): what the front desk records for the registration card. Personal data. */
export function GuestForm({ stayId, guest, first = false }: { stayId: string; guest?: StayGuest; first?: boolean }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind={guest ? 'edit' : 'add'} label={guest ? t('lod.editGuest') : t('lod.addGuest')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body: Record<string, unknown> = {};
            for (const k of GUEST_FIELDS) {
              const v = str(f, `guest-${k}`);
              if (guest) body[k] = v || null;
              else if (v) body[k] = v;
            }
            if (guest) body.fullName = str(f, 'guest-fullName');
            const primary = f.get('guest-primary') === 'on';
            if (!guest || primary !== guest.isPrimary) body.isPrimary = primary;
            const r = await submit(guest ? 'PATCH' : 'POST', guest ? `/api/v1/stays/${stayId}/guests/${guest.id}` : `/api/v1/stays/${stayId}/guests`, body);
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('lod.g.fullName')} name="guest-fullName" required maxLength={120} defaultValue={guest?.fullName ?? ''} error={fieldError('fullName')} />
            <TextField label={`${t('lod.g.nationality')} (${t('common.optional')})`} name="guest-nationality" maxLength={60} defaultValue={guest?.nationality ?? ''} />
            <TextField label={`${t('lod.g.idType')} (${t('common.optional')})`} name="guest-idType" maxLength={40} defaultValue={guest?.idType ?? ''} placeholder={t('lod.g.idTypeHint')} />
            <TextField label={`${t('lod.g.idNumber')} (${t('common.optional')})`} name="guest-idNumber" maxLength={64} defaultValue={guest?.idNumber ?? ''} />
            <TextField label={`${t('lod.g.address')} (${t('common.optional')})`} name="guest-address" maxLength={300} defaultValue={guest?.address ?? ''} />
            <TextField label={`${t('lod.g.birthDate')} (${t('common.optional')})`} name="guest-birthDate" type="date" defaultValue={guest?.birthDate ?? ''} error={fieldError('birthDate')} />
            <TextField label={`${t('lod.g.contact')} (${t('common.optional')})`} name="guest-contact" maxLength={120} defaultValue={guest?.contact ?? ''} />
          </div>
          <Check name="guest-primary" label={t('lod.g.primary')} hint={t('lod.g.primaryHint')} defaultChecked={guest ? guest.isPrimary : first} />
          <p className="text-[0.8125rem] text-muted">{t('lod.registryPrivacy')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{guest ? t('common.save') : t('lod.addGuest')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error) ?? (error ? t('lod.checkFields') : null)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** An SC/PWD guest (§7): each night takes the statutory discount on their share (default 1 ÷ guests). */
export function BeneficiaryForm({ stayId }: { stayId: string }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.addBeneficiary')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('POST', `/api/v1/stays/${stayId}/beneficiaries`, { scheme: str(f, 'scheme'), name: str(f, 'benName'), idNumber: str(f, 'benId') });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField label={t('lod.scheme')} name="scheme" defaultValue="SC">
              <option value="SC">{t('lod.scheme.SC')}</option>
              <option value="PWD">{t('lod.scheme.PWD')}</option>
            </SelectField>
            <TextField label={t('lod.g.fullName')} name="benName" required maxLength={200} error={fieldError('name')} />
            <TextField label={t('lod.g.idNumber')} name="benId" required maxLength={64} error={fieldError('idNumber')} />
          </div>
          <p className="text-[0.8125rem] text-muted">{t('lod.beneficiaryHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.addBeneficiary')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** A deposit paid into the bank (§6; `lodging.rates`). Cash and card deposits are taken at the till. */
export function ReceiveDeposit({ stayId }: { stayId: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.receiveDeposit')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await submit('POST', `/api/v1/stays/${stayId}/deposits`, { method: 'BANK_TRANSFER', amount: str(f, 'depositAmount'), reference: str(f, 'depositReference') }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t('lod.depositAmount')} name="depositAmount" inputMode="decimal" required error={fieldError('amount')} />
            <TextField label={t('lod.bankReference')} name="depositReference" required maxLength={64} error={fieldError('reference')} />
          </div>
          <p className="text-[0.8125rem] text-muted">{t('lod.depositHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.receiveDeposit')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** Refund (part of) the deposit held by bank transfer (§6). */
export function RefundDeposit({ stayId, held }: { stayId: string; held: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.refundDepositAction')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const amount = str(f, 'refundAmount');
            const r = await submit('POST', `/api/v1/stays/${stayId}/deposits/refund`, { ...(amount && { amount }), reason: str(f, 'refundReason'), refund: { method: 'BANK_TRANSFER', reference: str(f, 'refundReference') } }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={`${t('lod.depositAmount')} (${t('common.optional')})`} name="refundAmount" inputMode="decimal" placeholder={held} hint={t('lod.refundAllHint')} error={fieldError('amount')} />
            <TextField label={t('common.reason')} name="refundReason" required maxLength={200} error={fieldError('reason')} />
            <TextField label={t('lod.bankReference')} name="refundReference" required maxLength={64} error={fieldError('refund.reference')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.refundDepositAction')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

/** A goodwill credit (negative) or a manual fee (positive) on the folio, VAT-inclusive (`lodging.rates`). */
export function FolioAdjustment({ folioId }: { folioId: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lod.addAdjustment')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const description = str(f, 'adjDescription');
            const r = await submit('POST', `/api/v1/folios/${folioId}/adjustments`, { amount: str(f, 'adjAmount').replace('−', '-'), reason: str(f, 'adjReason'), ...(description && { description }) }, { idempotencyKey: key });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={t('lod.adjAmount')} name="adjAmount" inputMode="decimal" required placeholder="-500.00" hint={t('lod.adjAmountHint')} error={fieldError('amount')} />
            <TextField label={`${t('lod.adjDescription')} (${t('common.optional')})`} name="adjDescription" maxLength={120} placeholder={t('lod.adjDescriptionHint')} />
            <TextField label={t('common.reason')} name="adjReason" required maxLength={200} error={fieldError('reason')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lod.addAdjustment')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}
