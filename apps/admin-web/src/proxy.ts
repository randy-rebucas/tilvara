import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, openSupport, writeAuthCookies, writeSupportCookies } from './lib/auth-cookies';
import { API_URL } from './lib/config';
import { ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, SUPPORT_COOKIE, TENANT_COOKIE } from './lib/cookies';
import { findShop, mainUrl, SHOP_HEADER, SHOP_TENANT_HEADER, shopOrigin, shopSlugOfHost } from './lib/shop-host';
import { visitorHeaders } from './lib/visitor';

// `/s/<slug>`: a shop's own sign-in page (session 39), shown only when the business switched it on.
// `/handoff`: a business's own address taking over a sign-in made on the main one (session 41).
// `/welcome`: the public landing page.
const PUBLIC = ['/sign-in', '/sign-up', '/accept-invite', '/forgot-password', '/reset-password', '/confirm-email', '/s/', '/handoff', '/welcome'];
const REFRESH_MARGIN_MS = 60_000;
/** Pages that belong to the main admin, not to one business's own address (session 40). */
const MAIN_ONLY = ['/sign-up', '/select-business', '/support', '/welcome'];

const isDev = process.env.NODE_ENV === 'development';

/**
 * Content Security Policy with a fresh nonce per request (Next 16 guide, "Adding a nonce with Proxy";
 * ADR-0016 amendment, session 16). Next reads the nonce from the request's header and puts it on its
 * own scripts; `'strict-dynamic'` lets those load the rest, and no other script can run, inline or
 * injected. Styles keep `'unsafe-inline'`: server-rendered `style` attributes (the note stripes) cannot
 * carry a nonce. React needs eval only in development.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Every page and route answer: the session work below, then the policy on the response. */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  request.headers.set('x-nonce', nonce);
  request.headers.set('content-security-policy', csp);
  // Only this proxy says which business an address belongs to; whatever the browser sent is dropped.
  request.headers.delete(SHOP_HEADER);
  request.headers.delete(SHOP_TENANT_HEADER);
  const res = await shopAddress(request);
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

interface Shop {
  slug: string;
  tenantId: string;
}

/**
 * A business's own address, `<slug>.<ONEPOS_SHOP_DOMAIN>` (session 40). Unknown shops and shops whose
 * sign-in page is off go to the main sign-in, like any other address. On a shop's address the session
 * belongs to that business: refreshed for it, and a session for any other business is signed out.
 */
async function shopAddress(request: NextRequest) {
  const slug = shopSlugOfHost(request.headers.get('host'));
  if (!slug) {
    // On the main address, a shop's `/s/<slug>` page moves to its own address when it has one (session 41).
    const own = /^\/s\/([^/]+)\/?$/.exec(request.nextUrl.pathname)?.[1];
    const origin = own ? shopOrigin(own) : null;
    if (origin && (await findShop(own!, { visitor: visitorHeaders(request.headers) }))) {
      return NextResponse.redirect(`${origin}/sign-in${request.nextUrl.search}`);
    }
    return session(request, null);
  }
  const found = await findShop(slug, { visitor: visitorHeaders(request.headers) });
  if (!found) return NextResponse.redirect(mainUrl('/sign-in'));
  const shop = { slug, tenantId: found.tenantId };
  request.headers.set(SHOP_HEADER, slug);
  request.headers.set(SHOP_TENANT_HEADER, shop.tenantId);

  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/s/')) return NextResponse.redirect(new URL('/sign-in', request.url));
  if (MAIN_ONLY.some((p) => pathname.startsWith(p))) return NextResponse.redirect(mainUrl(pathname));

  const res = await session(request, shop);
  if (res.headers.has('location')) return res;
  const tid = tenantOfToken(request.cookies.get(ACCESS_COOKIE)?.value);
  if (tid !== undefined && tid !== shop.tenantId && !pathname.startsWith('/api/auth/') && !PUBLIC.some((p) => pathname.startsWith(p))) {
    const out = pathname.startsWith('/api/')
      ? NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to this business' } }, { status: 401 })
      : NextResponse.redirect(new URL('/sign-in', request.url));
    clearAuthCookies(out);
    return out;
  }
  return res;
}

