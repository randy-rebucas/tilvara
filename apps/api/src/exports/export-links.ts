import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface ExportLinkClaims {
  /** export id */
  e: string;
  /** tenant id */
  t: string;
  /** user the link was issued to (audited on download) */
  u: string;
  /** expiry, epoch seconds */
  x: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Short-lived signed download links for data exports (ADR-0016 slice 6), the dev counterpart of an
 * object store's pre-signed URL. HMAC-SHA256 under a key derived from JWT_ACCESS_SECRET for this use
 * only (HKDF), so no extra secret is needed and an access token can never pass for a link.
 */
export class ExportLinks {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'onepos-data-export-link-v1', 32));
  }

  sign(claims: ExportLinkClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** The claims of a genuine, unexpired link; null for anything else. */
  verify(token: string, nowMs = Date.now()): ExportLinkClaims | null {
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined || body.length > 400) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let c: ExportLinkClaims;
    try {
      c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ExportLinkClaims;
    } catch {
      return null;
    }
    if (!UUID.test(String(c.e)) || !UUID.test(String(c.t)) || !UUID.test(String(c.u)) || typeof c.x !== 'number') return null;
    return c.x * 1000 > nowMs ? c : null;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
