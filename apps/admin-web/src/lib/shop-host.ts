import { isSubdomainSlug, shopAddress } from '@1pos/validation';
import type { PublicShop } from './api';
import { API_URL } from './config';

/**
 * A business's own address (session 40): `<slug>.<ONEPOS_SHOP_DOMAIN>` serves its sign-in page and,
 * once signed in, the back office pinned to that business. Off when the variable is unset. The shop
 * must have switched its own sign-in page on (Branding); any other subdomain goes to the main sign-in,
 * so the address says no more than `/s/<slug>` does.
 */
/** Where the main admin lives (sign-up, choosing a business, support), e.g. https://app.tilvara.ph. */
const ADMIN_URL = /^https?:\/\//.test(process.env.ONEPOS_ADMIN_URL ?? '') ? process.env.ONEPOS_ADMIN_URL!.replace(/\/+$/, '') : null;

/**
 * Needs `ONEPOS_ADMIN_URL` as well: inside the proxy the request URL is the server's own bind address
 * (scheme included), not what the browser asked for, so the main address cannot be guessed from it.
 */
export const SHOP_DOMAIN = (ADMIN_URL && (process.env.ONEPOS_SHOP_DOMAIN ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')) || null;

/**
 * Request headers the proxy sets on a shop's host, after deleting whatever the browser sent under
 * the same names: route handlers and pages read them to know which business the address belongs to.
 */
export const SHOP_HEADER = 'x-onepos-shop';
export const SHOP_TENANT_HEADER = 'x-onepos-shop-tenant';

/** The shop slug a Host header names, or null for the main admin or any host that is not a shop's. */
export function shopSlugOfHost(host: string | null, domain: string | null = SHOP_DOMAIN, adminUrl: string | null = ADMIN_URL): string | null {
  if (!domain || !host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (adminUrl && name === new URL(adminUrl).hostname) return null;
  if (!name.endsWith(`.${domain}`)) return null;
  const label = name.slice(0, -domain.length - 1);
  return isSubdomainSlug(label) ? label : null;
}

/** An address on the main admin (only reached on a shop's host, so `ONEPOS_ADMIN_URL` is set). */
export const mainUrl = (path: string): string => `${ADMIN_URL ?? ''}${path}`;

/** A shop's own address (scheme and port as the main admin's), or null when addresses are off. */
export function shopOrigin(slug: string, domain: string | null = SHOP_DOMAIN, adminUrl: string | null = ADMIN_URL): string | null {
  return shopAddress(slug, domain, adminUrl);
}
const TTL_MS = 60_000;
/** A miss is kept briefly, so a page just switched on answers within seconds. */
const MISS_TTL_MS = 10_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, { at: number; shop: PublicShop | null }>();

/**
 * The shop's public face, or null for a slug nobody uses or a shop whose page is off. The proxy's
 * lookup (which business an address is) is kept for a minute per process, a miss for 10 s: every
 * visitor's request would otherwise reach the API from this server's address, under one per-IP limit.
 * The page itself asks `fresh`, so its name, colour and images are never older than the page view.
 */
export async function findShop(slug: string, { fresh = false, visitor = {} }: { fresh?: boolean; visitor?: Record<string, string> } = {}): Promise<PublicShop | null> {
  const hit = cache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < (hit.shop ? TTL_MS : MISS_TTL_MS)) return hit.shop;
  const res = await fetch(`${API_URL}/public/shops/${encodeURIComponent(slug)}`, { headers: visitor, cache: 'no-store' }).catch(() => null);
  // An API that cannot answer (5xx, 429, down) is not "no such shop": keep what was known, don't cache the miss.
  if (!res || (!res.ok && res.status !== 404)) return hit?.shop ?? null;
  const shop = res.ok ? ((await res.json()) as PublicShop) : null;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(slug, { at: Date.now(), shop });
  return shop;
}
