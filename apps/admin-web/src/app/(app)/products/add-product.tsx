'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit, type ValidationIssue } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { TaxCategory, Uom } from '@/lib/api';
import { drugBody } from '@/lib/pharmacy';
import { DrugFields } from './drug-fields';
import { LaundryFields, laundryBody, type LaundryDraft } from './laundry-fields';
import { MAX_COMBINATIONS } from '@/lib/variant-grid';
import { GridPreview, OptionsEditor, useGrid, type OptionRow } from './variant-grid';

type Kind = 'STANDARD' | 'SERVICE' | 'PACKAGE';

type CategoryOption = { id: string; label: string };

function Fields({ close, uoms, taxes, categories, byWeight, expiryFirst, salon, laundry, packages, pharmacy }: { close: () => void; uoms: Uom[]; taxes: TaxCategory[]; categories: CategoryOption[]; byWeight: boolean; expiryFirst: boolean; salon: boolean; laundry: boolean; packages: boolean; pharmacy: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, fieldError, error } = useSubmit();
  // Salons (ADR-0022): a service is booked by its duration; a package is prepaid sessions of services.
  const [kind, setKind] = useState<Kind>('STANDARD');
  // Laundries (ADR-0024 §2, §7): how a job line counts a service, add-ons, self-service cycles.
  const [wash, setWash] = useState<LaundryDraft>({ unit: '', addon: false, machineKind: '' });
  // Pharmacies (ADR-0025 §1): a new product starts as a medicine that keeps expiry dates.
  const [drug, setDrug] = useState(pharmacy);
  const [expiry, setExpiry] = useState(expiryFirst || pharmacy);
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
    const soldBy = laundry && kind === 'SERVICE' && wash.unit === 'KG' ? 'WEIGHT' : byWeight ? String(f.get('soldBy')) : 'UNIT';
    const isSized = sized && kind !== 'PACKAGE';
    if (isSized && (grid.tooMany || grid.list.length === 0)) return;
    const minutes = String(f.get('serviceMinutes') ?? '').trim();
    const validDays = String(f.get('packageValidDays') ?? '').trim();
    const typeFields = {
      ...(kind === 'SERVICE' && minutes ? { serviceMinutes: Number(minutes) } : kind === 'PACKAGE' && validDays ? { packageValidDays: Number(validDays) } : {}),
      ...(laundry && kind !== 'PACKAGE' ? laundryBody(f, wash, kind === 'SERVICE') : {}),
    };
    const variants = isSized
      ? grid.list.map((c) => ({ sku: c.sku, name: c.name, attributes: c.attributes, barcodes: [], ...(price ? { price } : {}), ...(cost ? { referenceCost: cost } : {}), ...typeFields }))
      : [{ sku: f.get('sku'), barcodes: barcode ? [barcode] : [], ...(price ? { price } : {}), ...(cost ? { referenceCost: cost } : {}), ...typeFields }];
    const r = await submit<{ id: string }>('POST', '/api/v1/products', {
      name: f.get('name'),
      taxCategoryId: f.get('taxCategoryId'),
      uomId: f.get('uomId'),
      ...(String(f.get('categoryId') ?? '') ? { categoryId: f.get('categoryId') } : {}),
      soldBy: kind === 'STANDARD' || (kind === 'SERVICE' && soldBy === 'WEIGHT') ? soldBy : 'UNIT',
      ...(salon || laundry ? { productType: kind } : {}),
      tracksExpiry: kind === 'STANDARD' && (expiry || drug),
      ...(kind === 'STANDARD' && drug ? { drug: drugBody(f, true) } : {}),
      variants,
    }, { idempotent: true, refresh: kind !== 'PACKAGE' });
    // A package's contents are set on its page, so go there.
    if (r.ok && kind === 'PACKAGE') router.push(`/products/${r.data.id}`);
    else if (r.ok) close();
  }
  // A refused grid row (e.g. an SKU already used by another product) names its row in the issues.
  const rowIssues = ((error?.details?.issues as ValidationIssue[] | undefined) ?? []).filter((i) => /^variants\.\d+\./.test(i.path));
  const gridMessage = sized && rowIssues.length
    ? rowIssues.map((i) => `${grid.list[Number(i.path.split('.')[1])]?.sku ?? i.path}: ${i.message}`).join(' · ')
    : null;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      {(salon || laundry) && (
        <SelectField label={t('prod.kind')} name="productType" value={kind} onChange={(e) => { const k = e.target.value as Kind; setKind(k); if (k === 'PACKAGE') setSized(false); }} hint={t(`prod.kindHint.${kind}`)}>
          <option value="STANDARD">{t('prod.kind.STANDARD')}</option>
          <option value="SERVICE">{t('prod.kind.SERVICE')}</option>
          {packages && <option value="PACKAGE">{t('prod.kind.PACKAGE')}</option>}
        </SelectField>
      )}
      <div className="sm:col-span-2"><TextField label={t('prod.name')} name="name" required autoFocus error={fieldError('name')} /></div>
      {kind === 'SERVICE' && salon && <TextField label={t('prod.serviceMinutes')} name="serviceMinutes" type="number" min={5} max={720} step={5} inputMode="numeric" hint={t('prod.serviceMinutesHint')} error={fieldError('variants.0.serviceMinutes')} />}
      {kind === 'PACKAGE' && <TextField label={`${t('prod.packageValidDays')} (${t('common.optional')})`} name="packageValidDays" type="number" min={1} max={3650} inputMode="numeric" hint={t('prod.packageValidDaysHint')} error={fieldError('variants.0.packageValidDays')} />}
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
      {/* A restaurant does not sell by weight (business type): its items go by the unit. */}
      {byWeight && kind === 'STANDARD' && (
        <SelectField label={t('prod.soldBy')} name="soldBy" defaultValue="UNIT">
          <option value="UNIT">{t('prod.byUnit')}</option>
          <option value="WEIGHT">{t('prod.byWeight')}</option>
        </SelectField>
      )}
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
      {/* ADR-0020: a sari-sari store starts with the box ticked; anyone may keep dates. */}
      {kind === 'STANDARD' && (
        <label className="col-span-full flex items-start gap-2 text-[0.9375rem]">
          <input type="checkbox" name="tracksExpiry" checked={expiry || drug} disabled={drug} onChange={(e) => setExpiry(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
          <span>{t('prod.tracksExpiry')}<span className="block text-[0.8125rem] text-muted">{drug ? t('drug.expiryNote') : t('prod.tracksExpiryHint')}</span></span>
        </label>
      )}
      {kind === 'STANDARD' && <DrugFields on={drug} onToggle={setDrug} pharmacy={pharmacy} fieldError={fieldError} />}
      {laundry && kind !== 'PACKAGE' && <LaundryFields draft={wash} onChange={setWash} service={kind === 'SERVICE'} fieldError={(k) => fieldError(`variants.0.${k}`)} />}
      {kind === 'PACKAGE' && <p className="col-span-full text-[0.875rem] text-muted">{t('prod.packageNext')}</p>}
      {kind !== 'PACKAGE' && <label className="col-span-full flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" checked={sized} onChange={(e) => setSized(e.target.checked)} className="mt-1 size-4 accent-[var(--color-blue)]" />
        <span>{t('vgrid.toggle')}<span className="block text-[0.8125rem] text-muted">{t('vgrid.toggleHint')}</span></span>
      </label>}
      {sized && kind !== 'PACKAGE' && (
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

export function AddProduct({ uoms, taxes, categories = [], byWeight, expiryFirst = false, salon = false, laundry = false, packages = salon, pharmacy = false }: { uoms: Uom[]; taxes: TaxCategory[]; categories?: CategoryOption[]; byWeight: boolean; expiryFirst?: boolean; salon?: boolean; laundry?: boolean; packages?: boolean; pharmacy?: boolean }) {
  const { t } = useT();
  return <Disclosure label={t('prod.add')}>{(close) => <Fields close={close} uoms={uoms} taxes={taxes} categories={categories} byWeight={byWeight} expiryFirst={expiryFirst} salon={salon} laundry={laundry} packages={packages} pharmacy={pharmacy} />}</Disclosure>;
}
