import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies } from '@/lib/auth-cookies';

/**
 * The API refused the session's token (signed out elsewhere, revoked, or a reset database): drop the
 * cookies and go to sign-in. Left in place, they made the proxy treat the browser as signed in, so the
 * home page sent it to sign-in instead of showing the landing page, every time. It only ever removes
 * access, so a GET is fine.
 */
export async function GET(request: NextRequest) {
  const reply = NextResponse.redirect(new URL('/sign-in', request.url));
  reply.headers.set('cache-control', 'private, no-store');
  clearAuthCookies(reply);
  return reply;
}
