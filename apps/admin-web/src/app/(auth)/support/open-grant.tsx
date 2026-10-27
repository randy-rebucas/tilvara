'use client';

import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function OpenGrantButton({ grantId }: { grantId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  async function open() {
    const r = await submit('POST', '/api/auth/support-open', { grantId }, { refresh: false });
    // Full loads: the support view and the staff member's own session never share cached pages.
    if (r.ok) window.location.assign('/');
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void open()}>{t('staff.open')}</button>
      <FormError message={error?.message} />
    </span>
  );
}

/** Back to the staff member's own session (no business). */
export function LeaveSupportButton() {
  const { t } = useT();
  const { pending, submit } = useSubmit();
  return (
    <button
      type="button"
      className="font-semibold underline"
      disabled={pending}
      onClick={async () => {
        await submit('POST', '/api/auth/support-leave', {}, { refresh: false });
        window.location.assign('/support');
      }}
    >
      {t('staff.leave')}
    </button>
  );
}
