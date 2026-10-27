'use client';

import { useState } from 'react';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

type Reply = { activeTenantId: string | null; redirect?: string; mfaRequired?: undefined } | { mfaRequired: true };

/**
 * Email + password, then — for accounts with two-step sign-in — a code from the app or a recovery code.
 * On a shop's own page (`/s/<slug>`) `tenantId` signs straight into that business.
 */
export function SignInForm({ next, tenantId }: { next: string; tenantId?: string }) {
  const { t } = useT();
  const { pending, error, setError, submit } = useSubmit();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [useRecovery, setUseRecovery] = useState(false);

  function finish(r: Reply) {
    if (r.mfaRequired) {
      setStep('code');
      return;
    }
    // The business's own address (session 41) signs this browser in there with the code in the link.
    if (r.redirect) window.location.assign(next === '/' ? r.redirect : `${r.redirect}&next=${encodeURIComponent(next)}`);
    // A full load, so no page cached for the previous session survives (Back, prefetch).
    else window.location.assign(r.activeTenantId ? next : '/select-business');
  }

  async function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit<Reply>('POST', '/api/auth/login', { email: f.get('email'), password: f.get('password'), ...(tenantId && { tenantId }) }, { refresh: false });
    if (r.ok) finish(r.data);
  }

  async function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = useRecovery ? { recoveryCode: String(f.get('recoveryCode') ?? '').trim() } : { code: String(f.get('code') ?? '').replace(/\s/g, '') };
    const r = await submit<Reply>('POST', '/api/auth/mfa-verify', body, { refresh: false });
    if (r.ok) finish(r.data);
    else if (r.error.code === 'INVALID_MFA_CHALLENGE') setStep('password');
  }

  const message =
    error?.code === 'INVALID_CREDENTIALS'
      ? t('auth.invalid')
      : error?.code === 'TOO_MANY_ATTEMPTS'
        ? t('auth.locked')
        : error?.code === 'INVALID_MFA_CODE'
          ? t('auth.mfaInvalid')
          : error?.code === 'INVALID_MFA_CHALLENGE'
            ? t('auth.mfaExpired')
            : error?.code === 'NOT_A_MEMBER'
              ? t('brand.notMember')
              : error?.message;

  if (step === 'code') {
    return (
      <form onSubmit={onCode} className="flex flex-col gap-4" noValidate>
        <div>
          <h2 className="text-[1.125rem] font-semibold">{t('auth.mfaTitle')}</h2>
          <p className="mt-1 text-[0.875rem] text-muted">{t('auth.mfaLede')}</p>
        </div>
        {useRecovery ? (
          <TextField key="recovery" label={t('auth.mfaRecovery')} name="recoveryCode" autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus />
        ) : (
          <TextField
            key="code"
            label={t('auth.mfaCode')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={7}
            className="input tabular-nums tracking-[0.3em]"
            required
            autoFocus
          />
        )}
        <FormError message={message} />
        <button className="btn btn-primary mt-1 h-10" disabled={pending}>
          {pending ? t('auth.working') : t('auth.mfaVerify')}
        </button>
        <div className="flex flex-wrap justify-between gap-2 text-[0.875rem]">
          <button
            type="button"
            className="font-semibold text-blue underline"
            onClick={() => {
              setUseRecovery((v) => !v);
              setError(null);
            }}
          >
            {useRecovery ? t('auth.mfaUseCode') : t('auth.mfaUseRecovery')}
          </button>
          <button
            type="button"
            className="text-muted underline"
            onClick={() => {
              setStep('password');
              setUseRecovery(false);
              setError(null);
            }}
          >
            {t('auth.mfaBack')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={onPassword} className="flex flex-col gap-4" noValidate>
      <TextField label={t('auth.email')} name="email" type="email" autoComplete="email" required autoFocus />
      <TextField label={t('auth.password')} name="password" type="password" autoComplete="current-password" required />
      <FormError message={message} />
      <button className="btn btn-primary mt-1 h-10" disabled={pending}>
        {pending ? t('auth.working') : t('auth.signIn')}
      </button>
      <a href="/forgot-password" className="self-start text-[0.875rem] font-semibold text-blue underline">
        {t('auth.forgot')}
      </a>
    </form>
  );
}
