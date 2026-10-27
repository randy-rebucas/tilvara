import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound webhooks (session 20, ADR-0019): what is signed and how, shared by the API (which shows an
 * endpoint's secret once) and the worker (which signs every delivery). Nothing secret is stored: an
 * endpoint's secret is derived from the server key, its id and a salt that rotating replaces.
 */

/** Topics a business may subscribe to: thin events carrying ids only (the receiver reads details with an API key). */
export const WEBHOOK_TOPICS = [
  'sale.completed', 'sale.returned', 'sale.voided', 'stock.low', 'stock.below_zero',
] as const;
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

/** IPv4 ranges a webhook may never reach (RFC 6890 special-purpose, private, documentation, multicast and above). */
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3], // 224/4 multicast and 240/4 reserved, incl. 255.255.255.255
] as const) BLOCKED_V4.addSubnet(net, prefix, 'ipv4');

/** IPv6 ranges refused outright (unspecified and loopback are checked as values; Teredo hides its client address). */
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32],
] as const) BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

/** Parses an IPv4 dotted quad into 4 bytes, or null. Only plain decimal (net.isIPv4 rules). */
function v4Bytes(s: string): number[] | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').map(Number);
}

/** Expands an IPv6 literal (any form: `::`, an embedded dotted quad, a zone id) into 16 bytes, or null. */
function v6Bytes(input: string): number[] | null {
  let s = input.split('%')[0]!.toLowerCase();
  if (isIP(s) !== 6) return null;
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const q = v4Bytes(last);
    if (!q) return null;
    s = `${s.slice(0, lastColon + 1)}${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const l = halves[0] ? halves[0].split(':') : [];
  const r = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - l.length - r.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...l, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...r];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

/** The IPv4 address an IPv6 address carries and would be routed to, if it is one of the translation forms. */
function embeddedV4(b: number[]): number[] | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:0:0/96 (mapped) and ::/96 (IPv4-compatible, deprecated)
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return b.slice(12, 16);
  // ::ffff:0:0:0/96 (SIIT translated)
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return b.slice(12, 16);
  // 64:ff9b::/96 (NAT64 well-known)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12, 16);
  // 64:ff9b:1::/48 (NAT64 local use): the IPv4 address may sit at any RFC 6052 position; refuse the whole prefix
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return [0, 0, 0, 0];
  // 2002::/16 (6to4): IPv4 in bits 16-48
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

/**
 * Whether an address may receive webhooks: never loopback, private, link-local, CGNAT, multicast,
 * documentation, benchmarking or unspecified (no server-side request forgery into the hosting
 * network), whatever form the address is written in. An IPv6 address that carries an IPv4 one
 * (mapped, compatible, NAT64, 6to4) is judged by that IPv4 address; Teredo is refused. Anything that
 * does not parse is refused. The callers skip this when insecure is allowed.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = v4Bytes(ip);
  if (v4) return !BLOCKED_V4.check(v4.join('.'), 'ipv4');
  const b = v6Bytes(ip);
  if (!b) return false;
  const inner = embeddedV4(b);
  if (inner) return !BLOCKED_V4.check(inner.join('.'), 'ipv4');
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return false; // :: and ::1
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return !BLOCKED_V6.check(groups.join(':'), 'ipv6');
}
