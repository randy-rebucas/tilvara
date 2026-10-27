import { NextResponse, type NextRequest } from 'next/server';
import { clearAuthCookies, openSupport, writeAuthCookies, writeSupportCookies, type TokenSet } from '@/lib/auth-cookies';
import { API_URL, SECURE_COOKIES } from '@/lib/config';
import { ACCESS_COOKIE, LANG_COOKIE, MFA_COOKIE, REFRESH_COOKIE, SUPPORT_COOKIE } from '@/lib/cookies';
import { rejectCrossSite } from '@/lib/csrf';
import { SHOP_DOMAIN, SHOP_TENANT_HEADER, shopOrigin } from '@/lib/shop-host';
import { visitorHeaders } from '@/lib/visitor';
import { AsyncLocalStorage } from 'node:async_hooks';

/** The visitor's headers for every API call this request makes (session 40). */
const visitorScope = new AsyncLocalStorage<Record<string, string>>();
const visitor = () => visitorScope.getStore() ?? {};

/** What a business's own address (session 40) does not offer: they live on the main admin. */
const MAIN_ONLY_ACTIONS = new Set(['signup', 'support-open', 'support-leave']);

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
    headers: { ...visitor(), 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
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

/**
 * The user id an access token names. Read without verifying: it only decides whether to drop this
 * browser's own cookies, and a forged cookie can do no more than sign its own browser out. An
 * expired access cookie is simply gone; then the refresh fails on the next request instead.
 */
function accessSubject(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Where a sign-in on the main address continues (session 41): the business's own address when it has
 * one, with a one-time code in the fragment (never sent to a server or in a Referer). That address's
 * cookies are its own, so the code signs the browser in there; this address keeps its session for
 * choosing another business. Null on a shop's address, when addresses are off or the business has none.
 */
async function ownAddress(accessToken: string, shopTenantId: string | null): Promise<string | null> {
  if (shopTenantId || !SHOP_DOMAIN) return null;
  const { res, json } = await callApi('/auth/handoff', {}, accessToken).catch(() => ({ res: null, json: null }));
  if (!res?.ok) return null;
  const { code, tenantSlug } = json as { code: string; tenantSlug: string };
  const origin = shopOrigin(tenantSlug);
  return origin ? `${origin}/handoff#code=${encodeURIComponent(code)}` : null;
}

/** Strip tokens before anything reaches the browser. */
async function sessionReply(body: AuthResponse, shopTenantId: string | null, handoff = true) {
  const redirect = handoff && body.activeTenantId ? await ownAddress(body.tokens.accessToken, shopTenantId) : null;
  const reply = NextResponse.json({ activeTenantId: body.activeTenantId, memberships: body.memberships, ...(redirect ? { redirect } : {}) });
  writeAuthCookies(reply, body.tokens, body.activeTenantId);
  return reply;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const reply = rejectCrossSite(request) ?? (await visitorScope.run(visitorHeaders(request.headers), () => handle(request, params)));
  // Session replies (memberships, redirects to a shop's address) are per person: never cached.
  reply.headers.set('cache-control', 'private, no-store');
  reply.headers.set('vary', 'Cookie');
  return reply;
}

async function handle(request: NextRequest, params: Promise<{ action: string }>) {
  const { action } = await params;
  const input = await request.json().catch(() => ({}));
  const bearer = request.cookies.get(ACCESS_COOKIE)?.value;
  // Set by the proxy only (it drops a browser's own): on a shop's address, the business it belongs to.
  const shopTenantId = request.headers.get(SHOP_TENANT_HEADER);
  if (shopTenantId && MAIN_ONLY_ACTIONS.has(action)) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Unknown action' } }, { status: 404 });
  }

  switch (action) {
    case 'login': {
      // On a shop's address, sign-in is into that business whatever the form sent.
      const { res, json } = await callApi('/auth/login', shopTenantId ? { ...(input as object), tenantId: shopTenantId } : input);
      if (!res.ok) return passError(res, json);
      const challenge = json as Partial<MfaChallenge>;
      if (challenge.mfaRequired && challenge.challengeToken) {
        // The challenge stays server-side like every other token; the browser only learns a code is needed.
        const reply = NextResponse.json({ mfaRequired: true });
        reply.cookies.set(MFA_COOKIE, challenge.challengeToken, { ...MFA_COOKIE_OPTS, expires: new Date(challenge.challengeExpiresAt!) });
        return reply;
      }
      return sessionReply(json as AuthResponse, shopTenantId);
    }
    case 'signup': {
      // A new business has no address of its own yet (its sign-in page starts off).
      const { res, json } = await callApi('/auth/signup', input);
      return res.ok ? sessionReply(json as AuthResponse, shopTenantId, false) : passError(res, json);
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
      const reply = await sessionReply(json as AuthResponse, shopTenantId);
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
    case 'email-change': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi('/auth/email-change', input, bearer);
      return res.ok ? NextResponse.json(json) : passError(res, json);
    }
    // Both end every session of the account at the API: drop this browser's cookies with them.
    case 'account-close': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi('/auth/account/close', input, bearer);
      if (!res.ok) return passError(res, json);
      const reply = NextResponse.json({ ok: true });
      clearAuthCookies(reply);
      return reply;
    }
    // The link may be opened in a browser signed in as someone else: only the changed account's
    // sessions ended, so this browser keeps its cookies unless they are that account's.
    case 'email-change-confirm': {
      const { res, json } = await callApi('/auth/email-change/confirm', input);
      if (!res.ok) return passError(res, json);
      const reply = NextResponse.json({ ok: true });
      if (bearer && accessSubject(bearer) === (json as { userId?: string } | null)?.userId) clearAuthCookies(reply);
      return reply;
    }
    case 'accept-invite': {
      const { res, json } = await callApi('/invitations/accept', input);
      return res.ok ? sessionReply(json as AuthResponse, shopTenantId) : passError(res, json);
    }
    case 'accept-invite-existing': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const { res, json } = await callApi('/invitations/accept-existing', input, bearer);
      if (!res.ok) return passError(res, json);
      return NextResponse.json(json);
    }
    case 'switch': {
      if (!bearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      if (shopTenantId && (input as { tenantId?: unknown }).tenantId !== shopTenantId) {
        return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Choose another business on the main address' } }, { status: 403 });
      }
      const { res, json } = await callApi('/auth/switch-tenant', input, bearer);
      if (!res.ok) return passError(res, json);
      const tokens = json as { accessToken: string; accessTokenExpiresAt: string };
      const redirect = await ownAddress(tokens.accessToken, shopTenantId);
      const reply = NextResponse.json({ activeTenantId: (input as { tenantId: string }).tenantId, ...(redirect ? { redirect } : {}) });
      writeAuthCookies(reply, tokens, (input as { tenantId: string }).tenantId);
      return reply;
    }
    // The other end of `ownAddress` (session 41): on a shop's address only, for that business only.
    case 'handoff': {
      const code = (input as { code?: unknown }).code;
      if (!shopTenantId) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Unknown action' } }, { status: 404 });
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(code)) {
        return NextResponse.json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Sign in again' } }, { status: 401 });
      }
      const { res, json } = await callApi('/auth/refresh', { refreshToken: code, tenantId: shopTenantId });
      if (!res.ok) return passError(res, json);
      const body = json as { activeTenantId: string | null; tokens: TokenSet };
      const reply = NextResponse.json({ activeTenantId: body.activeTenantId });
      writeAuthCookies(reply, body.tokens, body.activeTenantId);
      return reply;
    }
    // Tilvara staff (ADR-0016 slice 6): view a business under its support grant, read-only.
    case 'support-open': {
      const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
      const grantId = String((input as { grantId?: string }).grantId ?? '');
      if (!refresh) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first' } }, { status: 401 });
      const o = await openSupport(API_URL, refresh, grantId, visitor());
      if (!o.refreshed) {
        const reply = NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again' } }, { status: 401 });
        clearAuthCookies(reply);
        return reply;
      }
      if (!o.support) {
        const reply = NextResponse.json(o.error ?? { error: { code: 'ERROR', message: 'Request failed' } }, { status: o.status || 502 });
        writeAuthCookies(reply, o.refreshed, null);
        reply.cookies.delete(SUPPORT_COOKIE);
        return reply;
      }
      const reply = NextResponse.json({ ok: true });
      writeSupportCookies(reply, o.refreshed, o.support, grantId);
      return reply;
    }
    case 'support-leave': {
      const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
      const reply = NextResponse.json({ ok: true });
      reply.cookies.delete(SUPPORT_COOKIE);
      if (!refresh) {
        clearAuthCookies(reply);
        return reply;
      }
      const { res, json } = await callApi('/auth/refresh', { refreshToken: refresh });
      if (!res.ok) clearAuthCookies(reply);
      else writeAuthCookies(reply, (json as { tokens: TokenSet }).tokens, null);
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
