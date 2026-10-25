'use client';

import { X } from 'lucide-react';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { ProductDetail, TaxCategory } from '@/lib/api';
import type { VariantOption } from '@/components/line-items';
import { drugBody } from '@/lib/pharmacy';
import { DrugFields } from '../drug-fields';

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
function ProductFields({ close, product, taxes, categories, pharmacy }: { close: () => void; product: ProductDetail; taxes: TaxCategory[]; categories: { id: string; label: string }[]; pharmacy: boolean }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  // ADR-0025 §2: the medicine section; turning it off makes it an ordinary item again (drug: null).
  const wasDrug = !!product.drugClass;
  const [drug, setDrug] = useState(wasDrug);
  const [expiry, setExpiry] = useState(product.tracksExpiry ?? false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const description = text(f, 'description');
    const r = await submit('PATCH', `/api/v1/products/${product.id}`, {
      name: text(f, 'name'),
      description: description || null,
      taxCategoryId: f.get('taxCategoryId'),
      ...((text(f, 'categoryId') || null) !== product.categoryId ? { categoryId: text(f, 'categoryId') || null } : {}),
      ...(product.productType !== 'STANDARD' ? {} : { trackInventory: f.get('trackInventory') === 'on', tracksExpiry: expiry || drug }),
      ...(product.productType === 'STANDARD' && (drug || wasDrug) ? { drug: drugBody(f, drug) } : {}),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('prod.name')} name="name" required autoFocus defaultValue={product.name} error={fieldError('name')} />
      <SelectField label={t('prod.tax')} name="taxCategoryId" defaultValue={product.taxCategoryId}>
        {taxes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </SelectField>
      {(categories.length > 0 || product.categoryId) && (
        <SelectField label={t('prod.category')} name="categoryId" defaultValue={product.categoryId ?? ''} hint={t('prod.categoryHint')} error={fieldError('categoryId')}>
          <option value="">{t('prod.noCategory')}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </SelectField>
      )}
      <div className="sm:col-span-2">
        <TextField label={`${t('prod.description')} (${t('common.optional')})`} name="description" defaultValue={product.description ?? ''} error={fieldError('description')} />
      </div>
      {product.productType === 'STANDARD' && (
        <label className="flex items-start gap-2 text-[0.9375rem] sm:col-span-2">
          <input type="checkbox" name="trackInventory" defaultChecked={product.trackInventory} className="mt-1 size-4 accent-[var(--color-blue)]" />
          <span>{t('prod.trackInventory')}<span className="block text-[0.8125rem] text-muted">{t('prod.trackInventoryHint')}</span></span>
        </label>
      )}
      {product.productType === 'STANDARD' && (
        <label className="flex items-start gap-2 text-[0.9375rem] sm:col-span-2">
          <input type="checkbox" name="tracksExpiry" checked={expiry || drug} disabled={drug} onChange={(e) => setExpiry(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
          <span>{t('prod.tracksExpiry')}<span className="block text-[0.8125rem] text-muted">{drug ? t('drug.expiryNote') : t('prod.tracksExpiryHint')}</span></span>
        </label>
      )}
      {product.productType === 'STANDARD' && <DrugFields on={drug} onToggle={setDrug} pharmacy={pharmacy} values={product} fieldError={fieldError} />}
      <Actions pending={pending} label={t('common.save')} close={close} error={general(error)} />
    </form>
  );
}

export function EditProduct(props: { product: ProductDetail; taxes: TaxCategory[]; categories: { id: string; label: string }[]; pharmacy: boolean }) {
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

function VariantFields({ close, variant, productType }: { close: () => void; variant: Variant; productType: string }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cost = text(f, 'referenceCost');
    const minutes = text(f, 'serviceMinutes');
    const days = text(f, 'packageValidDays');
    const r = await submit('PATCH', `/api/v1/variants/${variant.id}`, {
      name: text(f, 'name') || null,
      referenceCost: cost || null,
      ...(productType === 'SERVICE' ? { serviceMinutes: minutes ? Number(minutes) : null } : {}),
      ...(productType === 'PACKAGE' ? { packageValidDays: days ? Number(days) : null } : {}),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={`${t('prod.variantName')} (${t('common.optional')})`} name="name" autoFocus defaultValue={variant.name ?? ''} error={fieldError('name')} />
      <TextField label={`${t('prod.refCost')} (${t('common.optional')})`} name="referenceCost" inputMode="decimal" defaultValue={variant.referenceCost ?? ''} hint={t('prod.refCostHint')} error={fieldError('referenceCost')} />
      {productType === 'SERVICE' && <TextField label={t('prod.serviceMinutes')} name="serviceMinutes" type="number" min={5} max={720} step={5} inputMode="numeric" defaultValue={variant.serviceMinutes ?? ''} hint={t('prod.serviceMinutesHint')} error={fieldError('serviceMinutes')} />}
      {productType === 'PACKAGE' && <TextField label={`${t('prod.packageValidDays')} (${t('common.optional')})`} name="packageValidDays" type="number" min={1} max={3650} inputMode="numeric" defaultValue={variant.packageValidDays ?? ''} hint={t('prod.packageValidDaysHint')} error={fieldError('packageValidDays')} />}
      <Actions pending={pending} label={t('common.save')} close={close} error={general(error)} />
    </form>
  );
}

export function EditVariant({ variant, productType = 'STANDARD' }: { variant: Variant; productType?: string }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('prod.editVariant')}>{(close) => <VariantFields close={close} variant={variant} productType={productType} />}</Disclosure>;
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

// ---------------------------------------------------------------- packs and pieces (ADR-0020)
function PackLinkFields({ close, variants, packVariantId }: { close: () => void; variants: VariantOption[]; packVariantId: string | undefined }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/pack-conversions', {
      packVariantId: f.get('packVariantId'),
      pieceVariantId: f.get('pieceVariantId'),
      piecesPerPack: text(f, 'piecesPerPack'),
      autoOpen: f.get('autoOpen') === 'on',
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <SelectField label={t('prod.packItem')} name="packVariantId" defaultValue={packVariantId}>
        {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </SelectField>
      <SelectField label={t('prod.pieceItem')} name="pieceVariantId" defaultValue="">
        <option value="" disabled>—</option>
        {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </SelectField>
      <TextField label={t('prod.piecesPerPack')} name="piecesPerPack" inputMode="decimal" placeholder="20" required error={fieldError('piecesPerPack') ?? (error?.code === 'FRACTIONAL_PIECES' ? error.message : undefined)} />
      <label className="col-span-full flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="autoOpen" defaultChecked className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('prod.autoOpen')}</span>
      </label>
      <Actions pending={pending} label={t('common.add')} close={close} error={general(error, ['FRACTIONAL_PIECES']) ?? fieldError('pieceVariantId') ?? null} />
    </form>
  );
}

/** Link a pack to the piece sold from it; `variants` are the stock-counted items. */
export function AddPackLink(props: { variants: VariantOption[]; packVariantId: string | undefined }) {
  const { t } = useT();
  return <Disclosure label={t('prod.addPack')}>{(close) => <PackLinkFields close={close} {...props} />}</Disclosure>;
}

// ---------------------------------------------------------------- store barcode (ADR-0021 §4)
/** An in-store EAN-13 (starting 29) for a variant that has no barcode, ready to print on labels. */
export function MakeBarcode({ variantId }: { variantId: string }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={pending} onClick={() => void submit('POST', `/api/v1/variants/${variantId}/barcodes/generate`, {}, { idempotencyKey: key })}>
        {t('prod.makeBarcode')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

// ---------------------------------------------------------------- package contents (ADR-0022 §6)
type ContentRow = { key: number; serviceVariantId: string; sessions: string };

/** What one package holds: services and how many sessions of each. Saving replaces the contents. */
export function PackageContents({ variantId, services, items }: { variantId: string; services: { id: string; label: string }[]; items: { serviceVariantId: string; sessions: number }[] }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [rows, setRows] = useState<ContentRow[]>(() =>
    items.length ? items.map((i, n) => ({ key: n, serviceVariantId: i.serviceVariantId, sessions: String(i.sessions) })) : [{ key: 0, serviceVariantId: '', sessions: '1' }],
  );
  const [next, setNext] = useState(rows.length);
  const [saved, setSaved] = useState(false);
  const update = (key: number, patch: Partial<ContentRow>) => {
    setSaved(false);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  async function save() {
    const list = rows.filter((r) => r.serviceVariantId).map((r) => ({ serviceVariantId: r.serviceVariantId, sessions: Number(r.sessions) }));
    const r = await submit('PUT', `/api/v1/variants/${variantId}/package-items`, { items: list });
    if (r.ok) setSaved(true);
  }
  return (
    <div className="grid gap-2" data-testid="package-contents">
      {rows.map((r, i) => (
        <div key={r.key} className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_auto]">
          <SelectField label={t('prod.pkgService')} name={`pkgService-${i}`} value={r.serviceVariantId} onChange={(e) => update(r.key, { serviceVariantId: e.target.value })}>
            <option value="">—</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </SelectField>
          <TextField label={t('prod.pkgSessions')} name={`pkgSessions-${i}`} type="number" min={1} max={1000} inputMode="numeric" value={r.sessions} onChange={(e) => update(r.key, { sessions: e.target.value })} />
          <button type="button" className="btn btn-danger" aria-label={t('prod.pkgRemove')} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={rows.length >= 20}
          onClick={() => {
            setRows((rs) => [...rs, { key: next, serviceVariantId: '', sessions: '1' }]);
            setNext((n) => n + 1);
          }}
        >
          {t('prod.pkgAdd')}
        </button>
        <button type="button" className="btn btn-primary" disabled={pending || !rows.some((r) => r.serviceVariantId)} onClick={() => void save()}>{t('prod.pkgSave')}</button>
        {saved && <span role="status" className="text-[0.875rem] text-muted">{t('common.saved')}</span>}
        <FormError message={error?.code === 'VALIDATION_FAILED' ? t('prod.pkgInvalid') : error?.message} />
      </div>
    </div>
  );
}
