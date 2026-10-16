'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MessageKey } from '@/i18n/messages';
import { useT } from '@/i18n/client';

const ITEMS: { href: string; key: MessageKey; needs?: string[] }[] = [
  { href: '/', key: 'nav.overview' },
  { href: '/products', key: 'nav.products', needs: ['catalog.read'] },
  { href: '/prices', key: 'nav.prices', needs: ['catalog.read'] },
  { href: '/inventory', key: 'nav.inventory', needs: ['inventory.read'] },
  { href: '/purchasing', key: 'nav.purchasing', needs: ['purchasing.manage', 'inventory.read'] },
  { href: '/books', key: 'nav.books', needs: ['accounting.read'] },
  { href: '/locations', key: 'nav.locations', needs: ['org.read', 'terminals.manage'] },
  { href: '/team', key: 'nav.team', needs: ['members.read'] },
  { href: '/subscription', key: 'nav.subscription', needs: ['subscription.manage', 'tenant.manage'] },
];

/** Tabs follow the user's permissions (UI hint only; the API enforces access). */
export function AppNav({ permissions }: { permissions: string[] }) {
  const { t } = useT();
  const path = usePathname();
  const visible = ITEMS.filter((i) => !i.needs || i.needs.some((p) => permissions.includes(p)));
  return (
    <nav aria-label="Main" className="-mx-1 flex min-w-0 gap-1 overflow-x-auto">
      {visible.map((i) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap rounded-[4px] px-3 py-1.5 text-[0.9375rem] transition-colors ${
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
