import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, writeAuthCookies, type TokenSet } from '@/lib/auth-cookies';
import { API_URL, SECURE_COOKIES } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE, MFA_COOKIE } from '@/lib/cookies';
import { rejectCrossSite } from '@/lib/csrf';

interface AuthResponse {
  activeTenantId: string | null;
  memberships: unknown[];
  tokens: TokenSet;
}

interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  challengeExpiresAt: string;
}

const MFA_COOKIE_OPTS = { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'strict' as const, path: '/api/auth' };
const clearMfaCookie = (res: NextResponse) => res.cookies.set(MFA_COOKIE, '', { ...MFA_COOKIE_OPTS, maxAge: 0 });

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
    case 'login': {
      const { res, json } = await callApi('/auth/login', input);
      if (!res.ok) return passError(res, json);
      const challenge = json as Partial<MfaChallenge>;
      if (challenge.mfaRequired && challenge.challengeToken) {
        // The challenge stays server-side like every other token; the browser only learns a code is needed.
        const reply = NextResponse.json({ mfaRequired: true });
        reply.cookies.set(MFA_COOKIE, challenge.challengeToken, { ...MFA_COOKIE_OPTS, expires: new Date(challenge.challengeExpiresAt!) });
        return reply;
      }
      return sessionReply(json as AuthResponse);
    }
    case 'signup': {
      const { res, json } = await callApi('/auth/signup', input);
      return res.ok ? sessionReply(json as AuthResponse) : passError(res, json);
    }
    case 'mfa-verify': {
      const challengeToken = request.cookies.get(MFA_COOKIE)?.value;
      if (!challengeToken) {
        return NextResponse.json({ error: { code: 'INVALID_MFA_CHALLENGE', message: 'Sign in again' } }, { status: 401 });
      }
      const { code, recoveryCode } = input as { code?: string; recoveryCode?: string };
      const { res, json } = await callApi('/auth/mfa/verify', { challengeToken, ...(code ? { code } : { recoveryCode }) });
      if (!res.ok) {
        const reply = passError(res, json);
        if ((json as { error?: { code?: string } } | null)?.error?.code === 'INVALID_MFA_CHALLENGE') clearMfaCookie(reply);
        return reply;
      }
      const reply = sessionReply(json as AuthResponse);
      clearMfaCookie(reply);
      return reply;
    }
    case 'password-reset-request':
    case 'password-reset-confirm': {
      const { res, json } = await callApi(`/auth/password-reset/${action.slice('password-reset-'.length)}`, input);
      return res.ok ? NextResponse.json(json ?? { ok: true }) : passError(res, json);
    }
    case 'mfa-enroll':
    case 'mfa-confirm':
    case 'mfa-disable':
    case 'mfa-recovery-codes': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi(`/auth/mfa/${action.slice('mfa-'.length)}`, input, bearer);
      return res.ok ? NextResponse.json(json ?? { ok: true }) : passError(res, json);
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
