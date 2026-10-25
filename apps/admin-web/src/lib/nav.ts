import type { MessageKey } from '@/i18n/messages';
import { servesAppointments, servesPharmacy, type BusinessType } from './business-type';

/**
 * The band's tabs. A plain module (not the client nav component) so server pages such as the user
 * guide can use the same list and rules.
 * `match`: the path prefix that marks the tab active when it differs from where the tab goes.
 * `salon`: only for a business that takes appointments (SALON or HYBRID, ADR-0022).
 * `pharmacy`: only for a pharmacy or drugstore (PHARMACY or HYBRID, ADR-0025).
 */
export interface NavItem {
  href: string;
  key: MessageKey;
  needs?: string[];
  match?: string;
  salon?: true;
  pharmacy?: true;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', key: 'nav.overview' },
  { href: '/pharmacy', key: 'nav.pharmacy', needs: ['pharmacy.read', 'pharmacy.setup'], pharmacy: true },
  { href: '/appointments', key: 'nav.appointments', needs: ['appointments.read', 'appointments.manage', 'staff.manage'], salon: true },
  { href: '/products', key: 'nav.products', needs: ['catalog.read'] },
  { href: '/prices', key: 'nav.prices', needs: ['catalog.read'] },
  { href: '/inventory', key: 'nav.inventory', needs: ['inventory.read', 'inventory.count'] },
  { href: '/purchasing', key: 'nav.purchasing', needs: ['purchasing.manage', 'inventory.read'] },
  { href: '/books', key: 'nav.books', needs: ['accounting.read'] },
  { href: '/reports/sales', match: '/reports', key: 'nav.reports', needs: ['reports.read'] },
  { href: '/offline-sales', key: 'nav.offline', needs: ['cash.reconcile'] },
  { href: '/locations', key: 'nav.locations', needs: ['org.read', 'terminals.manage'] },
  { href: '/team', key: 'nav.team', needs: ['members.read'] },
  { href: '/subscription', key: 'nav.subscription', needs: ['subscription.manage', 'tenant.manage'] },
];

/** The business offers this area (business type). */
export const offered = (item: Pick<NavItem, 'salon' | 'pharmacy'>, businessType: BusinessType) =>
  (!item.salon || servesAppointments(businessType)) && (!item.pharmacy || servesPharmacy(businessType));

/** The person's permissions open this area (UI hint only; the API enforces access). */
export const permitted = (item: Pick<NavItem, 'needs'>, permissions: readonly string[]) =>
  !item.needs || item.needs.some((p) => permissions.includes(p));
