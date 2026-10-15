'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

export function AcceptInviteForm({ token }: { token: string }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, error, submit, fieldError } = useSubmit();
  const existing = useSubmit();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/auth/accept-invite', { token, displayName: f.get('displayName'), password: f.get('password') }, { refresh: false });
    if (r.ok) router.replace('/');
  }

  async function acceptSignedIn() {
    const r = await existing.submit<{ tenantId: string }>('POST', '/api/auth/accept-invite-existing', { token }, { refresh: false });
    if (r.ok) {
      await existing.submit('POST', '/api/auth/switch', { tenantId: r.data.tenantId }, { refresh: false });
      router.replace('/');
    }
  }

  if (error?.code === 'ACCOUNT_EXISTS') {
    return (
      <div className="flex flex-col gap-4">
        <p>{t('invite.exists')}</p>
        <FormError message={existing.error?.code === 'UNAUTHENTICATED' ? null : existing.error?.message} />
        <button className="btn btn-primary h-10" onClick={acceptSignedIn} disabled={existing.pending}>
          {t('invite.accept')}
        </button>
        <Link className="btn h-10" href={`/sign-in?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}>
          {t('auth.signIn')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField label={t('auth.displayName')} name="displayName" autoComplete="name" required autoFocus error={fieldError('displayName')} />
      <TextField label={t('auth.password')} name="password" type="password" autoComplete="new-password" minLength={12} required
        hint={t('auth.passwordHint')} error={fieldError('password')} />
      <FormError message={error?.code === 'INVITATION_INVALID' ? t('invite.invalid') : error?.code === 'VALIDATION_FAILED' ? null : error?.message} />
      <button className="btn btn-primary mt-1 h-10" disabled={pending}>
        {pending ? t('auth.working') : t('invite.accept')}
      </button>
    </form>
  );
}
