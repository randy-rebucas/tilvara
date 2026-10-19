import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, openSupport, writeAuthCookies, writeSupportCookies } from './lib/auth-cookies';
import { API_URL } from './lib/config';
import { ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, SUPPORT_COOKIE, TENANT_COOKIE } from './lib/cookies';

const PUBLIC = ['/sign-in', '/sign-up', '/accept-invite', '/forgot-password', '/reset-password', '/confirm-email'];
const REFRESH_MARGIN_MS = 60_000;

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
  const res = await session(request);
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

/** Pass the request on with its (possibly updated) headers: the CSP and any refreshed cookie. */
const forward = (req: NextRequest) => NextResponse.next({ request: { headers: req.headers } });

/**
 * Optimistic session handling only (authorization is always enforced by the API):
 * refresh the access token shortly before it expires, and send signed-out visitors to sign-in.
 */
async function session(request: NextRequest) {
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
    const o = await openSupport(API_URL, refresh, supportGrant);
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
    const tenantId = request.cookies.get(TENANT_COOKIE)?.value;
    const r = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    const url = new URL('/sign-in', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return forward(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
