import type { Denomination } from '@/components/note';
import type { MessageKey } from '@/i18n/messages';
import { servesAppointments, servesPharmacy, type BusinessType } from './business-type';
import { NAV_ITEMS, offered, permitted, type NavItem } from './nav';

/**
 * The user guide (`/help`): one section per area of the back office, in the order an owner sets
 * up a business. Copy lives in the message catalog as `guide.<id>.lede`, `guide.<id>.s1…` (steps)
 * and `guide.<id>.t1…` (good to know); `guide.test.ts` checks every key exists in EN and FIL.
 */
export type GuideTopic =
  | 'start'
  | 'products'
  | 'prices'
  | 'retail'
  | 'inventory'
  | 'tingi'
  | 'purchasing'
  | 'salon'
  | 'pharmacy'
  | 'reports'
  | 'customers'
  | 'books'
  | 'offline'
  | 'drawers'
  | 'locations'
  | 'team'
  | 'subscription'
  | 'account'
  | 'till';

export interface GuideLine {
  key: MessageKey;
}

export interface GuideSection {
  id: GuideTopic;
  title: MessageKey;
  lede: MessageKey;
  /** The band tab for this area: its permissions and business type decide who can open it. */
  area?: NavItem;
  /** Where "Open …" goes when it is not the tab's own page. */
  href?: string;
  denom: Denomination;
  steps: GuideLine[];
  tips: GuideLine[];
}

const area = (href: string) => NAV_ITEMS.find((i) => i.href === href)!;
/** Customers (ADR-0018) have no band tab; this stands in for one in the guide. */
export const CUSTOMERS_AREA: NavItem = { href: '/customers', key: 'cust.title', needs: ['customers.read', 'customers.manage'] };

/** `n` keys `guide.<id>.<kind>1…n`. */
const lines = (id: GuideTopic, kind: 's' | 't', n: number): GuideLine[] =>
  Array.from({ length: n }, (_, i) => ({ key: `guide.${id}.${kind}${i + 1}` as MessageKey }));

const section = (
  id: GuideTopic,
  title: MessageKey,
  denom: Denomination,
  steps: number,
  tips: number,
  opts: { area?: NavItem; href?: string } = {},
): GuideSection => ({
  id,
  title,
  lede: `guide.${id}.lede` as MessageKey,
  area: opts.area,
  ...(opts.href && { href: opts.href }),
  denom,
  steps: lines(id, 's', steps),
  tips: lines(id, 't', tips),
});

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  section('start', 'guide.start.title', 'none', 6, 3),
  section('products', 'nav.products', 'blue', 7, 2, { area: area('/products') }),
  section('prices', 'nav.prices', 'blue', 4, 2, { area: area('/prices') }),
  // ADR-0021: promotions, sizes and colours, quick keys, labels and shelf locations (a shop's or boutique's tools).
  section('retail', 'guide.retail.title', 'blue', 6, 3, { area: area('/products'), href: '/prices/promotions' }),
  section('inventory', 'nav.inventory', 'gold', 5, 4, { area: area('/inventory') }),
  // ADR-0020: packs and pieces, expiry dates. For every type; the sari-sari store's part above all.
  section('tingi', 'guide.tingi.title', 'gold', 4, 3, { area: area('/inventory'), href: '/inventory/packs' }),
  section('purchasing', 'nav.purchasing', 'gold', 7, 5, { area: area('/purchasing') }),
  // ADR-0022: staff, the appointment calendar, services and packages, client history, commissions, tips.
  section('salon', 'guide.salon.title', 'green', 6, 5, { area: area('/appointments') }),
  // ADR-0025: medicines and their classes, receiving batches, prescriptions, the two books, batch trace and holds, expired stock.
  section('pharmacy', 'guide.pharmacy.title', 'none', 7, 5, { area: area('/pharmacy') }),
  section('reports', 'nav.reports', 'none', 4, 3, { area: area('/reports/sales') }),
  // No band tab (the band is full): reached from the Overview and from each sale; who may open it is its own rule.
  section('customers', 'cust.title', 'green', 5, 2, { area: CUSTOMERS_AREA }),
  section('books', 'nav.books', 'ink', 5, 2, { area: area('/books') }),
  section('offline', 'off.title', 'orange', 3, 1, { area: area('/offline-sales') }),
  // Same managers (cash.reconcile) as offline sales; no tab of its own (the band is full), reached from there and the overview.
  section('drawers', 'drawers.title', 'orange', 3, 2, { area: area('/offline-sales'), href: '/shifts' }),
  section('locations', 'nav.locations', 'violet', 5, 3, { area: area('/locations') }),
  section('team', 'nav.team', 'green', 4, 2, { area: area('/team') }),
  section('subscription', 'nav.subscription', 'none', 5, 1, { area: area('/subscription') }),
  section('account', 'guide.account.title', 'none', 4, 2),
  section('till', 'guide.till.title', 'orange', 3, 1),
];

/**
 * The guide as this business sees it: areas its type leaves out are gone.
 * `permitted` is false when the person's role does not open the area (the section still shows, so
 * a cashier can read what a manager does).
 */
export function guideFor(businessType: BusinessType, permissions: readonly string[]) {
  return GUIDE_SECTIONS.filter((s) => !s.area || offered(s.area, businessType)).map((s) => ({
    ...s,
    permitted: !s.area || permitted(s.area, permissions),
  }));
}

/** Longest prefix wins; anything else falls back to getting started. */
const TOPIC_BY_PATH: readonly [string, GuideTopic][] = [
  ['/products', 'products'],
  ['/products/categories', 'products'],
  ['/products/units', 'products'],
  ['/prices', 'prices'],
  ['/prices/promotions', 'retail'],
  ['/products/quick-keys', 'retail'],
  ['/products/labels', 'retail'],
  ['/inventory', 'inventory'],
  ['/inventory/packs', 'tingi'],
  ['/inventory/expiry', 'tingi'],
  ['/purchasing', 'purchasing'],
  ['/appointments', 'salon'],
  ['/reports/commissions', 'salon'],
  ['/reports/service-packages', 'salon'],
  ['/reports/staff-tips', 'salon'],
  ['/reports/tips', 'salon'],
  ['/reports/ingredient-usage', 'salon'],
  ['/pharmacy', 'pharmacy'],
  ['/reports', 'reports'],
  ['/sales', 'reports'],
  ['/customers', 'customers'],
  ['/shifts', 'drawers'],
  ['/books', 'books'],
  ['/offline-sales', 'offline'],
  ['/locations', 'locations'],
  ['/team', 'team'],
  ['/audit', 'team'],
  ['/subscription', 'subscription'],
  ['/account', 'account'],
  ['/security', 'account'],
];

/**
 * The guide section for the page at `path` (the band's help button opens `/help#<topic>`). An
 * appointments or pharmacy page in a business that does not offer it shows a notice to change the
 * type of business, so it opens the Subscription part, which explains that (the guide has no salon
 * part for a retail shop).
 */
export function topicFor(path: string, businessType: BusinessType = 'HYBRID'): GuideTopic {
  const hit = TOPIC_BY_PATH.filter(([p]) => path === p || path.startsWith(`${p}/`)).sort((a, b) => b[0].length - a[0].length)[0];
  const topic = hit?.[1] ?? 'start';
  if (topic === 'salon' && !servesAppointments(businessType)) return 'subscription';
  if (topic === 'pharmacy' && !servesPharmacy(businessType)) return 'subscription';
  return topic;
}
