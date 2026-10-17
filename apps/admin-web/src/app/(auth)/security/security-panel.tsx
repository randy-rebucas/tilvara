'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { encode } from 'uqr';
import { FormError, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import { send } from '@/lib/client-api';
import type { MfaStatus } from '@/lib/api';

type Step = { kind: 'idle' } | { kind: 'scan'; secret: string; otpauthUri: string } | { kind: 'codes'; codes: string[] };

/** Set up (password → scan → first code → recovery codes) or turn off two-step sign-in. */
export function SecurityPanel({ status }: { status: MfaStatus }) {
  const { t } = useT();
  const router = useRouter();
  const { pending, error, submit, fieldError } = useSubmit();
  const [step, setStep] = useState<Step>({ kind: 'idle' });

  const message =
    error?.code === 'WRONG_PASSWORD'
      ? t('mfa.wrongPassword')
      : error?.code === 'INVALID_MFA_CODE'
        ? t('auth.mfaInvalid')
        : error?.code === 'TOO_MANY_ATTEMPTS'
          ? t('auth.locked')
          : error && error.code !== 'VALIDATION_FAILED'
            ? error.message
            : null;

  async function signOut() {
    await send('POST', '/api/auth/logout');
    router.replace('/sign-in');
  }

  // A session older than the enrolment: the API keeps business pages closed until a fresh sign-in.
  if (status.enabled && status.required && !status.sessionVerified) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[0.9375rem]">{t('mfa.reauth')}</p>
        <button type="button" className="btn btn-primary h-10 self-start" onClick={signOut}>
          {t('nav.signOut')}
        </button>
      </div>
    );
  }

  if (step.kind === 'codes') {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[1.125rem] font-semibold">{t('mfa.codesTitle')}</h2>
          <p className="mt-1 text-[0.875rem] text-muted">{t('mfa.codesLede')}</p>
        </div>
        <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[5px] border border-hair bg-paper px-4 py-3 font-mono text-[0.9375rem] tabular-nums" data-testid="recovery-codes">
          {step.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <button type="button" className="btn btn-primary h-10 self-start" onClick={() => router.push('/')}>
          {t('mfa.codesDone')}
        </button>
      </div>
    );
  }

  if (step.kind === 'scan') {
    return (
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
          const r = await submit<{ recoveryCodes: string[] }>('POST', '/api/auth/mfa-confirm', { code }, { refresh: false });
          if (r.ok) setStep({ kind: 'codes', codes: r.data.recoveryCodes });
        }}
      >
        <p className="text-[0.9375rem]">{t('mfa.scan')}</p>
        <Qr text={step.otpauthUri} label={t('mfa.qrLabel')} />
        <div>
          <p className="text-[0.8125rem] text-muted">{t('mfa.key')}</p>
          <p className="mt-0.5 select-all break-all font-mono text-[0.9375rem] tracking-[0.05em]" data-testid="mfa-secret">
            {step.secret}
          </p>
        </div>
        <p className="text-[0.875rem] text-muted">{t('mfa.confirmLede')}</p>
        <TextField
          label={t('auth.mfaCode')}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          className="input tabular-nums tracking-[0.3em]"
          error={fieldError('code')}
          required
        />
        <FormError message={message} />
        <button className="btn btn-primary h-10" disabled={pending}>
          {pending ? t('auth.working') : t('mfa.confirm')}
        </button>
      </form>
    );
  }

  // On: make new recovery codes (old ones stop working), or turn it off when the role allows.
  if (status.enabled) {
    return (
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body = { password: f.get('password'), code: String(f.get('code') ?? '').replace(/\s/g, '') };
          const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
          if (action === 'disable') {
            const r = await submit('POST', '/api/auth/mfa-disable', body);
            if (r.ok) router.refresh();
            return;
          }
          const r = await submit<{ recoveryCodes: string[] }>('POST', '/api/auth/mfa-recovery-codes', body, { refresh: false });
          if (r.ok) setStep({ kind: 'codes', codes: r.data.recoveryCodes });
        }}
      >
        <p className="text-[0.875rem] text-muted">{t('mfa.disableLede')}</p>
        <TextField label={t('auth.password')} name="password" type="password" autoComplete="current-password" required />
        <TextField label={t('auth.mfaCode')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} error={fieldError('code')} required />
        <FormError message={message} />
        <p className="text-[0.875rem] text-muted">{t('mfa.regenLede')}</p>
        <div className="flex flex-wrap gap-3">
          <button className="btn btn-primary h-10" name="action" value="regenerate" disabled={pending}>
            {pending ? t('auth.working') : t('mfa.regenerate')}
          </button>
          {!status.required && (
            <button className="btn btn-danger h-10" name="action" value="disable" disabled={pending}>
              {t('mfa.disable')}
            </button>
          )}
        </div>
        {status.required && <p className="text-[0.875rem] text-muted">{t('mfa.cannotDisable')}</p>}
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await submit<{ secret: string; otpauthUri: string }>(
          'POST',
          '/api/auth/mfa-enroll',
          { password: new FormData(e.currentTarget).get('password') },
          { refresh: false },
        );
        if (r.ok) setStep({ kind: 'scan', ...r.data });
      }}
    >
      {status.required && <p className="text-[0.875rem] text-muted">{t('mfa.requiredRole')}</p>}
      <TextField label={t('mfa.passwordToStart')} name="password" type="password" autoComplete="current-password" required autoFocus />
      <FormError message={message} />
      <button className="btn btn-primary h-10" disabled={pending}>
        {pending ? t('auth.working') : t('mfa.start')}
      </button>
    </form>
  );
}

/** The otpauth URI as an SVG QR code (made in the browser; the secret never leaves this page). */
function Qr({ text, label }: { text: string; label: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="size-48 self-center rounded-[4px] bg-white">
      <path d={path} fill="#000" />
    </svg>
  );
}
