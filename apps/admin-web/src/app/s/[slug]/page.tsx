import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { AuthFace, AuthStub } from '@/components/auth-note';
import { LangSwitch } from '@/components/lang-switch';
import { pageTitle } from '@/i18n/page-title';
import { getT } from '@/i18n/server';
import { brandVars, publicImageUrl } from '@/lib/brand';
import { findShop, mainUrl, SHOP_HEADER } from '@/lib/shop-host';
import { SignInForm } from '../../(auth)/sign-in/sign-in-form';
import { safeNext } from '@/lib/next-path';
import { visitorHeaders } from '@/lib/visitor';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

// The shop's own name is on the page; the tab says what the page is for, in the reader's language.
export const generateMetadata = pageTitle('sign-in');

/**
 * A shop's own sign-in page (session 39): its name, colour, logo and background, then the usual
 * sign-in, straight into this business. Shown only when the business switched it on (Branding).
 * Also its own address's `/sign-in` (session 40, `<slug>.<shop domain>`; the proxy rewrites to here).
 */
export default async function ShopSignInPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ next?: string }> }) {
  const [{ slug }, { next }, h] = await Promise.all([params, searchParams, headers()]);
  const shop = SLUG.test(slug) ? await findShop(slug, { fresh: true, visitor: visitorHeaders(h) }) : null;
  if (!shop) notFound();
  const { t } = await getT();
  // On its own address, "Tilvara" leads to the main admin (this address's /sign-in is this page).
  const tilvara = h.get(SHOP_HEADER) === slug ? mainUrl('/sign-in') : '/sign-in';
  return (
    <div
      className="min-h-dvh bg-paper bg-cover bg-center"
      style={shop.backgroundSha256 ? { backgroundImage: `url(${publicImageUrl(slug, 'background', shop.backgroundSha256)})` } : undefined}
    >
      <header className="band flex h-16 items-center justify-between gap-4 px-6 text-white sm:px-8" style={brandVars(shop.brandColor)}>
        <span className="flex min-w-0 items-center gap-3">
          {shop.logoSha256 && <img src={publicImageUrl(slug, 'logo', shop.logoSha256)} alt="" className="brand-logo h-10 w-auto max-w-[120px] object-contain" />}
          <span className="truncate text-[1.375rem] font-bold tracking-[0.02em]">{shop.name}</span>
        </span>
        <LangSwitch onBand />
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-8 sm:px-6 md:py-14" style={brandVars(shop.brandColor)}>
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
                  <a className="font-semibold underline" href={tilvara}>Tilvara</a>
                </p>
              }
            />
          }
        >
          <SignInForm next={safeNext(next)} tenantId={shop.tenantId} />
        </AuthStub>
      </main>
    </div>
  );
}
