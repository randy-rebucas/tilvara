'use client';

import { useState } from 'react';
import { FormError } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

/** Take a register's Z-reading for a day (once; after its shifts are closed). */
export function TakeZReading({ registerId, today }: { registerId: string; today: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  // One Idempotency-Key per open form, so a retry after no answer is the same request (replayed by the API, not done twice).
  const formKey = useFormKey();
  const [day, setDay] = useState(today);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        await submit('POST', `/api/v1/registers/${registerId}/z-readings`, { day }, { idempotencyKey: formKey });
      }}
    >
      <div className="field">
        <label htmlFor="z-day">{t('z.day')}</label>
        <input id="z-day" type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={pending}>{t('z.take')}</button>
      {day === today && <p className="w-full text-sm text-muted">{t('z.todayNote')}</p>}
      <FormError message={error?.message} />
    </form>
  );
}
