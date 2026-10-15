/** Server-only configuration (imported only by route handlers, proxy and server components). */
export const API_URL = process.env.ONEPOS_API_URL ?? 'http://127.0.0.1:4320/v1';
export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
