import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { Callout } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, type MfaStatus } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SecurityPanel } from './security-panel';

export const metadata = { title: 'Two-step sign-in' };

/**
 * Outside the app shell on purpose: once two-step sign-in is required, business pages answer
 * MFA_REQUIRED, but this page (account routes need no business) must stay reachable.
 */
export default async function SecurityPage() {
  const { t, lang } = await getT();
  const status = await api<MfaStatus & { recoveryCodesLeft: number }>('/auth/mfa');
  const overdue = status.required && !status.enabled && status.dueAt !== null && new Date(status.dueAt).getTime() <= Date.now();
  const face = (
    <AuthFace denom="blue" title={t('mfa.title')} lede={t('mfa.lede')}>
      <dl className="mt-6 grid max-w-[46ch] grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[0.9375rem]">
        <dt className="text-muted">{t('mfa.status')}</dt>
        <dd className="font-semibold">{status.enabled ? t('mfa.on') : t('mfa.off')}</dd>
        {status.enabled && (
          <>
            <dt className="text-muted">{t('mfa.codesLeft')}</dt>
            <dd className="serial font-semibold">{status.recoveryCodesLeft}</dd>
          </>
        )}
      </dl>
      {status.required && !status.enabled && (
        <div className="mt-6 max-w-[46ch]">
          <Callout tone="warn">{overdue ? t('mfa.overdue') : t('mfa.dueBy', { date: formatDateTime(status.dueAt, lang) })}</Callout>
        </div>
      )}
      {!overdue && !(status.enabled && status.required && !status.sessionVerified) && (
        <p className="mt-6">
          <Link className="font-semibold text-blue underline" href="/">
            {t('mfa.back')}
          </Link>
        </p>
      )}
    </AuthFace>
  );
  return (
    <AuthStub denom="blue" face={face}>
      <SecurityPanel status={status} />
    </AuthStub>
  );
}
