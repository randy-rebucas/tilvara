import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  fetchImpl?: typeof fetch;
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
  private readonly fetch: typeof fetch;

  constructor(private readonly o: WebhookDispatcherOptions) {
    this.batch = o.batchSize ?? 20;
    this.lease = o.leaseSeconds ?? Math.ceil(o.timeoutMs / 1000) * 3 + 30;
    this.delay = o.retryDelaySeconds ?? webhookRetryDelay;
    this.fetch = o.fetchImpl ?? fetch;
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
      await this.assertReachable(d.url);
      const body = JSON.stringify({ id: d.id, type: d.topic, createdAt: new Date(d.created_at).toISOString(), data: d.payload });
      const secret = webhookSecret(this.o.signingKey, d.endpoint_id, d.signing_salt);
      const res = await this.fetch(d.url, {
        method: 'POST',
        // Never follow a redirect: it could point anywhere, including inside the network.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Tilvara-Webhooks/1',
          'tilvara-event': d.topic,
          'tilvara-delivery': d.id,
          'tilvara-signature': signatureHeader(secret, Math.floor(Date.now() / 1000), body),
        },
        body,
      });
      // The receiver's answer is not read beyond its status (it could be large or hostile).
      await res.body?.cancel().catch(() => undefined);
      return res.status >= 200 && res.status < 300 ? { ok: true, code: res.status, error: null } : { ok: false, code: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      return { ok: false, code: null, error: err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code ?? err.message).slice(0, 200) };
    }
  }

  /** https on a public address (checked on the resolved IP, every time), unless insecure is allowed. */
  private async assertReachable(url: string) {
    if (this.o.allowInsecure) return;
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('not https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw new Error('address not public');
  }
}
