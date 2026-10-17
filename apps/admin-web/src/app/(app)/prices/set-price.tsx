'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export interface VariantOption {
  id: string;
  label: string;
}

/** datetime-local is read as Manila wall-clock time (UTC+08:00, no DST). */
function manilaToIso(local: string): string {
  return new Date(`${local}:00+08:00`).toISOString();
}

function Fields({ close, listId, variants }: { close: () => void; listId: string; variants: VariantOption[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, error } = useSubmit();
  const [when, setWhen] = useState<'now' | 'later'>('now');
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const at = String(f.get('effectiveAt') ?? '');
    const item = {
      variantId: f.get('variantId'),
      amount: String(f.get('amount') ?? '').trim(),
      ...(when === 'later' && at ? { effectiveFrom: manilaToIso(at) } : {}),
    };
    const r = await submit('POST', `/api/v1/price-lists/${listId}/prices`, { items: [item] }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <div className="sm:col-span-2">
        <SelectField label={t('prod.name')} name="variantId">
          {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </SelectField>
      </div>
      <TextField label={t('prod.price')} name="amount" inputMode="decimal" required placeholder="0.00" error={fieldError('items.0.amount')} />
      <SelectField label={t('price.effective')} value={when} onChange={(e) => setWhen(e.target.value as 'now' | 'later')}>
        <option value="now">{t('price.now')}</option>
        <option value="later">{t('price.scheduled')}</option>
      </SelectField>
      {when === 'later' && <TextField label={`${t('price.effective')} (Asia/Manila)`} name="effectiveAt" type="datetime-local" required />}
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || variants.length === 0}>{t('price.setPrice')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

export function SetPrice({ listId, variants }: { listId: string; variants: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('price.setPrice')}>{(close) => <Fields close={close} listId={listId} variants={variants} />}</Disclosure>;
}

/** A new list (e.g. "Mall" prices for one branch), or renaming one. Prices are added to it afterwards. */
function ListFields({ close, list }: { close: () => void; list?: { id: string; name: string } }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (list) {
      const r = await submit('PATCH', `/api/v1/price-lists/${list.id}`, { name });
      if (r.ok) close();
      return;
    }
    const r = await submit<{ id: string }>('POST', '/api/v1/price-lists', { name, pricesIncludeTax: f.get('pricesIncludeTax') === 'on', isDefault: f.get('isDefault') === 'on' }, { idempotent: true, refresh: false });
    if (r.ok) {
      close();
      router.push(`/prices?list=${r.data.id}`);
      router.refresh();
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('price.listName')} name="name" required autoFocus defaultValue={list?.name} placeholder={list ? undefined : t('price.listNameHint')} error={fieldError('name')} />
      {!list && (
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-[0.9375rem]"><input type="checkbox" name="pricesIncludeTax" defaultChecked className="size-4 accent-[var(--color-blue)]" /> {t('price.inclTaxLong')}</label>
          <label className="flex items-center gap-2 text-[0.9375rem]"><input type="checkbox" name="isDefault" className="size-4 accent-[var(--color-blue)]" /> {t('price.makeDefaultLong')}</label>
        </div>
      )}
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{list ? t('common.save') : t('common.create')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

export function NewPriceList() {
  const { t } = useT();
  return <Disclosure label={t('price.newList')}>{(close) => <ListFields close={close} />}</Disclosure>;
}

/** Point a branch at this list (its counters then sell at these prices). */
export function AssignBranch({ listId, branches }: { listId: string; branches: { id: string; code: string; name: string }[] }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const branchId = String(new FormData(e.currentTarget).get('branchId') ?? '');
        if (branchId) await submit('PUT', `/api/v1/branches/${branchId}/price-list`, { priceListId: listId });
      }}
    >
      <SelectField label={t('price.useAt')} name="branchId">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <button className="btn" disabled={pending || branches.length === 0}>{t('price.assign')}</button>
      <FormError message={error?.message} />
    </form>
  );
}

export function RenamePriceList({ list }: { list: { id: string; name: string } }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('price.rename')}>{(close) => <ListFields close={close} list={list} />}</Disclosure>;
}
