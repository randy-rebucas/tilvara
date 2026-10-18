import type { NextResponse } from 'next/server';
import { SECURE_COOKIES } from './config';
import { ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, SUPPORT_COOKIE, TENANT_COOKIE } from './cookies';

export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

const base = { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'lax' as const, path: '/' };

/** Store tokens as httpOnly cookies on a response. The refresh token is scoped to the auth routes. */
export function writeAuthCookies(res: NextResponse, tokens: TokenSet, tenantId: string | null | undefined): void {
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, { ...base, expires: new Date(tokens.accessTokenExpiresAt) });
  res.cookies.set(ACCESS_EXP_COOKIE, String(new Date(tokens.accessTokenExpiresAt).getTime()), {
    ...base,
    expires: tokens.refreshTokenExpiresAt ? new Date(tokens.refreshTokenExpiresAt) : undefined,
  });
  if (tokens.refreshToken && tokens.refreshTokenExpiresAt) {
    res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, { ...base, expires: new Date(tokens.refreshTokenExpiresAt) });
  }
  if (tenantId !== undefined) {
    if (tenantId) res.cookies.set(TENANT_COOKIE, tenantId, { ...base, maxAge: 60 * 60 * 24 * 90 });
    else res.cookies.delete(TENANT_COOKIE);
  }
}

export function clearAuthCookies(res: NextResponse): void {
  for (const name of [ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, TENANT_COOKIE, SUPPORT_COOKIE]) res.cookies.delete(name);
}

/** A support session (ADR-0016 slice 6): the support token replaces the access token; no business cookie. */
export function writeSupportCookies(res: NextResponse, refreshed: TokenSet, support: { accessToken: string; accessTokenExpiresAt: string }, grantId: string): void {
  writeAuthCookies(res, { ...refreshed, accessToken: support.accessToken, accessTokenExpiresAt: support.accessTokenExpiresAt }, null);
  res.cookies.set(SUPPORT_COOKIE, grantId, { ...base, expires: refreshed.refreshTokenExpiresAt ? new Date(refreshed.refreshTokenExpiresAt) : undefined });
}

/**
 * Turn a refresh token into a staff member's support token for a grant: a plain token first (the
 * open call refuses a support token), then the grant. `support` is null when the grant is refused.
 */
export async function openSupport(apiUrl: string, refreshToken: string, grantId: string) {
  const r = await fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  }).catch(() => null);
  if (!r?.ok) return { refreshed: null, support: null, status: r?.status ?? 0, error: null };
  const refreshed = ((await r.json()) as { tokens: TokenSet }).tokens;
  const o = await fetch(`${apiUrl}/support/grants/${encodeURIComponent(grantId)}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${refreshed.accessToken}` },
    body: '{}',
    cache: 'no-store',
  }).catch(() => null);
  const json: unknown = o ? await o.json().catch(() => null) : null;
  const support = o?.ok ? (json as { accessToken: string; accessTokenExpiresAt: string }) : null;
  return { refreshed, support, status: o?.status ?? 0, error: o?.ok ? null : json };
}
