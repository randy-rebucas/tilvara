import type { MessageKey } from '@/i18n/messages';

/**
 * The band's tabs. A plain module (not the client nav component) so server pages such as the user
 * guide can use the same list and rules.
 * `match`: the path prefix that marks the tab active when it differs from where the tab goes.
 */
export interface NavItem {
  href: string;
  key: MessageKey;
  needs?: string[];
  match?: string;
  /** The extension this tab belongs to (ADR-0026): shown only while the business may use it. */
  extension?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', key: 'nav.overview' },
  { href: '/products', key: 'nav.products', needs: ['catalog.read'] },
  { href: '/prices', key: 'nav.prices', needs: ['catalog.read'] },
  { href: '/inventory', key: 'nav.inventory', needs: ['inventory.read', 'inventory.count'] },
  { href: '/purchasing', key: 'nav.purchasing', needs: ['purchasing.manage', 'inventory.read'] },
  { href: '/books', key: 'nav.books', needs: ['accounting.read'] },
  { href: '/reports/sales', match: '/reports', key: 'nav.reports', needs: ['reports.read'] },
  { href: '/offline-sales', key: 'nav.offline', needs: ['cash.reconcile'] },
  { href: '/locations', key: 'nav.locations', needs: ['org.read', 'terminals.manage'] },
  { href: '/team', key: 'nav.team', needs: ['members.read'] },
  { href: '/subscription', key: 'nav.subscription', needs: ['subscription.manage', 'tenant.manage', 'integrations.manage'] },
];

/** The business has the extension this area belongs to, if any (`/me` → `activeTenant.extensions`). */
export const offered = (item: Pick<NavItem, 'extension'>, extensions: readonly string[]) => !item.extension || extensions.includes(item.extension);

/** The person's permissions open this area (UI hint only; the API enforces access). */
export const permitted = (item: Pick<NavItem, 'needs'>, permissions: readonly string[]) =>
  !item.needs || item.needs.some((p) => permissions.includes(p));
