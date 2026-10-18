'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function ConfirmEmailForm({ token }: { token: string }) {
  const { t } = useT();
  const { pending, error, submit } = useSubmit();
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <p className="text-[0.9375rem]">{t('confirmEmail.done')}</p>
        <Link href="/sign-in" className="btn btn-primary h-10 self-start">
          {t('auth.signIn')}
        </Link>
      </div>
    );
  }
  const known =
    error?.code === 'EMAIL_CHANGE_LINK_INVALID' || error?.code === 'VALIDATION_FAILED'
      ? t('confirmEmail.invalid')
      : error?.code === 'EMAIL_UNAVAILABLE'
        ? t('confirmEmail.taken')
        : (error?.message ?? null);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await submit('POST', '/api/auth/email-change-confirm', { token }, { refresh: false });
        if (r.ok) setDone(true);
      }}
    >
      <FormError message={known} />
      {error?.code === 'EMAIL_CHANGE_LINK_INVALID' || error?.code === 'EMAIL_UNAVAILABLE' || error?.code === 'VALIDATION_FAILED' ? (
        <Link href="/account" className="btn h-10 self-start">
          {t('account.title')}
        </Link>
      ) : (
        <button className="btn btn-primary h-10 self-start" disabled={pending}>
          {pending ? t('auth.working') : t('confirmEmail.button')}
        </button>
      )}
    </form>
  );
}
