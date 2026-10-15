import { Injectable } from '@nestjs/common';

/** Port for non-cash payment providers (ADR-0010). Never called inside a database transaction. */
export interface AuthorizeRequest {
  /** 1POS intent id — the provider-side idempotency key. */
  intentId: string;
  amount: string;
  currency: string;
  method: 'CARD' | 'QR' | 'EWALLET';
}

export type AuthorizeResult = { status: 'SUCCEEDED'; reference: string } | { status: 'FAILED'; failureCode: string; reference?: string };
export type RetrieveResult = AuthorizeResult | { status: 'NOT_FOUND' };
export type CancelResult = { status: 'CANCELED' } | { status: 'FAILED'; failureCode: string };

export abstract class PaymentProvider {
  abstract readonly name: string;
  /** Rejects with an AbortError when `signal` fires (timeout); the outcome is then unknown. */
  abstract authorize(req: AuthorizeRequest, signal: AbortSignal): Promise<AuthorizeResult>;
  abstract retrieve(intentId: string): Promise<RetrieveResult>;
  abstract cancel(intentId: string): Promise<CancelResult>;
}

/**
 * Deterministic simulator for development and tests — refused in production by @1pos/config.
 * Outcome by the centavo part of the amount: .51 declined; .52 accepted but the response is lost
 * (timeout, retrieve → SUCCEEDED); .53 never received (timeout, retrieve → NOT_FOUND); else approved.
 * Authorizing the same intent twice never charges twice.
 */
@Injectable()
export class DevPaymentProvider extends PaymentProvider {
  readonly name = 'dev';
  private readonly charges = new Map<string, { status: 'SUCCEEDED' | 'FAILED' | 'CANCELED'; reference: string; failureCode?: string; count: number }>();

  /** How many times the provider actually charged this intent (tests assert ≤ 1). */
  chargeCount(intentId: string): number {
    return this.charges.get(intentId)?.count ?? 0;
  }

  async authorize(req: AuthorizeRequest, signal: AbortSignal): Promise<AuthorizeResult> {
    const existing = this.charges.get(req.intentId);
    if (existing && existing.status !== 'CANCELED') return this.result(existing);
    const cents = req.amount.split('.')[1]?.padEnd(2, '0').slice(0, 2);
    const reference = `dev_${req.intentId.slice(-12)}`;
    if (cents === '53') return this.hang(signal);
    if (cents === '51') {
      this.charges.set(req.intentId, { status: 'FAILED', reference, failureCode: 'card_declined', count: 0 });
      return { status: 'FAILED', failureCode: 'card_declined', reference };
    }
    this.charges.set(req.intentId, { status: 'SUCCEEDED', reference, count: 1 });
    if (cents === '52') return this.hang(signal);
    return { status: 'SUCCEEDED', reference };
  }

  async retrieve(intentId: string): Promise<RetrieveResult> {
    const c = this.charges.get(intentId);
    if (!c) return { status: 'NOT_FOUND' };
    if (c.status === 'CANCELED') return { status: 'FAILED', failureCode: 'canceled', reference: c.reference };
    return this.result(c);
  }

  async cancel(intentId: string): Promise<CancelResult> {
    const c = this.charges.get(intentId);
    if (!c || c.status !== 'SUCCEEDED') return { status: 'FAILED', failureCode: 'not_cancelable' };
    c.status = 'CANCELED';
    return { status: 'CANCELED' };
  }

  private result(c: { status: string; reference: string; failureCode?: string }): AuthorizeResult {
    return c.status === 'SUCCEEDED' ? { status: 'SUCCEEDED', reference: c.reference } : { status: 'FAILED', failureCode: c.failureCode ?? 'failed', reference: c.reference };
  }

  private hang(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('provider timeout'), { name: 'AbortError' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}
