'use client';

import { useState } from 'react';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { ApiFailure } from '@/lib/client-api';
import type { ClosureStatus } from './page';

/** The words for refusals these forms expect; anything else keeps the API's own message. */
function useAccountMessage() {
  const { t } = useT();
  return (error: ApiFailure | null): string | null => {
    if (!error || error.code === 'VALIDATION_FAILED') return null;
    const known: Record<string, string> = {
      WRONG_PASSWORD: t('mfa.wrongPassword'),
      INVALID_MFA_CODE: t('auth.mfaInvalid'),
      MFA_CODE_REQUIRED: t('account.codeNeeded'),
      TOO_MANY_ATTEMPTS: t('auth.locked'),
      SAME_EMAIL: t('account.emailSame'),
      EMAIL_UNAVAILABLE: t('account.emailTaken'),
    };
    return known[error.code] ?? error.message;
  };
}

const CodeField = ({ error }: { error?: string | undefined }) => {
  const { t } = useT();
  return (
    <TextField
      label={t('account.code')}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={7}
      className="input tabular-nums tracking-[0.3em]"
      error={error}
      required
    />
  );
};

const codeOf = (f: FormData) => {
  const code = String(f.get('code') ?? '').replace(/\s/g, '');
  return code ? { code } : {};
};

export function NameForm({ displayName }: { displayName: string }) {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const message = useAccountMessage();
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const r = await submit('PATCH', '/api/v1/me', { displayName: new FormData(e.currentTarget).get('displayName') });
        if (r.ok) setSaved(true);
      }}
    >
      <h2 className="text-[1.125rem] font-semibold">{t('account.nameTitle')}</h2>
      <TextField label={t('account.name')} name="displayName" defaultValue={displayName} maxLength={200} autoComplete="name" error={fieldError('displayName')} required />
      <FormError message={message(error)} />
      {saved && (
        <p role="status" className="text-[0.875rem] text-muted">
          {t('account.nameSaved')}
        </p>
      )}
      <button className="btn btn-primary h-10 self-start" disabled={pending}>
        {pending ? t('auth.working') : t('common.save')}
      </button>
    </form>
  );
}

export function EmailForm({ mfaOn }: { mfaOn: boolean }) {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const message = useAccountMessage();
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (sentTo) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-[1.125rem] font-semibold">{t('account.emailTitle')}</h2>
        <p role="status" className="text-[0.9375rem]">
          {t('account.emailSent', { email: sentTo })}
        </p>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await submit<{ newEmail: string }>(
          'POST',
          '/api/auth/email-change',
          { newEmail: f.get('newEmail'), password: f.get('password'), ...codeOf(f) },
          { refresh: false },
        );
        if (r.ok) setSentTo(r.data.newEmail);
      }}
    >
      <div>
        <h2 className="text-[1.125rem] font-semibold">{t('account.emailTitle')}</h2>
        <p className="mt-1 text-[0.875rem] text-muted">{t('account.emailLede')}</p>
      </div>
      <TextField label={t('account.newEmail')} name="newEmail" type="email" autoComplete="email" error={fieldError('newEmail')} required />
      <TextField label={t('account.password')} name="password" type="password" autoComplete="current-password" error={fieldError('password')} required />
      {mfaOn && <CodeField error={fieldError('code')} />}
      <FormError message={message(error)} />
      <button className="btn btn-primary h-10 self-start" disabled={pending}>
        {pending ? t('auth.working') : t('account.emailSend')}
      </button>
    </form>
  );
}

export function CloseAccountForm({ mfaOn, closure }: { mfaOn: boolean; closure: ClosureStatus }) {
  const { t } = useT();
  const { pending, error, submit, fieldError } = useSubmit();
  const message = useAccountMessage();
  const [understood, setUnderstood] = useState(false);
  const heading = (
    <div>
      <h2 className="text-[1.125rem] font-semibold">{t('account.closeTitle')}</h2>
      <p className="mt-1 text-[0.875rem] text-muted">{t('account.closeLede')}</p>
    </div>
  );
  if (!closure.canClose) {
    return (
      <div className="flex flex-col gap-3" data-testid="closure-blocked">
        {heading}
        <p className="text-[0.9375rem]">{closure.staff ? t('account.closeStaff') : t('account.closeBlocked')}</p>
        {closure.businesses.length > 0 && (
          <ul className="list-disc pl-5 text-[0.9375rem]">
            {closure.businesses.map((b) => (
              <li key={b} className="break-words">
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await submit('POST', '/api/auth/account-close', { password: f.get('password'), ...codeOf(f) }, { refresh: false });
        if (r.ok) window.location.replace('/sign-in?closed=1');
      }}
    >
      {heading}
      <TextField label={t('account.password')} name="password" type="password" autoComplete="current-password" error={fieldError('password')} required />
      {mfaOn && <CodeField error={fieldError('code')} />}
      <label className="flex items-start gap-2 text-[0.9375rem]">
        <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>{t('account.closeConfirm')}</span>
      </label>
      <FormError message={message(error)} />
      <button className="btn btn-danger h-10 self-start" disabled={pending || !understood}>
        {pending ? t('auth.working') : t('account.closeButton')}
      </button>
    </form>
  );
}
