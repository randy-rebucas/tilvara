'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

/** datetime-local is read as Manila wall-clock time (UTC+08:00, no DST). */
const manilaToIso = (local: string) => new Date(`${local}:00+08:00`).toISOString();

/**
 * A new tax profile version: from now or a future date (never backdated). Rates are the standard
 * ones (12% VAT / 3% percentage tax); past sales keep the profile they were made with.
 */
function Fields({ close, legalEntityId, current }: { close: () => void; legalEntityId: string; current: 'VAT' | 'NON_VAT' | null }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  const [when, setWhen] = useState<'now' | 'later'>('later');
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const at = String(f.get('effectiveAt') ?? '');
    const note = String(f.get('note') ?? '').trim();
    const r = await submit('POST', `/api/v1/legal-entities/${legalEntityId}/tax-profiles`, {
      vatStatus: f.get('vatStatus'),
      roundingMode: f.get('roundingMode'),
      ...(when === 'later' && at ? { effectiveFrom: manilaToIso(at) } : {}),
      note: note || null,
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <p className="col-span-full -mt-1 text-[0.875rem] text-muted">{t('tax.changeHint')}</p>
      <SelectField label={t('loc.vat')} name="vatStatus" defaultValue={current === 'VAT' ? 'NON_VAT' : 'VAT'}>
        <option value="VAT">{t('tax.vatOption')}</option>
        <option value="NON_VAT">{t('tax.nonVatOption')}</option>
      </SelectField>
      <SelectField label={t('tax.rounding')} name="roundingMode" defaultValue="HALF_UP">
        <option value="HALF_UP">{t('tax.HALF_UP')}</option>
        <option value="HALF_EVEN">{t('tax.HALF_EVEN')}</option>
      </SelectField>
      <SelectField label={t('tax.effective')} value={when} onChange={(e) => setWhen(e.target.value as 'now' | 'later')}>
        <option value="later">{t('tax.fromDate')}</option>
        <option value="now">{t('tax.fromNow')}</option>
      </SelectField>
      {when === 'later' && <TextField label={`${t('tax.effective')} (Asia/Manila)`} name="effectiveAt" type="datetime-local" required error={fieldError('effectiveFrom')} />}
      <div className="col-span-full">
        <TextField label={`${t('tax.note')} (${t('common.optional')})`} name="note" placeholder={t('tax.noteHint')} error={fieldError('note')} />
      </div>
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('tax.save')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

export function ChangeTaxForm(props: { legalEntityId: string; current: 'VAT' | 'NON_VAT' | null }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('tax.change')}>{(close) => <Fields close={close} {...props} />}</Disclosure>;
}
