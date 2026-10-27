import type { WorkerEnv } from '@1pos/config';
import type { Logger, OutboxHandler } from './outbox-processor.js';

/**
 * Closing a subscription payment page at the provider (ADR-0027, audit 45 #3). When a bill is voided or paid, the
 * billing functions mark its other open pages EXPIRED and emit `billing.checkout_expired` (ids only); the worker
 * then expires each session at the provider, so the owner cannot pay a bill that no longer stands (the money would
 * land UNAPPLIED). Failures throw and the outbox retries; a page the provider has already closed counts as done.
 */
export interface CheckoutExpirer {
  /** EXPIRED now, ALREADY_CLOSED before, or NOTHING_TO_DO (not a provider page); throws to be retried. */
  expire(provider: string, providerCheckoutId: string): Promise<'EXPIRED' | 'ALREADY_CLOSED' | 'NOTHING_TO_DO'>;
}

/** PayMongo Checkout API: `POST /v1/checkout_sessions/{id}/expire` with the secret key (Basic auth). */
export class PayMongoCheckoutExpirer implements CheckoutExpirer {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.paymongo.com/v1',
    private readonly timeoutMs = 10_000,
  ) {}

  async expire(provider: string, providerCheckoutId: string) {
    // The dev simulator's pages ask the database whether they are still open; nothing to call.
    if (provider !== 'PAYMONGO') return 'NOTHING_TO_DO' as const;
    if (!/^cs_[A-Za-z0-9]+$/.test(providerCheckoutId)) throw new Error('not a PayMongo checkout session id');
    const res = await this.fetchFn(`${this.baseUrl}/checkout_sessions/${providerCheckoutId}/expire`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`, accept: 'application/json' },
    });
    if (res.ok) return 'EXPIRED' as const;
    // Already expired or paid, or unknown to PayMongo: nothing left to close. A wrong key (401/403) or a provider
    // error (429, 5xx) is retried, and ends DEAD (alerted) if it never works.
    if ([400, 404, 409, 422].includes(res.status)) return 'ALREADY_CLOSED' as const;
    throw new Error(`PayMongo answered ${res.status} to expiring a checkout session`);
  }
}

/** BILLING_PROVIDER=dev: the simulator's page reads the checkout's status from the database (API), so nothing to call. */
export class DevCheckoutExpirer implements CheckoutExpirer {
  readonly expired: string[] = [];
  async expire(_provider: string, providerCheckoutId: string) {
    this.expired.push(providerCheckoutId);
    return 'NOTHING_TO_DO' as const;
  }
}

export function checkoutExpirerFor(env: Pick<WorkerEnv, 'BILLING_PROVIDER' | 'PAYMONGO_SECRET_KEY'>): CheckoutExpirer {
  return env.BILLING_PROVIDER === 'paymongo' ? new PayMongoCheckoutExpirer(env.PAYMONGO_SECRET_KEY!) : new DevCheckoutExpirer();
}

/** The outbox handler for `billing.checkout_expired`: no database read, the payload carries the provider's id. */
export function checkoutExpiredHandler(expirer: CheckoutExpirer, logger?: Logger): OutboxHandler {
  return async (event) => {
    const provider = String(event.payload.provider ?? '');
    const id = String(event.payload.providerCheckoutId ?? '');
    if (!provider || !id) return; // nothing to close (malformed: acknowledged, never retried forever)
    const outcome = await expirer.expire(provider, id);
    if (outcome !== 'NOTHING_TO_DO') logger?.info('billing checkout closed at the provider', { checkoutId: String(event.payload.checkoutId ?? ''), outcome });
  };
}
