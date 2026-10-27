import { headers } from 'next/headers';
import { LangSwitch } from '@/components/lang-switch';
import { brandVars, publicImageUrl } from '@/lib/brand';
import { findShop, SHOP_HEADER } from '@/lib/shop-host';
import { visitorHeaders } from '@/lib/visitor';

/** On a business's own address (session 40) the pages carry its name, logo, colour and background (session 41), else Tilvara's. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const slug = h.get(SHOP_HEADER);
  const shop = slug ? await findShop(slug, { visitor: visitorHeaders(h) }) : null;
  return (
    <div
      className="min-h-dvh bg-paper bg-cover bg-center"
      style={shop?.backgroundSha256 && slug ? { backgroundImage: `url(${publicImageUrl(slug, 'background', shop.backgroundSha256)})` } : undefined}
    >
      <header className="band flex h-16 items-center justify-between gap-4 px-6 text-white sm:px-8" style={shop ? brandVars(shop.brandColor) : undefined}>
        {shop && slug ? (
          <span className="flex min-w-0 items-center gap-3">
            {shop.logoSha256 && <img src={publicImageUrl(slug, 'logo', shop.logoSha256)} alt="" className="brand-logo h-10 w-auto max-w-[120px] object-contain" />}
            <span className="truncate text-[1.375rem] font-bold tracking-[0.02em]">{shop.name}</span>
          </span>
        ) : (
          <span className="text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>
        )}
        <LangSwitch onBand />
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-8 sm:px-6 md:py-14" style={shop ? brandVars(shop.brandColor) : undefined}>
        {children}
      </main>
    </div>
  );
}
