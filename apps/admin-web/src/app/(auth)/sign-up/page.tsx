import Link from 'next/link';
import { Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { SignUpForm } from './sign-up-form';

export const metadata = { title: 'Create your business' };

export default async function SignUpPage() {
  const { t } = await getT();
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('auth.signUpTitle')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">{t('auth.signUpLede')}</p>
        <p className="mt-6 text-muted">
          {t('auth.haveAccount')}{' '}
          <Link className="font-semibold text-blue underline" href="/sign-in">
            {t('auth.signIn')}
          </Link>
        </p>
      </section>
      <Note denom="blue" className="p-6 sm:p-7">
        <SignUpForm />
      </Note>
    </>
  );
}
