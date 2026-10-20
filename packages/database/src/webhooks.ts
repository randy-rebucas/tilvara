import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhooks (session 20, ADR-0019): what is signed and how, shared by the API (which shows an
 * endpoint's secret once) and the worker (which signs every delivery). Nothing secret is stored: an
 * endpoint's secret is derived from the server key, its id and a salt that rotating replaces.
 */

/** Topics a business may subscribe to: thin events carrying ids only (the receiver reads details with an API key). */
export const WEBHOOK_TOPICS = ['sale.completed', 'sale.returned', 'sale.voided', 'stock.low', 'stock.below_zero'] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];
/** The test event a manager can send from the back office. */
export const WEBHOOK_PING = 'webhook.ping';

export const newSigningSalt = () => randomBytes(18).toString('base64url');

/** An endpoint's signing secret: `whsec_` + HMAC-SHA256(server key, "<endpoint id>:<salt>"). */
export function webhookSecret(signingKey: string, endpointId: string, salt: string): string {
  return `whsec_${createHmac('sha256', signingKey).update(`${endpointId}:${salt}`).digest('base64url')}`;
}

/** `Tilvara-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (body as sent, byte for byte). */
export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** What a receiver does (and our tests do): recompute and compare, and refuse a stale timestamp. */
export function verifySignature(secret: string, header: string, body: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signatureHeader(secret, t, body).split('v1=')[1]!, 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Retry pause after the n-th failed attempt: 30 s, 1 min, 2 min … capped at 6 h (8 attempts ≈ a day), ±20 %. */
export function webhookRetryDelay(attempt: number): number {
  const base = Math.min(6 * 3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Whether an address may receive webhooks: never loopback, private, link-local, CGNAT, multicast or
 * unspecified (no server-side request forgery into the hosting network), unless insecure is allowed.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return false;
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff')) return false;
  return true;
}
