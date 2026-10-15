'use client';

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
