import type { MessageKey } from '@/i18n/messages';
import { hasRestaurant, servesAppointments, servesLaundry, servesLodging, servesPharmacy, type BusinessType } from './business-type';

/**
 * The band's tabs. A plain module (not the client nav component) so server pages such as the user
 * guide can use the same list and rules.
 * `match`: the path prefix that marks the tab active when it differs from where the tab goes.
 * `restaurant`: only for a business that serves tables (not RETAIL, GROCERY or SALON).
 * `salon`: only for a business that takes appointments (SALON or HYBRID, ADR-0022).
 * `lodging`: only for a business with rooms (LODGING or HYBRID, ADR-0023).
 * `laundry`: only for a laundry shop or laundromat (LAUNDRY or HYBRID, ADR-0024).
 * `pharmacy`: only for a pharmacy or drugstore (PHARMACY or HYBRID, ADR-0025).
 */
export interface NavItem {
  href: string;
  key: MessageKey;
  needs?: string[];
  match?: string;
  restaurant?: true;
  salon?: true;
  lodging?: true;
  laundry?: true;
  pharmacy?: true;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', key: 'nav.overview' },
  { href: '/lodging', key: 'nav.lodging', needs: ['lodging.read', 'lodging.housekeeping', 'lodging.setup'], lodging: true },
  { href: '/laundry', key: 'nav.laundry', needs: ['laundry.read', 'laundry.deliver', 'laundry.setup'], laundry: true },
  { href: '/pharmacy', key: 'nav.pharmacy', needs: ['pharmacy.read', 'pharmacy.setup'], pharmacy: true },
  { href: '/appointments', key: 'nav.appointments', needs: ['appointments.read', 'appointments.manage', 'staff.manage'], salon: true },
  { href: '/products', key: 'nav.products', needs: ['catalog.read'] },
  { href: '/prices', key: 'nav.prices', needs: ['catalog.read'] },
  { href: '/inventory', key: 'nav.inventory', needs: ['inventory.read', 'inventory.count'] },
  { href: '/purchasing', key: 'nav.purchasing', needs: ['purchasing.manage', 'inventory.read'] },
  { href: '/books', key: 'nav.books', needs: ['accounting.read'] },
  { href: '/restaurant', key: 'nav.restaurant', needs: ['restaurant.manage'], restaurant: true },
  { href: '/reports/sales', match: '/reports', key: 'nav.reports', needs: ['reports.read'] },
  { href: '/offline-sales', key: 'nav.offline', needs: ['cash.reconcile'] },
  { href: '/locations', key: 'nav.locations', needs: ['org.read', 'terminals.manage'] },
  { href: '/team', key: 'nav.team', needs: ['members.read'] },
  { href: '/subscription', key: 'nav.subscription', needs: ['subscription.manage', 'tenant.manage'] },
];

/** The business offers this area (business type and, when known, the plan's features). */
export const offered = (item: Pick<NavItem, 'restaurant' | 'salon' | 'lodging' | 'laundry' | 'pharmacy'>, businessType: BusinessType, features?: readonly string[]) =>
  (!item.restaurant || hasRestaurant(businessType, features)) && (!item.salon || servesAppointments(businessType)) && (!item.lodging || servesLodging(businessType)) &&
  (!item.laundry || servesLaundry(businessType)) && (!item.pharmacy || servesPharmacy(businessType));

/** The person's permissions open this area (UI hint only; the API enforces access). */
export const permitted = (item: Pick<NavItem, 'needs'>, permissions: readonly string[]) =>
  !item.needs || item.needs.some((p) => permissions.includes(p));
