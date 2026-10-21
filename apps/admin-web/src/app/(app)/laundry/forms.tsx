'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/messages';
import type { GarmentType, LaundryMachine, LaundrySettings } from '@/lib/api';

const general = (e: { code: string; message: string } | null) => (e && e.code !== 'VALIDATION_FAILED' ? e.message : null);
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const int = (f: FormData, k: string) => Number.parseInt(str(f, k), 10);
const optInt = (f: FormData, k: string) => (str(f, k) ? int(f, k) : null);

/**
 * A branch's laundry settings (ADR-0024 §3, §6, §9): turnaround hours, the items the server adds
 * (express, delivery, storage fee), when reminders, the final notice and "unclaimed" come, the
 * claim policy printed on the stub, and SMS (sent once a provider is set up).
 */
export function LaundrySettingsForm({ settings, services }: { settings: LaundrySettings; services: { id: string; label: string }[] }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [saved, setSaved] = useState(false);
  const [policy, setPolicy] = useState(settings.claimPolicyText ?? '');
  const pick = (name: string, label: string, value: string | null, hint: string) => (
    <SelectField label={label} name={name} defaultValue={value ?? ''} hint={hint} error={fieldError(name)}>
      <option value="">{t('lau.none')}</option>
      {services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </SelectField>
  );
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const f = new FormData(e.currentTarget);
        const days = str(f, 'reminderDays').split(/[\s,]+/).filter(Boolean).map((d) => Number.parseInt(d, 10));
        const r = await submit('PATCH', `/api/v1/branches/${settings.branchId}/laundry-settings`, {
          regularHours: int(f, 'regularHours'),
          expressHours: int(f, 'expressHours'),
          expressVariantId: str(f, 'expressVariantId') || null,
          deliveryVariantId: str(f, 'deliveryVariantId') || null,
          storageFeeVariantId: str(f, 'storageFeeVariantId') || null,
          storageFreeDays: optInt(f, 'storageFreeDays'),
          unclaimedDays: int(f, 'unclaimedDays'),
          finalNoticeDays: int(f, 'finalNoticeDays'),
          reminderDays: days,
          claimPolicyText: policy.trim() || null,
          smsEnabled: f.get('smsEnabled') === 'on',
        });
        if (r.ok) setSaved(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label={t('lau.regularHours')} name="regularHours" type="number" min={1} max={720} required defaultValue={String(settings.regularHours)} error={fieldError('regularHours')} />
        <TextField label={t('lau.expressHours')} name="expressHours" type="number" min={1} max={168} required defaultValue={String(settings.expressHours)} error={fieldError('expressHours')} />
        {pick('expressVariantId', t('lau.expressItem'), settings.expressVariantId, t('lau.expressItemHint'))}
        {pick('deliveryVariantId', t('lau.deliveryItem'), settings.deliveryVariantId, t('lau.deliveryItemHint'))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label={t('lau.reminderDays')} name="reminderDays" defaultValue={settings.reminderDays.join(', ')} hint={t('lau.reminderDaysHint')} error={fieldError('reminderDays')} />
        <TextField label={t('lau.unclaimedDays')} name="unclaimedDays" type="number" min={7} max={365} required defaultValue={String(settings.unclaimedDays)} hint={t('lau.unclaimedDaysHint')} error={fieldError('unclaimedDays')} />
        <TextField label={t('lau.finalNoticeDays')} name="finalNoticeDays" type="number" min={1} max={30} required defaultValue={String(settings.finalNoticeDays)} hint={t('lau.finalNoticeDaysHint')} error={fieldError('finalNoticeDays')} />
        <TextField label={`${t('lau.storageFreeDays')} (${t('common.optional')})`} name="storageFreeDays" type="number" min={0} max={365} defaultValue={settings.storageFreeDays === null ? '' : String(settings.storageFreeDays)} hint={t('lau.storageFreeDaysHint')} error={fieldError('storageFreeDays')} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {pick('storageFeeVariantId', t('lau.storageItem'), settings.storageFeeVariantId, t('lau.storageItemHint'))}
      </div>
      <div className="field">
        <label htmlFor="claimPolicyText">{t('lau.claimPolicy')}</label>
        <textarea id="claimPolicyText" name="claimPolicyText" className="input min-h-[6rem]" maxLength={1000} value={policy} onChange={(e) => setPolicy(e.target.value)} />
        <p className="hint">{t('lau.claimPolicyHint')}</p>
        {!policy && <div><button type="button" className="btn btn-sm mt-1" onClick={() => setPolicy(t('lau.claimPolicyDefault'))}>{t('lau.useSuggested')}</button></div>}
        {fieldError('claimPolicyText') && <p className="hint text-red!">{fieldError('claimPolicyText')}</p>}
      </div>
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="smsEnabled" defaultChecked={settings.smsEnabled} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('lau.smsEnabled')}<span className="block text-[0.8125rem] text-muted">{t('lau.smsEnabledHint')}</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        {saved && <span role="status" className="text-[0.875rem]">{t('common.saved')}</span>}
        <FormError message={general(error)} />
      </div>
    </form>
  );
}

/** Add a garment type to the branch-wide list the drop-off form counts (shirts, pants, beddings). */
export function AddGarmentType() {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const r = await submit('POST', '/api/v1/laundry/garment-types', { name: str(new FormData(form), 'garmentName') }, { idempotent: true });
        if (r.ok) form.reset();
      }}
    >
      <TextField label={t('lau.addGarmentType')} name="garmentName" required maxLength={60} placeholder={t('lau.garmentHint')} error={fieldError('name')} />
      <button className="btn" disabled={pending}>{t('common.add')}</button>
      <FormError message={general(error)} />
    </form>
  );
}

