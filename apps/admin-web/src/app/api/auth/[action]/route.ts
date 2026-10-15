import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, writeAuthCookies, type TokenSet } from '@/lib/auth-cookies';
import { API_URL, SECURE_COOKIES } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE } from '@/lib/cookies';
import { rejectCrossSite } from '@/lib/csrf';

interface AuthResponse {
  activeTenantId: string | null;
  memberships: unknown[];
  tokens: TokenSet;
}

async function callApi(path: string, body: unknown, bearer?: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, json };
}

/** Pass API errors through unchanged (they are already safe, user-facing envelopes). */
function passError(res: Response, json: unknown) {
  return NextResponse.json(json ?? { error: { code: 'ERROR', message: 'Request failed' } }, { status: res.status });
}

/** Strip tokens before anything reaches the browser. */
function sessionReply(body: AuthResponse) {
  const reply = NextResponse.json({ activeTenantId: body.activeTenantId, memberships: body.memberships });
  writeAuthCookies(reply, body.tokens, body.activeTenantId);
  return reply;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const refused = rejectCrossSite(request);
  if (refused) return refused;
  const { action } = await params;
  const input = await request.json().catch(() => ({}));
  const bearer = request.cookies.get(ACCESS_COOKIE)?.value;

  switch (action) {
    case 'login':
    case 'signup': {
      const { res, json } = await callApi(`/auth/${action}`, input);
      return res.ok ? sessionReply(json as AuthResponse) : passError(res, json);
    }
    case 'accept-invite': {
      const { res, json } = await callApi('/invitations/accept', input);
      return res.ok ? sessionReply(json as AuthResponse) : passError(res, json);
    }
    case 'accept-invite-existing': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi('/invitations/accept-existing', input, bearer);
      if (!res.ok) return passError(res, json);
      return NextResponse.json(json);
    }
    case 'switch': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi('/auth/switch-tenant', input, bearer);
      if (!res.ok) return passError(res, json);
      const tokens = json as { accessToken: string; accessTokenExpiresAt: string };
      const reply = NextResponse.json({ activeTenantId: (input as { tenantId: string }).tenantId });
      writeAuthCookies(reply, tokens, (input as { tenantId: string }).tenantId);
      return reply;
    }
    case 'logout': {
      if (bearer) await callApi('/auth/logout', {}, bearer).catch(() => null);
      const reply = NextResponse.json({ ok: true });
      clearAuthCookies(reply);
      return reply;
    }
    case 'lang': {
      const lang = (input as { lang?: string }).lang === 'fil' ? 'fil' : 'en';
      const reply = NextResponse.json({ lang });
      reply.cookies.set(LANG_COOKIE, lang, { httpOnly: false, secure: SECURE_COOKIES, sameSite: 'lax', path: '/', maxAge: 31536000 });
      return reply;
    }
    default:
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Unknown action' } }, { status: 404 });
  }
}
