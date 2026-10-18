import Link from 'next/link';
import { Callout, Note } from '@/components/note';
import { getT } from '@/i18n/server';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; closed?: string }> }) {
  const { t } = await getT();
  const { next, closed } = await searchParams;
  return (
    <>
      <section className="self-center">
        <h1 className="text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{t('auth.signInTitle')}</h1>
        <p className="mt-3 max-w-[46ch] text-muted">
          {t('auth.noAccount')}{' '}
          <Link className="font-semibold text-blue underline" href="/sign-up">
            {t('auth.signUp')}
          </Link>
        </p>
        {closed === '1' && (
          <div className="mt-6 max-w-[46ch]">
            <Callout tone="info">{t('account.closed')}</Callout>
          </div>
        )}
      </section>
      <Note denom="blue" className="p-6 sm:p-7">
        <SignInForm next={next?.startsWith('/') && !next.startsWith('//') ? next : '/'} />
      </Note>
    </>
  );
}