export function GarmentTypeChip({ type }: { type: GarmentType }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="tag inline-flex items-center gap-1.5" data-garment-type={type.name}>
      {type.name}
      <button type="button" className="text-[0.75rem] text-muted underline hover:text-red" disabled={pending} onClick={() => { if (window.confirm(t('lau.archiveGarmentConfirm', { name: type.name }))) void submit('PATCH', `/api/v1/laundry/garment-types/${type.id}`, { archived: true }); }}>
        {t('common.archive')}
      </button>
      {error && <FormError message={error.message} />}
    </span>
  );
}

const KINDS = ['WASHER', 'DRYER'] as const;

export function AddMachine({ branchId }: { branchId: string }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure label={t('lau.addMachine')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const cap = str(f, 'capacityKg');
            const r = await submit('POST', '/api/v1/laundry/machines', { branchId, kind: str(f, 'kind'), label: str(f, 'machineLabel'), ...(cap && { capacityKg: cap }), cycleMinutes: int(f, 'cycleMinutes') }, { idempotent: true });
            // The panel stays open for the next machine.
            if (r.ok) form.reset();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField label={t('lau.machineKind')} name="kind" error={fieldError('kind')}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`lau.kind.${k}` as MessageKey)}</option>)}
            </SelectField>
            <TextField label={t('lau.machineLabel')} name="machineLabel" required maxLength={30} placeholder="W1" error={fieldError('label')} />
            <TextField label={`${t('lau.capacityKg')} (${t('common.optional')})`} name="capacityKg" inputMode="decimal" placeholder="8" error={fieldError('capacityKg')} />
            <TextField label={t('lau.cycleMinutes')} name="cycleMinutes" type="number" min={1} max={240} required defaultValue="35" error={fieldError('cycleMinutes')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('lau.addMachine')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.done')}</button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}

export function EditMachine({ machine }: { machine: LaundryMachine }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <Disclosure kind="edit" label={t('lau.editMachine')}>
      {(close) => (
        <form
          noValidate
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const cap = str(f, 'capacityKg');
            const reason = str(f, 'outOfOrderReason');
            const r = await submit('PATCH', `/api/v1/laundry/machines/${machine.id}`, {
              label: str(f, 'machineLabel'),
              capacityKg: cap || null,
              cycleMinutes: int(f, 'cycleMinutes'),
              outOfOrderReason: reason || null,
            });
            if (r.ok) close();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('lau.machineLabel')} name="machineLabel" required maxLength={30} defaultValue={machine.label} error={fieldError('label')} />
            <TextField label={`${t('lau.capacityKg')} (${t('common.optional')})`} name="capacityKg" inputMode="decimal" defaultValue={machine.capacityKg ?? ''} error={fieldError('capacityKg')} />
            <TextField label={t('lau.cycleMinutes')} name="cycleMinutes" type="number" min={1} max={240} required defaultValue={String(machine.cycleMinutes)} error={fieldError('cycleMinutes')} />
            <TextField label={`${t('lau.outOfOrder')} (${t('common.optional')})`} name="outOfOrderReason" maxLength={200} defaultValue={machine.outOfOrderReason ?? ''} hint={t('lau.outOfOrderHint')} error={fieldError('outOfOrderReason')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={async () => { if ((await submit('PATCH', `/api/v1/laundry/machines/${machine.id}`, { archived: true })).ok) close(); }}>
              {t('common.archive')}
            </button>
            <FormError message={general(error)} />
          </div>
        </form>
      )}
    </Disclosure>
  );
}
