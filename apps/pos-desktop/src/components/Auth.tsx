import { ChevronRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { ApiFailure, signIn, switchTenant, verifyMfa, type SignInResult } from '../lib/api';
import type { Me } from '../types';
import { AuthStub } from './AuthNote';
import { Callout, Field } from './ui';

export function SignIn({ onDone }: { onDone: (activeTenantId: string | null) => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Set while an account with two-step sign-in waits for its code (ADR-0016). */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  function finish(r: SignInResult) {
    if (r.challenge !== undefined) setChallenge(r.challenge);
    else onDone(r.activeTenantId);
  }

  function explain(err: unknown): string {
    if (!(err instanceof ApiFailure) || err.error.status === 0) return t('common.network');
    if (err.error.code === 'INVALID_MFA_CODE') return t('signin.mfaInvalid');
    if (err.error.code === 'INVALID_MFA_CHALLENGE') return t('signin.mfaExpired');
    return err.error.message;
  }

  async function run(fn: () => Promise<SignInResult>) {
    setPending(true);
    setError(null);
    try {
      finish(await fn());
    } catch (err) {
      setError(explain(err));
      if (err instanceof ApiFailure && err.error.code === 'INVALID_MFA_CHALLENGE') setChallenge(null);
    } finally {
      setPending(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(() => signIn(String(form.get('email')), String(form.get('password'))));
  }

  function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const answer = useRecovery
      ? { recoveryCode: String(form.get('recoveryCode') ?? '').trim() }
      : { code: String(form.get('code') ?? '').replace(/\s/g, '') };
    void run(() => verifyMfa(challenge!, answer));
  }

  return (
    <AuthStub denom="blue" title={t('signin.title')} lede={challenge ? t('signin.mfaLede') : t('signin.lede')}>
      {challenge ? (
        <form onSubmit={submitCode} className="grid gap-4">
          {useRecovery ? (
            <Field key="recovery" id="recoveryCode" name="recoveryCode" autoComplete="off" required autoFocus label={t('signin.recovery')} />
          ) : (
            <Field key="code" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus label={t('signin.code')} />
          )}
          {error && <Callout kind="error">{error}</Callout>}
          <button className="btn btn-primary w-full" disabled={pending}>
            {t('signin.verify')}
          </button>
          <div className="flex flex-wrap justify-between gap-2 text-[0.9375rem]">
            <button type="button" className="font-semibold text-blue underline" onClick={() => { setUseRecovery((v) => !v); setError(null); }}>
              {useRecovery ? t('signin.useCode') : t('signin.useRecovery')}
            </button>
            <button type="button" className="text-muted underline" onClick={() => { setChallenge(null); setUseRecovery(false); setError(null); }}>
              {t('signin.startOver')}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <Field id="email" name="email" type="email" autoComplete="username" required autoFocus label={t('signin.email')} />
          <Field id="password" name="password" type="password" autoComplete="current-password" required label={t('signin.password')} />
          {error && <Callout kind="error">{error}</Callout>}
          <button className="btn btn-primary w-full" disabled={pending}>
            {t('signin.submit')}
          </button>
        </form>
      )}
    </AuthStub>
  );
}

export function BusinessPicker({ me, onDone }: { me: Me; onDone: () => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-[640px] px-4 py-12 sm:px-6">
      <h1 className="text-[1.75rem] font-bold">{t('business.title')}</h1>
      <div className="mt-6 grid gap-3">
        {me.memberships.map((m) => (
          <button
            key={m.tenantId}
            type="button"
            className="note flex items-center justify-between p-5 text-left hover:border-[#b6ae98]"
            onClick={async () => {
              try {
                await switchTenant(m.tenantId);
                onDone();
              } catch (err) {
                setError(err instanceof ApiFailure ? err.error.message : t('common.error'));
              }
            }}
          >
            <span>
              <span className="block text-[1.0625rem] font-semibold">{m.tenantName}</span>
              <span className="serial block text-[0.8125rem] text-muted">{m.tenantSlug}</span>
            </span>
            <ChevronRight className="size-5 text-muted" aria-hidden />
          </button>
        ))}
        {error && <Callout kind="error">{error}</Callout>}
      </div>
    </div>
  );
}
