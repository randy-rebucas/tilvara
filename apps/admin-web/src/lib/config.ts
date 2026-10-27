/** Server-only configuration (imported only by route handlers, proxy and server components). */
export const API_URL = process.env.ONEPOS_API_URL ?? 'http://127.0.0.1:4320/v1';
export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
/** Where the till (POS in a browser) is served, for "open the till" links; unset until hosting (D1) decides it. */
export const POS_URL = /^https?:\/\//.test(process.env.ONEPOS_POS_URL ?? '') ? process.env.ONEPOS_POS_URL! : null;
/** Where an owner writes to renew or subscribe until online billing exists (D6); unset: the notices name Tilvara support only. */
export const SUPPORT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ONEPOS_SUPPORT_EMAIL ?? '') ? process.env.ONEPOS_SUPPORT_EMAIL! : null;
