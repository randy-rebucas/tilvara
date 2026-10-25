'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, TextField } from '@/components/fields';
import { LineItems, readLines, type VariantOption } from '@/components/line-items';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** A new version of a service's supplies used (ADR-0022 §9): the service's recipe, append-only. */
export function SuppliesForm({ variantId, supplies }: { variantId: string; supplies: VariantOption[] }) {
  const { t } = useT();
  return <Disclosure label={t('prod.newSupplies')}>{(close) => <SuppliesFields variantId={variantId} supplies={supplies} close={close} />}</Disclosure>;
}

function SuppliesFields({ variantId, supplies, close }: { variantId: string; supplies: VariantOption[]; close: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, fieldError, error } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = text(f, 'effectiveFrom');
    const note = text(f, 'note');
    const r = await submit('POST', `/api/v1/variants/${variantId}/recipe`, {
      ingredients: readLines(f, ['variantId', 'quantity']).filter((l) => l.variantId || l.quantity),
      // datetime-local is the browser's local time; the API takes an instant with its offset.
      ...(from && { effectiveFrom: new Date(from).toISOString() }),
      ...(note && { note }),
    }, { idempotencyKey: key });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <p className="col-span-full -mt-2 text-[0.875rem] text-muted">{t('prod.suppliesHint')}</p>
      <LineItems
        fields={[
          { name: 'variantId', label: t('prod.supply'), kind: 'select' },
          { name: 'quantity', label: t('prod.perService'), kind: 'decimal', placeholder: '0' },
        ]}
        options={supplies}
        fieldError={(p) => fieldError(p.replace(/^lines\./, 'ingredients.'))}
        addLabel={t('common.addLine')}
        removeLabel={t('common.removeLine')}
      />
      <TextField label={`${t('prod.suppliesFrom')} (${t('common.optional')})`} name="effectiveFrom" type="datetime-local" hint={t('prod.suppliesFromHint')} error={fieldError('effectiveFrom')} />
      <TextField label={`${t('common.notes')} (${t('common.optional')})`} name="note" error={fieldError('note')} />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending}>{t('prod.saveSupplies')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={(error && error.code !== 'VALIDATION_FAILED' ? error.message : null) ?? fieldError('ingredients')} />
      </div>
    </form>
  );
}
