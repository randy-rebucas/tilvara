/**
 * Who the API should count a call for (session 40). This server calls the API for every visitor of every
 * business, so without these the API's per-IP limits would see one address for all of them. The visitor's
 * address goes in `x-onepos-client-ip` with the shared secret `ONEPOS_BFF_SECRET` (the API's
 * `BFF_SHARED_SECRET`); the API believes it only with that secret. Server-only: never import in a client component.
 */
const SECRET = process.env.ONEPOS_BFF_SECRET && process.env.ONEPOS_BFF_SECRET.length >= 32 ? process.env.ONEPOS_BFF_SECRET : null;

/**
 * Proxies in front of this server that append to X-Forwarded-For (a load balancer: 1). With none, Next
 * sets the header to the socket's address only when the browser sent none, so 0 is for development only.
 */
const HOPS = Math.min(5, Math.max(0, Number.parseInt(process.env.ONEPOS_TRUST_PROXY_HOPS ?? '0', 10) || 0));

/** The visitor's address from X-Forwarded-For: the entry the nearest trusted proxy (or Next itself) wrote. */
export function visitorIp(forwardedFor: string | null, hops = HOPS): string | null {
  const chain = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - Math.max(1, hops)] ?? null;
}

/** Headers for a server-side call to the API on behalf of the request that has these headers. */
export function visitorHeaders(h: Pick<Headers, 'get'>): Record<string, string> {
  const out: Record<string, string> = {};
  const ua = h.get('user-agent');
  if (ua) out['user-agent'] = ua.slice(0, 512);
  const ip = SECRET ? visitorIp(h.get('x-forwarded-for')) : null;
  if (SECRET && ip) {
    out['x-onepos-bff'] = SECRET;
    out['x-onepos-client-ip'] = ip;
  }
  return out;
}
