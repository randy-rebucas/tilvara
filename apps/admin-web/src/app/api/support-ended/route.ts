import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, writeAuthCookies, type TokenSet } from '@/lib/auth-cookies';
import { API_URL } from '@/lib/config';
import { REFRESH_COOKIE, SUPPORT_COOKIE } from '@/lib/cookies';

/**
 * The business ended (or the clock ended) a staff member's support view (ADR-0016 slice 6): drop
 * the support token, go back to the staff member's own session, and land on the support page. It
 * only ever removes access, so a GET is fine.
 */
export async function GET(request: NextRequest) {
  const reply = NextResponse.redirect(new URL('/support', request.url));
  reply.cookies.delete(SUPPORT_COOKIE);
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const r = refresh
    ? await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
        cache: 'no-store',
      }).catch(() => null)
    : null;
  if (r?.ok) writeAuthCookies(reply, ((await r.json()) as { tokens: TokenSet }).tokens, null);
  else clearAuthCookies(reply);
  return reply;
}
