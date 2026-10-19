import type { Denomination } from '@/components/note';
import type { MessageKey } from '@/i18n/messages';
import { hasRestaurant, sellsByWeight, type BusinessType } from './business-type';
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
  | 'inventory'
  | 'purchasing'
  | 'restaurant'
  | 'reports'
  | 'books'
  | 'offline'
  | 'drawers'
  | 'locations'
  | 'team'
  | 'subscription'
  | 'account'
  | 'till';

/** A line that only makes sense for some businesses (restaurant service, selling by weight). */
type Only = 'restaurant' | 'weight';

export interface GuideLine {
  key: MessageKey;
  only?: Only;
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

/** `n` keys `guide.<id>.<kind>1…n`; `only` marks lines by their number. */
const lines = (id: GuideTopic, kind: 's' | 't', n: number, only: Record<number, Only> = {}): GuideLine[] =>
  Array.from({ length: n }, (_, i) => ({ key: `guide.${id}.${kind}${i + 1}` as MessageKey, ...(only[i + 1] && { only: only[i + 1] }) }));

const section = (
  id: GuideTopic,
  title: MessageKey,
  denom: Denomination,
  steps: number,
  tips: number,
  opts: { area?: NavItem; href?: string; only?: { s?: Record<number, Only>; t?: Record<number, Only> } } = {},
): GuideSection => ({
  id,
  title,
  lede: `guide.${id}.lede` as MessageKey,
  area: opts.area,
  ...(opts.href && { href: opts.href }),
  denom,
  steps: lines(id, 's', steps, opts.only?.s),
  tips: lines(id, 't', tips, opts.only?.t),
});

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  section('start', 'guide.start.title', 'none', 6, 3),
  section('products', 'nav.products', 'blue', 5, 2, { area: area('/products'), only: { t: { 1: 'weight' } } }),
  section('prices', 'nav.prices', 'blue', 4, 2, { area: area('/prices') }),
  section('inventory', 'nav.inventory', 'gold', 5, 3, { area: area('/inventory'), only: { t: { 3: 'restaurant' } } }),
  section('purchasing', 'nav.purchasing', 'gold', 5, 1, { area: area('/purchasing') }),
  section('restaurant', 'nav.restaurant', 'none', 6, 2, { area: area('/restaurant') }),
  section('reports', 'nav.reports', 'none', 5, 2, { area: area('/reports/sales'), only: { s: { 5: 'restaurant' } } }),
  section('books', 'nav.books', 'ink', 5, 2, { area: area('/books') }),
  section('offline', 'off.title', 'orange', 3, 1, { area: area('/offline-sales') }),
  // Same managers (cash.reconcile) as offline sales; no tab of its own (the band is full), reached from there and the overview.
  section('drawers', 'drawers.title', 'orange', 3, 2, { area: area('/offline-sales'), href: '/shifts' }),
  section('locations', 'nav.locations', 'violet', 5, 2, { area: area('/locations') }),
  section('team', 'nav.team', 'green', 4, 2, { area: area('/team') }),
  section('subscription', 'nav.subscription', 'none', 4, 1, { area: area('/subscription') }),
  section('account', 'guide.account.title', 'none', 4, 2),
  section('till', 'guide.till.title', 'orange', 4, 1, { only: { s: { 4: 'restaurant' } } }),
];

const shows = (line: GuideLine, businessType: BusinessType) =>
  line.only === 'restaurant' ? hasRestaurant(businessType) : line.only === 'weight' ? sellsByWeight(businessType) : true;

/**
 * The guide as this business sees it: areas its type leaves out are gone, as are lines about them.
 * `permitted` is false when the person's role does not open the area (the section still shows, so
 * a cashier can read what a manager does).
 */
export function guideFor(businessType: BusinessType, permissions: readonly string[]) {
  return GUIDE_SECTIONS.filter((s) => !s.area || offered(s.area, businessType)).map((s) => ({
    ...s,
    steps: s.steps.filter((l) => shows(l, businessType)),
    tips: s.tips.filter((l) => shows(l, businessType)),
    permitted: !s.area || permitted(s.area, permissions),
  }));
}

/** Longest prefix wins; anything else falls back to getting started. */
const TOPIC_BY_PATH: readonly [string, GuideTopic][] = [
  ['/products', 'products'],
  ['/prices', 'prices'],
  ['/inventory', 'inventory'],
  ['/purchasing', 'purchasing'],
  ['/restaurant', 'restaurant'],
  ['/reports', 'reports'],
  ['/sales', 'reports'],
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
 * The guide section for the page at `path` (the band's help button opens `/help#<topic>`). A
 * restaurant page in a retail shop shows a notice to change the type of business, so it opens the
 * Subscription part, which explains that (the guide has no restaurant part for a retail shop).
 */
export function topicFor(path: string, businessType: BusinessType = 'HYBRID'): GuideTopic {
  const hit = TOPIC_BY_PATH.filter(([p]) => path === p || path.startsWith(`${p}/`)).sort((a, b) => b[0].length - a[0].length)[0];
  const topic = hit?.[1] ?? 'start';
  return topic === 'restaurant' && !hasRestaurant(businessType) ? 'subscription' : topic;
}
