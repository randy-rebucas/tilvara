'use client';

import { X } from 'lucide-react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { ProductDetail, TaxCategory } from '@/lib/api';

type Variant = ProductDetail['variants'][number];
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const general = (e: { code: string; message: string } | null, own: string[] = []) => (e && !['VALIDATION_FAILED', ...own].includes(e.code) ? e.message : null);

function Actions({ pending, label, close, error }: { pending: boolean; label: string; close: () => void; error: string | null }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{label}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------- product
function ProductFields({ close, product, taxes }: { close: () => void; product: ProductDetail; taxes: TaxCategory[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const description = text(f, 'description');
    const r = await submit('PATCH', `/api/v1/products/${product.id}`, {
      name: text(f, 'name'),
      description: description || null,
      taxCategoryId: f.get('taxCategoryId'),
      ...(product.productType === 'SERVICE' ? {} : { trackInventory: f.get('trackInventory') === 'on' }),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('prod.name')} name="name" required autoFocus defaultValue={product.name} error={fieldError('name')} />
      <SelectField label={t('prod.tax')} name="taxCategoryId" defaultValue={product.taxCategoryId}>
        {taxes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </SelectField>
      <div className="sm:col-span-2">
        <TextField label={`${t('prod.description')} (${t('common.optional')})`} name="description" defaultValue={product.description ?? ''} error={fieldError('description')} />
      </div>
      {product.productType !== 'SERVICE' && (
        <label className="flex items-start gap-2 text-[0.9375rem] sm:col-span-2">
          <input type="checkbox" name="trackInventory" defaultChecked={product.trackInventory} className="mt-1 size-4 accent-[var(--color-blue)]" />
          <span>{t('prod.trackInventory')}<span className="block text-[0.8125rem] text-muted">{t('prod.trackInventoryHint')}</span></span>
        </label>
      )}
      <Actions pending={pending} label={t('common.save')} close={close} error={general(error)} />
    </form>
  );
}

export function EditProduct(props: { product: ProductDetail; taxes: TaxCategory[] }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('prod.edit')}>{(close) => <ProductFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- variants
function AddVariantFields({ close, productId }: { close: () => void; productId: string }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const barcode = text(f, 'barcode');
    const price = text(f, 'price');
    const cost = text(f, 'referenceCost');
    const r = await submit('POST', `/api/v1/products/${productId}/variants`, {
      sku: text(f, 'sku'),
      name: text(f, 'name') || null,
      barcodes: barcode ? [barcode] : [],
      ...(price ? { price } : {}),
      ...(cost ? { referenceCost: cost } : {}),
    }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" noValidate>
      <TextField label={t('prod.variantName')} name="name" required autoFocus placeholder={t('prod.variantNameHint')} error={fieldError('name')} />
      <TextField label={t('prod.sku')} name="sku" required error={fieldError('sku') ?? (error?.code === 'SKU_TAKEN' ? error.message : undefined)} />
      <TextField label={`${t('prod.barcode')} (${t('common.optional')})`} name="barcode" inputMode="numeric" error={fieldError('barcodes.0') ?? (error?.code === 'BARCODE_TAKEN' ? error.message : undefined)} />
      <TextField label={`${t('prod.price')} (${t('common.optional')})`} name="price" inputMode="decimal" placeholder="0.00" error={fieldError('price')} />
      <TextField label={`${t('prod.refCost')} (${t('common.optional')})`} name="referenceCost" inputMode="decimal" placeholder="0.00" error={fieldError('referenceCost')} />
      <Actions pending={pending} label={t('common.create')} close={close} error={general(error, ['SKU_TAKEN', 'BARCODE_TAKEN'])} />
    </form>
  );
}

export function AddVariant({ productId }: { productId: string }) {
  const { t } = useT();
  return <Disclosure label={t('prod.addVariant')}>{(close) => <AddVariantFields close={close} productId={productId} />}</Disclosure>;
}

function VariantFields({ close, variant }: { close: () => void; variant: Variant }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cost = text(f, 'referenceCost');
    const r = await submit('PATCH', `/api/v1/variants/${variant.id}`, { name: text(f, 'name') || null, referenceCost: cost || null });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={`${t('prod.variantName')} (${t('common.optional')})`} name="name" autoFocus defaultValue={variant.name ?? ''} error={fieldError('name')} />
      <TextField label={`${t('prod.refCost')} (${t('common.optional')})`} name="referenceCost" inputMode="decimal" defaultValue={variant.referenceCost ?? ''} hint={t('prod.refCostHint')} error={fieldError('referenceCost')} />
      <Actions pending={pending} label={t('common.save')} close={close} error={general(error)} />
    </form>
  );
}

export function EditVariant({ variant }: { variant: Variant }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('prod.editVariant')}>{(close) => <VariantFields close={close} variant={variant} />}</Disclosure>;
}

/** Scan or type another barcode for this variant (e.g. a new pack design). */
export function AddBarcode({ variantId }: { variantId: string }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const r = await submit('POST', `/api/v1/variants/${variantId}/barcodes`, { code: text(new FormData(form), 'code') });
        if (r.ok) form.reset();
      }}
    >
      <TextField label={t('prod.addBarcode')} name="code" inputMode="numeric" error={fieldError('code') ?? (error?.code === 'BARCODE_TAKEN' ? error.message : undefined)} />
      <button className="btn" disabled={pending}>{t('common.add')}</button>
      <FormError message={general(error, ['BARCODE_TAKEN'])} />
    </form>
  );
}

export function RemoveBarcode({ barcode }: { barcode: { id: string; code: string } }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="tag inline-flex items-center gap-1">
      <span className="serial">{barcode.code}</span>
      <button
        type="button"
        className="rounded-[3px] p-0.5 text-muted hover:text-red"
        aria-label={`${t('prod.removeBarcode')} ${barcode.code}`}
        disabled={pending}
        onClick={() => { if (window.confirm(t('prod.removeBarcodeConfirm', { code: barcode.code }))) void submit('POST', `/api/v1/barcodes/${barcode.id}/archive`, {}); }}
      >
        <X aria-hidden className="size-3.5" />
      </button>
      {error && <FormError message={error.message} />}
    </span>
  );
}
