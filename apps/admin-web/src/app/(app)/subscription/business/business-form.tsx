'use client';

import { useState } from 'react';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

/** Rename the business; the band shows the new name after the router refresh. */
export function BusinessNameForm({ name }: { name: string }) {
  const { t } = useT();
  const { pending, submit, error, fieldError } = useSubmit();
  const [done, setDone] = useState(false);
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setDone(false);
        const r = await submit('PATCH', '/api/v1/business', { name: String(new FormData(e.currentTarget).get('businessName') ?? '').trim() });
        if (r.ok) setDone(true);
      }}
    >
      <TextField label={t('biz.name')} name="businessName" defaultValue={name} required maxLength={200} hint={t('biz.nameHint')} error={fieldError('name')} />
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
        {done && <span role="status" className="text-[0.875rem] text-green">{t('biz.nameSaved')}</span>}
        <FormError message={error?.code === 'VALIDATION_FAILED' ? null : error?.message} />
      </div>
    </form>
  );
}
