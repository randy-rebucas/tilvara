import Link from 'next/link';
import { AuthFace, AuthSplit } from '@/components/auth-note';
import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { api, type Me } from '@/lib/api';
import { CloseAccountForm, EmailForm, NameForm } from './account-forms';

export const metadata = { title: 'Your account' };

export interface ClosureStatus {
  canClose: boolean;
  businesses: string[];
  staff: boolean;
}

/**
 * The person's own account: name, sign-in email, closing it (privacy pack: correction and erasure).
 * Outside the app shell like /security: account routes need no business, so someone who belongs to
 * none any more can still reach it.
 */
export default async function AccountPage() {
  const { t } = await getT();
  const [me, closure] = await Promise.all([api<Me>('/me'), api<ClosureStatus>('/auth/account/closure')]);
  const readOnly = me.support !== null;
  const face = (
    <AuthFace denom="none" title={t('account.title')} lede={t('account.lede')}>
      <dl className="mt-6 grid max-w-[46ch] grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[0.9375rem]">
        <dt className="text-muted">{t('account.name')}</dt>
        <dd className="min-w-0 break-words font-semibold" data-testid="account-name">
          {me.user.displayName}
        </dd>
        <dt className="text-muted">{t('account.email')}</dt>
        <dd className="min-w-0 break-all font-semibold" data-testid="account-email">
          {me.user.email}
        </dd>
        <dt className="text-muted">{t('account.twoStep')}</dt>
        <dd className="font-semibold">
          {me.mfa.enabled ? t('mfa.on') : t('mfa.off')}
          {' · '}
          <Link className="font-semibold text-blue underline" href="/security">
            {t('account.manageTwoStep')}
          </Link>
        </dd>
      </dl>
      <p className="mt-6">
        <Link className="font-semibold text-blue underline" href="/">
          {t('mfa.back')}
        </Link>
      </p>
    </AuthFace>
  );
  return (
    <AuthSplit denom="none" face={face}>
      {readOnly ? (
        <Note denom="blue" className="p-6 sm:p-7">
          <p className="text-[0.9375rem]">{t('common.readOnly')}</p>
        </Note>
      ) : (
        <>
          <Note denom="blue" className="p-6 sm:p-7">
            <NameForm displayName={me.user.displayName} />
          </Note>
          <Note denom="blue" className="p-6 sm:p-7">
            <EmailForm mfaOn={me.mfa.enabled} />
          </Note>
          <Note denom="none" className="p-6 sm:p-7">
            <CloseAccountForm mfaOn={me.mfa.enabled} closure={closure} />
          </Note>
        </>
      )}
    </AuthSplit>
  );
}
