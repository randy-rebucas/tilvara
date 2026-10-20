import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = { title: 'New password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await getT();
  const { token } = await searchParams;
  return (
    <AuthStub denom="blue" face={<AuthFace denom="blue" title={t('reset.title')} lede={t('reset.lede')} />}>
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className="text-[0.9375rem]">
          {t('reset.missing')}{' '}
          <Link className="font-semibold text-blue underline" href="/forgot-password">
            {t('reset.send')}
          </Link>
        </p>
      )}
    </AuthStub>
  );
}
