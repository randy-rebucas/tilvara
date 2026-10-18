/** Cookie names shared by proxy.ts (edge) and route handlers. Tokens are httpOnly; JS never sees them. */
export const ACCESS_COOKIE = 'onepos_at';
export const ACCESS_EXP_COOKIE = 'onepos_at_exp';
export const REFRESH_COOKIE = 'onepos_rt';
export const TENANT_COOKIE = 'onepos_tid';
export const LANG_COOKIE = 'onepos_lang';
/** The 5-minute second-step challenge after a correct password (ADR-0016); httpOnly, auth routes only. */
export const MFA_COOKIE = 'onepos_mfa';
/** The support grant a Tilvara staff member is viewing a business under (ADR-0016 slice 6); httpOnly. */
export const SUPPORT_COOKIE = 'onepos_sup';

/** Header every mutating browser request must carry; a cross-site form cannot set it (CSRF defense with SameSite=Lax). */
export const CSRF_HEADER = 'x-onepos-request';
