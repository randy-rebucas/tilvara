'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { TaxCategory, Uom } from '@/lib/api';

function Fields({ close, uoms, taxes, byWeight }: { close: () => void; uoms: Uom[]; taxes: TaxCategory[]; byWeight: boolean }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const barcode = String(f.get('barcode') ?? '').trim();
    const price = String(f.get('price') ?? '').trim();
    const soldBy = byWeight ? String(f.get('soldBy')) : 'UNIT';
    const r = await submit('POST', '/api/v1/products', {
      name: f.get('name'),
      taxCategoryId: f.get('taxCategoryId'),
      uomId: f.get('uomId'),
      soldBy,
      variants: [{ sku: f.get('sku'), barcodes: barcode ? [barcode] : [], ...(price ? { price } : {}) }],
    }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2"><TextField label={t('prod.name')} name="name" required autoFocus error={fieldError('name')} /></div>
      <TextField label={t('prod.sku')} name="sku" required error={fieldError('variants.0.sku') ?? (error?.code === 'SKU_TAKEN' ? error.message : undefined)} />
      <TextField label={t('prod.barcode')} name="barcode" inputMode="numeric" error={fieldError('variants.0.barcodes.0') ?? (error?.code === 'BARCODE_TAKEN' ? error.message : undefined)} />
      <TextField label={t('prod.price')} name="price" inputMode="decimal" placeholder="0.00" error={fieldError('variants.0.price')} />
      <SelectField label={t('prod.unit')} name="uomId" defaultValue={uoms.find((u) => u.code === 'PC')?.id}>
        {uoms.map((u) => <option key={u.id} value={u.id}>{u.code} · {u.name}</option>)}
      </SelectField>
      {/* A restaurant does not sell by weight (business type): its items go by the unit. */}
      {byWeight && (
        <SelectField label={t('prod.soldBy')} name="soldBy" defaultValue="UNIT">
          <option value="UNIT">{t('prod.byUnit')}</option>
          <option value="WEIGHT">{t('prod.byWeight')}</option>
        </SelectField>
      )}
      <SelectField label={t('prod.tax')} name="taxCategoryId" defaultValue={taxes.find((x) => x.code === 'VAT')?.id}>
        {taxes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </SelectField>
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('common.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && !['VALIDATION_FAILED', 'SKU_TAKEN', 'BARCODE_TAKEN'].includes(error.code) ? error.message : null} />
      </div>
    </form>
  );
}

export function AddProduct({ uoms, taxes, byWeight }: { uoms: Uom[]; taxes: TaxCategory[]; byWeight: boolean }) {
  const { t } = useT();
  return <Disclosure label={t('prod.add')}>{(close) => <Fields close={close} uoms={uoms} taxes={taxes} byWeight={byWeight} />}</Disclosure>;
}
