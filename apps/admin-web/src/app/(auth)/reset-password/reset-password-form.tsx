'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function ResetPasswordForm({ token }: { token: string }) {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/auth/password-reset-confirm', { token, password: f.get('password') }, { refresh: false });
    if (r.ok) setDone(true);
  }

  if (done) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <p className="text-[0.9375rem]">{t('reset.done')}</p>
        <Link href="/sign-in" className="btn btn-primary h-10 self-start">
          {t('auth.signIn')}
        </Link>
      </div>
    );
  }
  const linkInvalid = error?.code === 'RESET_LINK_INVALID';
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        label={t('reset.newPassword')}
        name="password"
        type="password"
        autoComplete="new-password"
        hint={t('auth.passwordHint')}
        error={fieldError('password')}
        required
        autoFocus
      />
      <FormError message={linkInvalid ? t('reset.invalid') : error && error.code !== 'VALIDATION_FAILED' ? error.message : null} />
      {linkInvalid ? (
        <Link href="/forgot-password" className="btn h-10 self-start">
          {t('reset.send')}
        </Link>
      ) : (
        <button className="btn btn-primary mt-1 h-10" disabled={pending}>
          {pending ? t('auth.working') : t('reset.save')}
        </button>
      )}
    </form>
  );
}
