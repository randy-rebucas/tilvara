'use client';

import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit, type ValidationIssue } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { TaxCategory, Uom } from '@/lib/api';
import { MAX_COMBINATIONS } from '@/lib/variant-grid';
import { GridPreview, OptionsEditor, useGrid, type OptionRow } from './variant-grid';

type CategoryOption = { id: string; label: string };

function Fields({ close, uoms, taxes, categories }: { close: () => void; uoms: Uom[]; taxes: TaxCategory[]; categories: CategoryOption[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  const [stocked, setStocked] = useState(true);
  const [expiry, setExpiry] = useState(false);
  // Sizes and colours (ADR-0021 §2): every combination becomes a variant of this product.
  const [sized, setSized] = useState(false);
  const [sku, setSku] = useState('');
  const [rows, setRows] = useState<OptionRow[]>([{ name: '', values: '' }, { name: '', values: '' }]);
  const grid = useGrid(sku, rows);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const barcode = String(f.get('barcode') ?? '').trim();
    const price = String(f.get('price') ?? '').trim();
    const cost = String(f.get('referenceCost') ?? '').trim();
    const soldBy = String(f.get('soldBy') ?? 'UNIT');
    if (sized && (grid.tooMany || grid.list.length === 0)) return;
    const variants = sized
      ? grid.list.map((c) => ({ sku: c.sku, name: c.name, attributes: c.attributes, barcodes: [], ...(price ? { price } : {}), ...(cost ? { referenceCost: cost } : {}) }))
      : [{ sku: f.get('sku'), barcodes: barcode ? [barcode] : [], ...(price ? { price } : {}), ...(cost ? { referenceCost: cost } : {}) }];
    const r = await submit('POST', '/api/v1/products', {
      name: f.get('name'),
      taxCategoryId: f.get('taxCategoryId'),
      uomId: f.get('uomId'),
      ...(String(f.get('categoryId') ?? '') ? { categoryId: f.get('categoryId') } : {}),
      soldBy,
      trackInventory: stocked,
      tracksExpiry: stocked && expiry,
      variants,
    }, { idempotent: true });
    if (r.ok) close();
  }
  // A refused grid row (e.g. an SKU already used by another product) names its row in the issues.
  const rowIssues = ((error?.details?.issues as ValidationIssue[] | undefined) ?? []).filter((i) => /^variants\.\d+\./.test(i.path));
  const gridMessage = sized && rowIssues.length
    ? rowIssues.map((i) => `${grid.list[Number(i.path.split('.')[1])]?.sku ?? i.path}: ${i.message}`).join(' · ')
    : null;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2"><TextField label={t('prod.name')} name="name" required autoFocus error={fieldError('name')} /></div>
      <TextField
        label={sized ? t('vgrid.baseSku') : t('prod.sku')}
        name="sku"
        required
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        hint={sized ? t('vgrid.baseSkuHint') : undefined}
        error={sized ? undefined : (fieldError('variants.0.sku') ?? (error?.code === 'SKU_TAKEN' ? error.message : undefined))}
      />
      {!sized && <TextField label={t('prod.barcode')} name="barcode" inputMode="numeric" error={fieldError('variants.0.barcodes.0') ?? (error?.code === 'BARCODE_TAKEN' ? error.message : undefined)} />}
      <TextField label={t('prod.price')} name="price" inputMode="decimal" placeholder="0.00" hint={sized ? t('vgrid.priceHint') : undefined} error={fieldError('variants.0.price')} />
      {sized && <TextField label={`${t('prod.refCost')} (${t('common.optional')})`} name="referenceCost" inputMode="decimal" placeholder="0.00" error={fieldError('variants.0.referenceCost')} />}
      <SelectField label={t('prod.unit')} name="uomId" defaultValue={uoms.find((u) => u.code === 'PC')?.id}>
        {uoms.map((u) => <option key={u.id} value={u.id}>{u.code} · {u.name}</option>)}
      </SelectField>
      <SelectField label={t('prod.soldBy')} name="soldBy" defaultValue="UNIT">
        <option value="UNIT">{t('prod.byUnit')}</option>
        <option value="WEIGHT">{t('prod.byWeight')}</option>
      </SelectField>
      <SelectField label={t('prod.tax')} name="taxCategoryId" defaultValue={taxes.find((x) => x.code === 'VAT')?.id}>
        {taxes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </SelectField>
      {/* Sales are grouped by it in Reports → By category. */}
      {categories.length > 0 && (
        <SelectField label={`${t('prod.category')} (${t('common.optional')})`} name="categoryId" defaultValue="" error={fieldError('categoryId')}>
          <option value="">{t('prod.noCategory')}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </SelectField>
      )}
      {/* Off for a fee, gift wrapping or anything not counted on a shelf. */}
      <label className="col-span-full flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" name="trackInventory" checked={stocked} onChange={(e) => setStocked(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('prod.trackInventory')}<span className="block text-[0.8125rem] text-muted">{t('prod.trackInventoryHint')}</span></span>
      </label>
      {/* ADR-0020: dated stock (expiry lots) for any counted item. */}
      <label className={`col-span-full flex items-start gap-2 text-[0.9375rem] ${stocked ? '' : 'text-muted'}`}>
        <input type="checkbox" name="tracksExpiry" checked={stocked && expiry} disabled={!stocked} onChange={(e) => setExpiry(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('prod.tracksExpiry')}<span className="block text-[0.8125rem] text-muted">{t('prod.tracksExpiryHint')}</span></span>
      </label>
      <label className="col-span-full flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" checked={sized} onChange={(e) => setSized(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('vgrid.toggle')}<span className="block text-[0.8125rem] text-muted">{t('vgrid.toggleHint')}</span></span>
      </label>
      {sized && (
        <div className="col-span-full flex flex-col gap-3 rounded-[5px] border border-hair-soft p-3">
          <p className="font-semibold">{t('vgrid.title')}</p>
          <OptionsEditor rows={rows} onChange={setRows} />
          {grid.tooMany ? (
            <FormError message={t('vgrid.tooMany', { n: grid.count, max: MAX_COMBINATIONS })} />
          ) : (
            <p className="text-[0.9375rem]" role="status">{grid.list.length ? t('vgrid.willMake', { n: grid.list.length }) : t('vgrid.needBase')}</p>
          )}
          <GridPreview rows={grid.list} />
          <FormError message={gridMessage} />
        </div>
      )}
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || (sized && (grid.tooMany || grid.list.length === 0))}>{sized && grid.list.length ? t('vgrid.createN', { n: grid.list.length }) : t('common.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && !['VALIDATION_FAILED', 'BARCODE_TAKEN', ...(sized ? [] : ['SKU_TAKEN'])].includes(error.code) ? error.message : error?.code === 'VALIDATION_FAILED' && sized && !gridMessage && !fieldError('name') ? t('vgrid.err') : null} />
      </div>
    </form>
  );
}

export function AddProduct({ uoms, taxes, categories = [] }: { uoms: Uom[]; taxes: TaxCategory[]; categories?: CategoryOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('prod.add')}>{(close) => <Fields close={close} uoms={uoms} taxes={taxes} categories={categories} />}</Disclosure>;
}
