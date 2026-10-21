'use client';

import { SelectField, TextField } from '@/components/fields';
import { useT } from '@/i18n/client';
import { extraFor } from '@/i18n/titles';
import type { MessageKey } from '@/i18n/messages';
import type { DrugClass, Product } from '@/lib/api';
import { DOSAGE_FORMS, drugClassesFor } from '@/lib/pharmacy';

/**
 * A product's medicine details (ADR-0025 §2): class, generic name, strength, dosage form and FDA
 * registration number. A medicine keeps expiry dates (the API refuses one that does not). Prescription
 * classes are offered only to a pharmacy; over the counter is for every type (an agrivet store).
 */
export function DrugFields({
  on,
  onToggle,
  pharmacy,
  values,
  fieldError,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  pharmacy: boolean;
  values?: Pick<Product, 'drugClass' | 'genericName' | 'strength' | 'dosageForm' | 'fdaRegistrationNo'>;
  fieldError: (key: string) => string | undefined;
}) {
  const { t, lang } = useT();
  return (
    <div className="col-span-full grid gap-3 rounded-[5px] border border-hair-soft p-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="drug-fields">
      <label className="flex items-start gap-2 text-[0.9375rem] sm:col-span-2 lg:col-span-4">
        <input type="checkbox" name="isDrug" checked={on} onChange={(e) => onToggle(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span className="font-semibold">{t('drug.section')}<span className="block text-[0.8125rem] font-normal text-muted">{t('drug.sectionHint')}</span></span>
      </label>
      {on && (
        <>
          <SelectField label={t('drug.class')} name="drugClass" defaultValue={values?.drugClass ?? 'OTC'} hint={pharmacy ? t('drug.classHint') : t('drug.classOtcOnly')} error={fieldError('drug.drugClass')}>
            {drugClassesFor(pharmacy, values?.drugClass).map((c) => <option key={c} value={c}>{t(`drug.class.${c}` as MessageKey)}</option>)}
          </SelectField>
          <TextField label={t('drug.generic')} name="genericName" required maxLength={200} defaultValue={values?.genericName ?? ''} placeholder={extraFor(lang, 'example.genericOtc')} error={fieldError('drug.genericName')} />
          <TextField label={`${t('drug.strength')} (${t('common.optional')})`} name="strength" maxLength={60} defaultValue={values?.strength ?? ''} placeholder="500 mg" error={fieldError('drug.strength')} />
          <SelectField label={t('drug.form')} name="dosageForm" defaultValue={values?.dosageForm ?? 'TABLET'} error={fieldError('drug.dosageForm')}>
            {DOSAGE_FORMS.map((d) => <option key={d} value={d}>{t(`drug.form.${d}` as MessageKey)}</option>)}
          </SelectField>
          <TextField label={`${t('drug.fda')} (${t('common.optional')})`} name="fdaRegistrationNo" maxLength={40} defaultValue={values?.fdaRegistrationNo ?? ''} placeholder="DR-XY12345" error={fieldError('drug.fdaRegistrationNo')} />
        </>
      )}
    </div>
  );
}

/** The class as a small badge (Rx, Antibiotic, DD); nothing for an ordinary item. */
export function DrugBadge({ drugClass }: { drugClass: DrugClass | null | undefined }) {
  const { t } = useT();
  if (!drugClass) return null;
  const look = drugClass === 'DANGEROUS' ? 'tag border-red/50! text-red!' : drugClass === 'OTC' ? 'tag' : 'tag border-blue/40! text-blue!';
  return <span className={look} data-drug-class={drugClass}>{t(`drug.badge.${drugClass}` as MessageKey)}</span>;
}
