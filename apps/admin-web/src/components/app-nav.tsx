'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { extraFor } from '@/i18n/titles';
import type { BusinessType } from '@/lib/business-type';
import { NAV_ITEMS, offered, permitted } from '@/lib/nav';

/** Tabs follow the user's permissions and the business type (UI hint only; the API enforces access). */
export function AppNav({ permissions, businessType }: { permissions: string[]; businessType: BusinessType }) {
  const { t, lang } = useT();
  const path = usePathname();
  const visible = NAV_ITEMS.filter((i) => permitted(i, permissions) && offered(i, businessType));
  // A business that does both (HYBRID) has thirteen tabs (Pharmacy and Appointments too): from lg
  // they set a little tighter so they still fit at 1440px beside the business name.
  const dense = visible.length > 12 ? 'lg:px-2 lg:text-[0.875rem]' : '';
  return (
    // No gap in the band (lg+): the tabs' own padding separates them, and all of them fit at 1440px.
    <nav aria-label={extraFor(lang, 'a11y.mainNav')} data-testid="main-nav" className="-mx-1 flex min-w-0 gap-1 overflow-x-auto lg:gap-0">
      {visible.map((i) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.match ?? i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap rounded-[4px] px-3 py-1.5 text-[0.9375rem] transition-colors ${dense} ${
              active ? 'bg-white/18 font-semibold text-white' : 'text-blue-ink hover:bg-white/10 hover:text-white'
            }`}
          >
            {t(i.key)}
          </Link>
        );
      })}
    </nav>
  );
}
