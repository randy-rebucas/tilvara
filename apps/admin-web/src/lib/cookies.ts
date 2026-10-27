import { SECURE_COOKIES } from './config';

/**
 * Over https the session cookies are `__Host-` (session 40): the browser takes them only from this exact
 * host, with no Domain, so no other subdomain (another shop's own address) can set or replace them.
 * Plain names over http (development), where browsers refuse the prefix.
 */
const HOST = SECURE_COOKIES ? '__Host-' : '';

/** Cookie names shared by proxy.ts (edge) and route handlers. Tokens are httpOnly; JS never sees them. */
export const ACCESS_COOKIE = `${HOST}onepos_at`;
export const ACCESS_EXP_COOKIE = `${HOST}onepos_at_exp`;
export const REFRESH_COOKIE = `${HOST}onepos_rt`;
export const TENANT_COOKIE = `${HOST}onepos_tid`;
export const LANG_COOKIE = 'onepos_lang';
/**
 * The 5-minute second-step challenge after a correct password (ADR-0016); httpOnly, auth routes only.
 * Scoped to /api/auth, so `__Secure-` rather than `__Host-` (which requires Path=/).
 */
export const MFA_COOKIE = `${SECURE_COOKIES ? '__Secure-' : ''}onepos_mfa`;
/** The support grant a Tilvara staff member is viewing a business under (ADR-0016 slice 6); httpOnly. */
export const SUPPORT_COOKIE = `${HOST}onepos_sup`;

/** Header every mutating browser request must carry; a cross-site form cannot set it (CSRF defense with SameSite=Lax). */
export const CSRF_HEADER = 'x-onepos-request';