/**
 * The business an access token is for, read without verifying: it only decides which page this
 * browser is sent to (the API verifies every token). `undefined` when there is no readable token.
 */
function tenantOfToken(token: string | undefined): string | null | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { tid?: unknown };
    return typeof payload.tid === 'string' ? payload.tid : null;
  } catch {
    return undefined;
  }
}

/**
 * Pass the request on with its (possibly updated) headers: the CSP and any refreshed cookie. On a
 * shop's address, `/sign-in` itself shows the shop's sign-in (it reads `x-onepos-shop`). No rewrite to
 * `/s/<slug>`: the app binds 127.0.0.1, which Next calls `localhost` in `request.url` but not when it
 * decides whether a rewrite stays inside, so a rewrite went out as a request to the main address, whose
 * `/s/<slug>` redirect sent it back here (a loop since session 41).
 */
function forward(req: NextRequest) {
  return NextResponse.next({ request: { headers: req.headers } });
}

/**
 * Optimistic session handling only (authorization is always enforced by the API):
 * refresh the access token shortly before it expires, and send signed-out visitors to sign-in.
 */
async function session(request: NextRequest, shop: Shop | null) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const exp = Number(request.cookies.get(ACCESS_EXP_COOKIE)?.value ?? 0);
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  const fresh = access && exp - Date.now() > REFRESH_MARGIN_MS;
  const supportGrant = request.cookies.get(SUPPORT_COOKIE)?.value;
  if (!fresh && refresh && supportGrant) {
    // A staff member's support view: re-open the grant (the API re-checks it every request). Once
    // it has ended, fall back to the staff member's own session on the support page.
    const o = await openSupport(API_URL, refresh, supportGrant, visitorHeaders(request.headers));
    if (o.refreshed && o.support) {
      request.cookies.set(ACCESS_COOKIE, o.support.accessToken);
      const res = forward(request);
      writeSupportCookies(res, o.refreshed, o.support, supportGrant);
      return res;
    }
    if (o.refreshed) {
      request.cookies.set(ACCESS_COOKIE, o.refreshed.accessToken);
      const res = pathname.startsWith('/api/') ? forward(request) : NextResponse.redirect(new URL('/support', request.url));
      writeAuthCookies(res, o.refreshed, null);
      res.cookies.delete(SUPPORT_COOKIE);
      return res;
    }
    if (o.status === 401 || o.status === 403) {
      const res = isPublic ? forward(request) : NextResponse.redirect(new URL('/sign-in', request.url));
      clearAuthCookies(res);
      return res;
    }
  } else if (!fresh && refresh) {
    const tenantId = shop?.tenantId ?? request.cookies.get(TENANT_COOKIE)?.value;
    const r = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { ...visitorHeaders(request.headers), 'content-type': 'application/json' },
      body: JSON.stringify(tenantId ? { refreshToken: refresh, tenantId } : { refreshToken: refresh }),
      cache: 'no-store',
    }).catch(() => null);
    if (r?.ok) {
      const body = (await r.json()) as { activeTenantId: string | null; tokens: Parameters<typeof writeAuthCookies>[1] };
      // Make the new token visible to this same request's server components…
      request.cookies.set(ACCESS_COOKIE, body.tokens.accessToken);
      const res = forward(request);
      // …and persist it for the browser.
      writeAuthCookies(res, body.tokens, body.activeTenantId);
      return res;
    }
    if (r && (r.status === 401 || r.status === 403)) {
      const res = isPublic ? forward(request) : NextResponse.redirect(new URL('/sign-in', request.url));
      clearAuthCookies(res);
      return res;
    }
  }

  if (!access && !refresh && !isPublic && !pathname.startsWith('/api/')) {
    // A signed-out visitor to the main address's home page sees the landing page there; a business's
    // own address has no landing page.
    if (pathname === '/' && !shop) {
      const landing = request.nextUrl.clone();
      landing.pathname = '/welcome';
      return NextResponse.rewrite(landing, { request: { headers: request.headers } });
    }
    const url = new URL('/sign-in', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return forward(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
