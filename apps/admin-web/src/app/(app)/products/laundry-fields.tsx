'use client';

import { SelectField, TextField } from '@/components/fields';
import { useT } from '@/i18n/client';
import type { LaundryUnit, LaundryVariantFields, MachineKind } from '@/lib/api';

/** The choices that change which other laundry fields show (the rest are read from the form). */
export interface LaundryDraft {
  unit: LaundryUnit | '';
  addon: boolean;
  machineKind: MachineKind | '';
}

export const draftOf = (v: LaundryVariantFields): LaundryDraft => ({ unit: v.laundryUnit ?? '', addon: v.laundryAddon ?? false, machineKind: v.machineKind ?? '' });

/**
 * A variant's laundry fields as the API takes them (ADR-0024 §2, §7). A service gets a unit (per kilo,
 * load or piece) with its minimum and kilos per load, or a machine cycle; any item may be an add-on.
 * Empty fields are sent as null so a change can clear them.
 */
export function laundryBody(f: FormData, d: LaundryDraft, service: boolean) {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const minutes = s('machineMinutes');
  return {
    laundryAddon: d.addon,
    ...(service && {
      laundryUnit: d.unit || null,
      laundryMinQuantity: d.unit ? s('laundryMinQuantity') || null : null,
      laundryKgPerLoad: d.unit === 'LOAD' ? s('laundryKgPerLoad') || null : null,
      machineKind: d.machineKind || null,
      machineMinutes: d.machineKind && minutes ? Number.parseInt(minutes, 10) : null,
    }),
  };
}

export function LaundryFields({
  draft,
  onChange,
  service,
  values = {},
  fieldError,
}: {
  draft: LaundryDraft;
  onChange: (d: LaundryDraft) => void;
  service: boolean;
  values?: LaundryVariantFields;
  fieldError: (key: string) => string | undefined;
}) {
  const { t } = useT();
  return (
    <div className="col-span-full grid gap-3 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="laundry-fields">
      <p className="font-semibold sm:col-span-2 lg:col-span-4">{t('prod.laundryTitle')}</p>
      {service && (
        <>
          <SelectField label={t('prod.laundryUnit')} name="laundryUnit" value={draft.unit} onChange={(e) => onChange({ ...draft, unit: e.target.value as LaundryUnit | '' })} hint={t('prod.laundryUnitHint')} error={fieldError('laundryUnit')}>
            <option value="">{t('prod.laundryUnit.none')}</option>
            <option value="KG">{t('prod.laundryUnit.KG')}</option>
            <option value="LOAD">{t('prod.laundryUnit.LOAD')}</option>
            <option value="PIECE">{t('prod.laundryUnit.PIECE')}</option>
          </SelectField>
          {draft.unit && <TextField label={`${t('prod.laundryMin')} (${t('common.optional')})`} name="laundryMinQuantity" inputMode="decimal" defaultValue={values.laundryMinQuantity ?? ''} placeholder={draft.unit === 'KG' ? '3' : '1'} hint={t('prod.laundryMinHint')} error={fieldError('laundryMinQuantity')} />}
          {draft.unit === 'LOAD' && <TextField label={t('prod.laundryKgPerLoad')} name="laundryKgPerLoad" inputMode="decimal" defaultValue={values.laundryKgPerLoad ?? ''} placeholder="8" hint={t('prod.laundryKgPerLoadHint')} error={fieldError('laundryKgPerLoad')} />}
          {draft.unit === 'KG' && <p className="self-end pb-2 text-[0.8125rem] text-muted">{t('prod.laundryKgByWeight')}</p>}
        </>
      )}
      <label className="flex items-start gap-2 text-[0.9375rem] sm:col-span-2 lg:col-span-4">
        <input type="checkbox" checked={draft.addon} onChange={(e) => onChange({ ...draft, addon: e.target.checked })} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('prod.laundryAddon')}<span className="block text-[0.8125rem] text-muted">{t('prod.laundryAddonHint')}</span></span>
      </label>
      {service && (
        <>
          <SelectField label={t('prod.machineCycle')} name="machineKind" value={draft.machineKind} onChange={(e) => onChange({ ...draft, machineKind: e.target.value as MachineKind | '' })} hint={t('prod.machineCycleHint')} error={fieldError('machineKind')}>
            <option value="">{t('prod.machineCycle.none')}</option>
            <option value="WASHER">{t('lau.kind.WASHER')}</option>
            <option value="DRYER">{t('lau.kind.DRYER')}</option>
          </SelectField>
          {draft.machineKind && <TextField label={t('prod.machineMinutes')} name="machineMinutes" type="number" min={1} max={240} required defaultValue={values.machineMinutes ? String(values.machineMinutes) : ''} placeholder="30" error={fieldError('machineMinutes')} />}
        </>
      )}
    </div>
  );
}
