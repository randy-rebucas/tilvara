'use client';

import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

/** Put an item on a key (1–48). A key already in use is refused (QUICK_KEY_TAKEN): clear it first. */
function Fields({ close, options, taken }: { close: () => void; options: { id: string; label: string; position: number | null }[]; taken: Record<number, string> }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const free = Array.from({ length: 48 }, (_, i) => i + 1).filter((n) => !taken[n]);
  return (
    <form
      className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const variantId = String(f.get('variantId') ?? '');
        const position = Number(f.get('position'));
        if (!variantId || !position) return;
        const r = await submit('PATCH', `/api/v1/variants/${variantId}`, { quickKeyPosition: position });
        if (r.ok) close();
      }}
    >
      <SelectField label={t('common.item')} name="variantId" defaultValue="">
        <option value="" disabled>—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.position ? `${o.label} (${t('qk.keyN', { n: o.position })})` : o.label}</option>
        ))}
      </SelectField>
      <SelectField label={t('qk.position')} name="position" defaultValue={String(free[0] ?? '')} hint={t('qk.positionHint')} error={fieldError('quickKeyPosition')}>
        {free.map((n) => <option key={n} value={n}>{n}</option>)}
      </SelectField>
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || free.length === 0}>{t('qk.set')}</button>
        <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
        <FormError message={free.length === 0 ? t('qk.full') : error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      </div>
    </form>
  );
}

export function SetQuickKey(props: { options: { id: string; label: string; position: number | null }[]; taken: Record<number, string> }) {
  const { t } = useT();
  return <Disclosure label={t('qk.set')}>{(close) => <Fields close={close} {...props} />}</Disclosure>;
}
