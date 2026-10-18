import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, openSupport, writeAuthCookies, writeSupportCookies } from './lib/auth-cookies';
import { API_URL } from './lib/config';
import { ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, SUPPORT_COOKIE, TENANT_COOKIE } from './lib/cookies';

const PUBLIC = ['/sign-in', '/sign-up', '/accept-invite', '/forgot-password', '/reset-password', '/confirm-email'];
const REFRESH_MARGIN_MS = 60_000;

/**
 * Optimistic session handling only (authorization is always enforced by the API):
 * refresh the access token shortly before it expires, and send signed-out visitors to sign-in.
 */
export async function proxy(request: NextRequest) {
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
      const res = NextResponse.next({ request: { headers: request.headers } });
      writeSupportCookies(res, o.refreshed, o.support, supportGrant);
      return res;
    }
    if (o.refreshed) {
      request.cookies.set(ACCESS_COOKIE, o.refreshed.accessToken);
      const res = pathname.startsWith('/api/') ? NextResponse.next({ request: { headers: request.headers } }) : NextResponse.redirect(new URL('/support', request.url));
      writeAuthCookies(res, o.refreshed, null);
      res.cookies.delete(SUPPORT_COOKIE);
      return res;
    }
    if (o.status === 401 || o.status === 403) {
      const res = isPublic ? NextResponse.next() : NextResponse.redirect(new URL('/sign-in', request.url));
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
      const res = NextResponse.next({ request: { headers: request.headers } });
      // …and persist it for the browser.
      writeAuthCookies(res, body.tokens, body.activeTenantId);
      return res;
    }
    if (r && (r.status === 401 || r.status === 403)) {
      const res = isPublic ? NextResponse.next() : NextResponse.redirect(new URL('/sign-in', request.url));
      clearAuthCookies(res);
      return res;
    }
  }

  if (!access && !refresh && !isPublic && !pathname.startsWith('/api/')) {
    const url = new URL('/sign-in', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
