import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies } from '@/lib/auth-cookies';

/**
 * The API refused the session's token (signed out elsewhere, revoked, or a reset database): drop the
 * cookies and go to sign-in. Left in place, they made the proxy treat the browser as signed in, so the
 * home page sent it to sign-in instead of showing the landing page, every time. It only ever removes
 * access, so a GET is fine.
 *
 * The cookies are dropped only when the browser says the request came from the admin itself or from
 * the person (`Sec-Fetch-Site` same-origin or none; a browser that sends no such header is trusted, as
 * before). A link on another site lands on sign-in with the cookies kept (audit 2026-10-31, Info): it
 * cannot sign the browser out. Our own redirect (`lib/api.ts` on a 401) is same-origin, or none when the
 * person opened the page directly; a page entered from another site's link keeps the cookies until the
 * next sign-in replaces them or the next same-origin page clears them, and still lands on sign-in.
 */
export async function GET(request: NextRequest) {
  const reply = NextResponse.redirect(new URL('/sign-in', request.url));
  reply.headers.set('cache-control', 'private, no-store');
  const site = request.headers.get('sec-fetch-site');
  if (site === null || site === 'same-origin' || site === 'none') clearAuthCookies(reply);
  return reply;
}
