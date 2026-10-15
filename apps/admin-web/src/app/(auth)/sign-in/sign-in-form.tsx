'use client';

import { useRouter } from 'next/navigation';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function SignInForm({ next }: { next: string }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, error, submit } = useSubmit();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit<{ activeTenantId: string | null }>(
      'POST',
      '/api/auth/login',
      { email: f.get('email'), password: f.get('password') },
      { refresh: false },
    );
    if (r.ok) router.replace(r.data.activeTenantId ? next : '/select-business');
  }

  const message =
    error?.code === 'INVALID_CREDENTIALS' ? t('auth.invalid') : error?.code === 'TOO_MANY_ATTEMPTS' ? t('auth.locked') : error?.message;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required autoFocus />
      <TextField label={t('auth.password')} name="password" type="password" autoComplete="current-password" required />
      <FormError message={message} />
      <button className="btn btn-primary mt-1 h-10" disabled={pending}>
        {pending ? t('auth.working') : t('auth.signIn')}
      </button>
    </form>
  );
}
