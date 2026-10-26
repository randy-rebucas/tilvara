'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
/** CODE_TAKEN shows under the code field; validation issues under their fields. */
const general = (e: { code: string; message: string } | null) => (e && !['VALIDATION_FAILED', 'CODE_TAKEN'].includes(e.code) ? e.message : null);

function Actions({ pending, close, error }: { pending: boolean; close: () => void; error: string | null }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{t('common.create')}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={error} />
    </div>
  );
}

/** A unit of measure (catalog.manage): code such as BOX or KG, a name, and whether it may be counted in fractions. */
function UomFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/uoms', { code: text(f, 'code').toUpperCase(), name: text(f, 'name'), allowsFraction: f.get('allowsFraction') === 'on' });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 @lg:grid-cols-3" noValidate>
      <TextField label={t('units.code')} name="code" required autoFocus maxLength={10} autoCapitalize="characters" hint={t('units.codeHint')} error={fieldError('code') ?? (error?.code === 'CODE_TAKEN' ? error.message : undefined)} />
      <TextField label={t('common.name')} name="name" required maxLength={200} placeholder={t('units.namePlaceholder')} error={fieldError('name')} />
      <label className="flex items-start gap-2 self-end pb-2 text-[0.9375rem]">
        <input type="checkbox" name="allowsFraction" className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('units.fraction')}<span className="block text-[0.8125rem] text-muted">{t('units.fractionHint')}</span></span>
      </label>
      <Actions pending={pending} close={close} error={general(error)} />
    </form>
  );
}

export function AddUom() {
  const { t } = useT();
  return <Disclosure label={t('units.add')}>{(close) => <UomFields close={close} />}</Disclosure>;
}

/** A tax category (tax.manage): which VAT treatment its products take. Rates live in the tax engine, not here. */
function TaxFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/tax-categories', { code: text(f, 'code').toUpperCase(), name: text(f, 'name'), vatTreatment: text(f, 'vatTreatment') });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 @lg:grid-cols-3" noValidate>
      <TextField label={t('units.code')} name="code" required autoFocus maxLength={30} autoCapitalize="characters" hint={t('units.taxCodeHint')} error={fieldError('code') ?? (error?.code === 'CODE_TAKEN' ? error.message : undefined)} />
      <TextField label={t('common.name')} name="name" required maxLength={200} error={fieldError('name')} />
      <SelectField label={t('units.vat')} name="vatTreatment" defaultValue="VATABLE" hint={t('units.vatHint')} error={fieldError('vatTreatment')}>
        <option value="VATABLE">{t('units.vat.VATABLE')}</option>
        <option value="VAT_EXEMPT">{t('units.vat.VAT_EXEMPT')}</option>
        <option value="ZERO_RATED">{t('units.vat.ZERO_RATED')}</option>
      </SelectField>
      <Actions pending={pending} close={close} error={general(error)} />
    </form>
  );
}

export function AddTaxCategory() {
  const { t } = useT();
  return <Disclosure label={t('units.addTax')}>{(close) => <TaxFields close={close} />}</Disclosure>;
}
