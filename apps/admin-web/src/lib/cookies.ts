/** Cookie names shared by proxy.ts (edge) and route handlers. Tokens are httpOnly; JS never sees them. */
export const ACCESS_COOKIE = 'onepos_at';
export const ACCESS_EXP_COOKIE = 'onepos_at_exp';
export const REFRESH_COOKIE = 'onepos_rt';
export const TENANT_COOKIE = 'onepos_tid';
export const LANG_COOKIE = 'onepos_lang';

/** Header every mutating browser request must carry; a cross-site form cannot set it (CSRF defense with SameSite=Lax). */
export const CSRF_HEADER = 'x-onepos-request';
