'use client';

import { useState } from 'react';
import { BusinessTypeField } from '@/components/business-type-field';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { BusinessType } from '@/lib/business-type';

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

/** Change the business type; the screens follow on the next page load (router refresh). */
export function BusinessTypeForm({ businessType, canEdit }: { businessType: BusinessType; canEdit: boolean }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [done, setDone] = useState(false);
  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setDone(false);
        const r = await submit('PATCH', '/api/v1/business', { businessType: new FormData(e.currentTarget).get('businessType') });
        if (r.ok) setDone(true);
      }}
    >
      <fieldset disabled={!canEdit} className="contents">
        <BusinessTypeField defaultValue={businessType} />
      </fieldset>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={pending}>{t('common.save')}</button>
          {done && <span role="status" className="text-[0.875rem] text-green">{t('biz.saved')}</span>}
          <FormError message={error?.message} />
        </div>
      ) : (
        <p className="text-[0.875rem] text-muted">{t('biz.ownerOnly')}</p>
      )}
    </form>
  );
}
