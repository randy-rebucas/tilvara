import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { Callout } from '@/components/note';
import { getT } from '@/i18n/server';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; closed?: string }> }) {
  const { t } = await getT();
  const { next, closed } = await searchParams;
  return (
    <AuthStub
      denom="blue"
      face={
        <AuthFace
          denom="blue"
          title={t('auth.signInTitle')}
          lede={
            <>
              {t('auth.noAccount')}{' '}
              <Link className="font-semibold text-blue underline" href="/sign-up">
                {t('auth.signUp')}
              </Link>
            </>
          }
        >
          {closed === '1' && (
            <div className="mt-6 max-w-[46ch]">
              <Callout tone="info">{t('account.closed')}</Callout>
            </div>
          )}
        </AuthFace>
      }
    >
      <SignInForm next={next?.startsWith('/') && !next.startsWith('//') ? next : '/'} />
    </AuthStub>
  );
}
