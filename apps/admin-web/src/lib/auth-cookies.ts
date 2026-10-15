import type { NextResponse } from 'next/server';
import { SECURE_COOKIES } from './config';
import { ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, TENANT_COOKIE } from './cookies';

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
  for (const name of [ACCESS_COOKIE, ACCESS_EXP_COOKIE, REFRESH_COOKIE, TENANT_COOKIE]) res.cookies.delete(name);
}
