import Link from 'next/link';
import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata = { title: 'Reset password' };

export default async function ForgotPasswordPage() {
  const { t } = await getT();
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('reset.requestTitle')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('reset.requestLede')}</p>
        <p className="mt-3">
          <Link className="font-semibold text-blue underline" href="/sign-in">
            {t('auth.signIn')}
          </Link>
        </p>
      </section>
      <Note denom="blue" className="p-6 sm:p-7">
        <ForgotPasswordForm />
      </Note>
    </>
  );
}
