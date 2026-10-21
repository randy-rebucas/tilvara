import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { stripe, type Denomination } from '@/components/note';
import { getT } from '@/i18n/server';
import { SignUpForm } from './sign-up-form';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('sign-up');

/** What an owner sets up, in the hierarchy's order, each in the colour its records will carry. */
const SETUP: [Denomination, 'auth.setupLocations' | 'auth.setupRegisters' | 'auth.setupCatalog' | 'auth.setupTeam'][] = [
  ['violet', 'auth.setupLocations'],
  ['orange', 'auth.setupRegisters'],
  ['blue', 'auth.setupCatalog'],
  ['green', 'auth.setupTeam'],
];

export default async function SignUpPage() {
  const { t } = await getT();
  return (
    <AuthStub
      denom="blue"
      face={
        <AuthFace
          denom="blue"
          title={t('auth.signUpTitle')}
          lede={t('auth.signUpLede')}
          foot={
            <>
              <h2 className="section-title">{t('auth.setupTitle')}</h2>
              <ul className="mt-3 flex flex-col gap-2.5 text-[0.9375rem]">
                {SETUP.map(([denom, key]) => (
                  <li key={key} className="flex items-center gap-3">
                    <span aria-hidden className="h-4 w-[7px] shrink-0 rounded-[2px]" style={{ background: stripe[denom] }} />
                    {t(key)}
                  </li>
                ))}
              </ul>
            </>
          }
        >
          <p className="mt-5 text-muted">
            {t('auth.haveAccount')}{' '}
            <Link className="font-semibold text-blue underline" href="/sign-in">
              {t('auth.signIn')}
            </Link>
          </p>
        </AuthFace>
      }
    >
      <SignUpForm />
    </AuthStub>
  );
}
