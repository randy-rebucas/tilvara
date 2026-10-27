import { headers } from 'next/headers';
import Link from 'next/link';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { Callout } from '@/components/note';
import { getT } from '@/i18n/server';
import { SignInForm } from './sign-in-form';
import { pageTitle } from '@/i18n/page-title';
import { safeNext } from '@/lib/next-path';
import { findShop, mainUrl, SHOP_HEADER } from '@/lib/shop-host';
import { visitorHeaders } from '@/lib/visitor';

export const generateMetadata = pageTitle('sign-in');

/**
 * Tilvara's sign-in, or on a business's own address (session 40) that business's: its name (the layout
 * draws its band, colour and background) and a sign-in straight into it, as `/s/<slug>` on the main address.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; closed?: string }> }) {
  const { t } = await getT();
  const [{ next, closed }, h] = await Promise.all([searchParams, headers()]);
  const slug = h.get(SHOP_HEADER);
  const shop = slug ? await findShop(slug, { fresh: true, visitor: visitorHeaders(h) }) : null;
  const closedNote = closed === '1' && (
    <div className="mt-6 max-w-[46ch]">
      <Callout tone="info">{t('account.closed')}</Callout>
    </div>
  );
  if (shop) {
    return (
      <AuthStub
        denom="blue"
        face={
          <AuthFace
            denom="blue"
            title={t('brand.shopSignIn', { name: shop.name })}
            lede={t('brand.shopSignInLede')}
            foot={
              <p className="text-[0.8125rem] text-muted">
                {t('brand.poweredBy')}{' '}
                <a className="font-semibold underline" href={mainUrl('/sign-in')}>Tilvara</a>
              </p>
            }
          >
            {closedNote}
          </AuthFace>
        }
      >
        <SignInForm next={safeNext(next)} tenantId={shop.tenantId} />
      </AuthStub>
    );
  }
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
          {closedNote}
        </AuthFace>
      }
    >
      <SignInForm next={safeNext(next)} />
    </AuthStub>
  );
}
