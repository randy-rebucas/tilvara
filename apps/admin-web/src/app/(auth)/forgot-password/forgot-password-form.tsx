'use client';

import { useState } from 'react';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function ForgotPasswordForm() {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/auth/password-reset-request', { email: f.get('email') }, { refresh: false });
    if (r.ok) setSent(true);
  }

  // The answer is the same whether or not the email has an account.
  if (sent) {
    return (
      <p role="status" className="text-[0.9375rem]">
        {t('reset.sent')}
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required autoFocus error={fieldError('email')} />
      <FormError message={error && error.code !== 'VALIDATION_FAILED' ? (error.code === 'RATE_LIMITED' ? t('auth.locked') : error.message) : null} />
      <button className="btn btn-primary mt-1 h-10" disabled={pending}>
        {pending ? t('auth.working') : t('reset.send')}
      </button>
    </form>
  );
}
