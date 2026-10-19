'use client';

import { useState } from 'react';
import { BusinessTypeField } from '@/components/business-type-field';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { BusinessType } from '@/lib/business-type';

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
