import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_HEADER } from './cookies';

/**
 * Mutations must come from our own pages: same-origin (Origin/Host match) and carry the
 * custom header a cross-site form or <img> cannot add. Cookies are also SameSite=Lax.
 */
export function rejectCrossSite(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
  if (!sameOrigin || request.headers.get(CSRF_HEADER) !== '1') {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Cross-site request refused' } }, { status: 403 });
  }
  return null;
}
