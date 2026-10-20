import { lookup } from 'node:dns/promises';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress, signatureHeader, webhookRetryDelay, webhookSecret } from '@1pos/database';
import { withLogContext } from '@1pos/observability';
import type { Pool } from 'pg';
import type { Logger } from './outbox-processor.js';

export interface WebhookDispatcherOptions {
  pool: Pool;
  workerId: string;
  /** Same key as the API's (WEBHOOK_SIGNING_KEY): an endpoint's secret is derived from it. */
  signingKey: string;
  /** Development and tests only: http and private addresses (production refuses the setting). */
  allowInsecure: boolean;
  timeoutMs: number;
  batchSize?: number;
  leaseSeconds?: number;
  logger: Logger;
  /** Override for tests. */
  retryDelaySeconds?: (attempt: number) => number;
  /** Override for tests: resolves a host name to its addresses. */
  resolve?: (host: string) => Promise<string[]>;
}

export interface DispatchResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

/**
 * Sends webhook deliveries (session 20, ADR-0019), outside any database transaction: claim a batch
 * (a lease, like the outbox), POST each signed body, then settle it. 2xx = delivered; anything else, a
 * timeout or a refused address = failed, retried with backoff, DEAD after the last attempt. A
 * receiver must treat `Tilvara-Delivery` as the idempotency key: a delivery may arrive twice.
 */
export class WebhookDispatcher {
  private readonly batch: number;
  private readonly lease: number;
  private readonly delay: (attempt: number) => number;
  private readonly resolve: (host: string) => Promise<string[]>;

  constructor(private readonly o: WebhookDispatcherOptions) {
    this.batch = o.batchSize ?? 20;
    this.lease = o.leaseSeconds ?? Math.ceil(o.timeoutMs / 1000) * 3 + 30;
    this.delay = o.retryDelaySeconds ?? webhookRetryDelay;
    this.resolve = o.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address));
  }

  async runOnce(): Promise<DispatchResult> {
    const { rows } = await this.o.pool.query<{
      id: string; tenant_id: string; endpoint_id: string; topic: string; payload: Record<string, unknown>; attempts: number; url: string; signing_salt: string; created_at: Date;
    }>('SELECT * FROM webhook_claim($1, $2, $3)', [this.o.workerId, this.batch, this.lease]);
    const result: DispatchResult = { claimed: rows.length, delivered: 0, retried: 0, dead: 0 };
    for (const d of rows) {
      await withLogContext({ tenantId: d.tenant_id }, async () => {
        const { ok, code, error } = await this.send(d);
        const { rows: s } = await this.o.pool.query<{ status: string | null }>('SELECT webhook_settle($1, $2, $3, $4, $5, $6) AS status', [
          d.id, this.o.workerId, ok, code, error, this.delay(d.attempts),
        ]);
        const status = s[0]?.status;
        if (status === 'DELIVERED') result.delivered++;
        else if (status === 'DEAD') {
          result.dead++;
          this.o.logger.error('webhook delivery dead', { deliveryId: d.id, endpointId: d.endpoint_id, attempts: d.attempts, code });
        } else if (status === 'PENDING') result.retried++;
      });
    }
    return result;
  }

  private async send(d: { id: string; topic: string; payload: Record<string, unknown>; url: string; signing_salt: string; endpoint_id: string; created_at: Date }) {
    try {
      const address = await this.checkedAddress(d.url);
      const body = JSON.stringify({ id: d.id, type: d.topic, createdAt: new Date(d.created_at).toISOString(), data: d.payload });
      const secret = webhookSecret(this.o.signingKey, d.endpoint_id, d.signing_salt);
      const status = await postPinned(d.url, address, this.o.timeoutMs, {
        'content-type': 'application/json',
        'user-agent': 'Tilvara-Webhooks/1',
        'tilvara-event': d.topic,
        'tilvara-delivery': d.id,
        'tilvara-signature': signatureHeader(secret, Math.floor(Date.now() / 1000), body),
      }, body);
      return status >= 200 && status < 300 ? { ok: true, code: status, error: null } : { ok: false, code: status, error: `HTTP ${status}` };
    } catch (e) {
      const err = e as Error & { code?: string };
      return { ok: false, code: null, error: err.name === 'TimeoutError' ? 'timed out' : (err.code ?? err.message).slice(0, 200) };
    }
  }

  /**
   * https on a public address, unless insecure is allowed: the host is resolved once and every
   * address checked; the connection is then made to the first checked address (null: insecure, let
   * the system resolve). Resolving again at connect time would let a DNS answer that changed in
   * between (rebinding) reach a private address.
   */
  private async checkedAddress(url: string): Promise<string | null> {
    if (this.o.allowInsecure) return null;
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('not https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await this.resolve(host);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw new Error('address not public');
    return addresses[0]!;
  }
}

/**
 * POSTs `body` and answers the status only. With an `address`, the socket connects to it whatever
 * the host resolves to now; TLS still checks the certificate against the URL's host name (SNI and
 * verification use the name, not the address). A redirect is never followed (it could point inside
 * the network), and the answer is not read beyond its status (it could be large or hostile).
 */
export function postPinned(url: string, address: string | null, timeoutMs: number, headers: OutgoingHttpHeaders, body: string): Promise<number> {
  const u = new URL(url);
  const pinned: LookupFunction | undefined = address
    ? (_host, options, callback) => {
        const family = isIP(address);
        if (options.all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
        else callback(null, address, family);
      }
    : undefined;
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      ...(pinned && { lookup: pinned }),
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve(status);
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}
