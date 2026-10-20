import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata = { title: 'Reset password' };

export default async function ForgotPasswordPage() {
  const { t } = await getT();
  return (
    <AuthStub
      denom="blue"
      face={
        <AuthFace denom="blue" title={t('reset.requestTitle')} lede={t('reset.requestLede')}>
          <p className="mt-5">
            <Link className="font-semibold text-blue underline" href="/sign-in">
              {t('auth.signIn')}
            </Link>
          </p>
        </AuthFace>
      }
    >
      <ForgotPasswordForm />
    </AuthStub>
  );
}
