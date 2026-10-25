import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { and, desc, eq, inArray, paymentEvents, paymentIntents, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CreatePaymentIntentInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { ApiMetrics } from '../infrastructure/metrics.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { loadSession } from '../sales/cash.service.js';
import { PaymentProvider, type AuthorizeResult, type RetrieveResult } from './provider.js';

type IntentRow = typeof paymentIntents.$inferSelect;
type Outcome = AuthorizeResult | { status: 'UNKNOWN' };

const conflict = (code: string, message: string) => new AppError(code, message, HttpStatus.CONFLICT);

/**
 * Non-cash payments (ADR-0010): commit the intent, call the provider outside any transaction,
 * record the outcome. Timeouts become UNKNOWN and are reconciled, never re-authorized.
 */
@Injectable()
export class PaymentsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    payment_intents_request_key_unique: ['PAYMENT_IN_PROGRESS', 'A payment with this Idempotency-Key is already being processed'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {
    super(tenantDb);
  }

  private count(step: 'authorize' | 'reconcile', outcome: Outcome): void {
    this.metrics.payments.inc({ provider: this.provider.name, step, outcome: outcome.status.toLowerCase() });
  }

  async create(auth: AuthContext, input: CreatePaymentIntentInput, requestKey: string) {
    const { intent, fresh } = await this.mutate(auth, async (db) => {
      const [existing] = await db.select().from(paymentIntents).where(eq(paymentIntents.requestKey, requestKey));
      if (existing) {
        const same =
          existing.cashierSessionId === input.cashierSessionId &&
          existing.clientTransactionId === input.clientTransactionId &&
          existing.method === input.method &&
          toDec(existing.amount).equals(input.amount) &&
          existing.purpose === input.purpose &&
          existing.createdBy === auth.userId;
        if (!same) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different payment', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        return { intent: existing, fresh: false };
      }
      const { session, scope } = await loadSession(db, input.cashierSessionId, true);
      this.assertCan(auth, 'sales.create', scope);
      if (session.status !== 'OPEN') throw conflict('SESSION_NOT_OPEN', 'This cashier session is not open');
      if (session.openedBy !== auth.userId) throw new AppError('NOT_SESSION_OWNER', 'Take payments on your own cashier session', HttpStatus.FORBIDDEN);
      const [row] = await db
        .insert(paymentIntents)
        .values({
          tenantId: tenantOf(auth).tenantId,
          branchId: session.branchId,
          registerId: session.registerId,
          cashierSessionId: session.id,
          clientTransactionId: input.clientTransactionId,
          purpose: input.purpose,
          requestKey,
          provider: this.provider.name,
          method: input.method,
          amount: input.amount,
          currency: session.currency,
          createdBy: auth.userId,
        })
        .returning();
      await this.event(db, auth, row!.id, 'AUTHORIZE_REQUESTED', { amount: input.amount, method: input.method });
      await this.audit(db, auth, 'payment.requested', 'payment_intent', row!.id, { amount: input.amount, method: input.method });
      return { intent: row!, fresh: true };
    });
    if (!fresh) return this.view(intent);

    // Outside any transaction: the provider call may be slow or never answer.
    let outcome: Outcome;
    try {
      outcome = await this.provider.authorize(
        { intentId: intent.id, amount: toDec(intent.amount).toFixed(2), currency: intent.currency, method: intent.method as 'CARD' },
        AbortSignal.timeout(this.env.PAYMENT_TIMEOUT_MS),
      );
    } catch {
      // Timeout or transport failure: the provider may or may not have charged. Never guess.
      outcome = { status: 'UNKNOWN' };
    }
    this.count('authorize', outcome);
    return this.settle(auth, intent.id, ['PROCESSING'], outcome, outcome.status === 'UNKNOWN' ? 'TIMEOUT' : outcome.status === 'SUCCEEDED' ? 'AUTHORIZED' : 'DECLINED');
  }

  /** Ask the provider what happened to an UNKNOWN (or stale PROCESSING) intent. */
  async reconcile(auth: AuthContext, id: string) {
    const intent = await this.read(auth, async (db) => {
      const row = await this.load(db, auth, id, 'operate');
      return row;
    });
    if (intent.status === 'SUCCEEDED' || intent.status === 'FAILED' || intent.status === 'CANCELED') return this.view(intent);
    if (intent.status === 'PROCESSING' && Date.now() - intent.createdAt.getTime() < this.env.PAYMENT_TIMEOUT_MS * 2) {
      throw conflict('PAYMENT_STILL_PROCESSING', 'The provider has not answered yet; try again shortly');
    }
    const found: RetrieveResult = await this.provider.retrieve(intent.id);
    const outcome: Outcome = found.status === 'NOT_FOUND' ? { status: 'FAILED', failureCode: 'not_received_by_provider' } : found;
    this.count('reconcile', outcome);
    return this.settle(auth, id, ['PROCESSING', 'UNKNOWN'], outcome, 'RECONCILED');
  }

  /** Void an authorized payment the sale will not use (e.g. the customer changed their mind). */
  async cancel(auth: AuthContext, id: string) {
    const intent = await this.mutate(auth, async (db) => {
      const row = await this.load(db, auth, id, 'operate');
      if (row.saleId) throw conflict('PAYMENT_CONSUMED', 'This payment is part of a completed sale; refund the sale instead');
      // A payment of a purpose no longer offered (a laundry down payment before 0110, a folio payment before 0111) was settled by its own document.
      if (!(['SALE', 'TIP'] as string[]).includes(row.purpose)) throw conflict('PAYMENT_CONSUMED', 'This payment was settled by a document of a feature no longer offered');
      if (row.status === 'PROCESSING' || row.status === 'UNKNOWN') throw conflict('RECONCILE_FIRST', 'Reconcile this payment before cancelling it');
      if (row.status === 'SUCCEEDED') await this.event(db, auth, id, 'CANCEL_REQUESTED', null);
      return row;
    });
    if (intent.status !== 'SUCCEEDED') return this.view(intent);
    const result = await this.provider.cancel(id);
    if (result.status !== 'CANCELED') throw conflict('CANCEL_FAILED', `The provider refused the cancellation (${result.failureCode})`);
    return this.tenantDb.run(auth, async (db) => {
      const [row] = await db
        .update(paymentIntents)
        .set({ status: 'CANCELED' })
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, 'SUCCEEDED')))
        .returning();
      if (row) {
        await this.event(db, auth, id, 'CANCELED', null);
        await this.audit(db, auth, 'payment.canceled', 'payment_intent', id);
      }
      return this.view(row ?? (await this.load(db, auth, id, 'read')));
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const intent = await this.load(db, auth, id, 'read');
      const events = await db.select().from(paymentEvents).where(eq(paymentEvents.paymentIntentId, id)).orderBy(paymentEvents.createdAt, paymentEvents.id);
      return { ...this.view(intent), events };
    });
  }

  list(auth: AuthContext, cashierSessionId: string) {
    return this.read(auth, async (db) => {
      const { session, scope } = await loadSession(db, cashierSessionId);
      if (session.openedBy !== auth.userId) this.assertCan(auth, 'sales.read', scope);
      const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.cashierSessionId, cashierSessionId)).orderBy(desc(paymentIntents.createdAt));
      return { data: rows.map((r) => this.view(r)) };
    });
  }

  /**
   * Record a provider outcome. Uses a plain tenant transaction (no subscription write check):
   * a charge that happened must be recorded whatever the tenant's billing state.
   */
  private settle(auth: AuthContext, id: string, from: IntentRow['status'][], outcome: Outcome, eventType: string) {
    return this.tenantDb.run(auth, async (db) => {
      const reference = 'reference' in outcome ? (outcome.reference ?? null) : null;
      const failureCode = outcome.status === 'FAILED' ? outcome.failureCode : null;
      const [row] = await db
        .update(paymentIntents)
        .set({ status: outcome.status, providerReference: reference, failureCode })
        .where(and(eq(paymentIntents.id, id), inArray(paymentIntents.status, from)))
        .returning();
      if (!row) {
        // Someone else settled it first (concurrent reconcile); report the current state.
        const [current] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, id));
        return this.view(current!);
      }
      await this.event(db, auth, id, eventType, { status: outcome.status, reference, failureCode });
      if (outcome.status !== 'UNKNOWN') await this.audit(db, auth, `payment.${outcome.status.toLowerCase()}`, 'payment_intent', id, { reference, failureCode });
      return this.view(row);
    });
  }

  private async load(db: Database, auth: AuthContext, id: string, mode: 'read' | 'operate') {
    const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, id));
    if (!row) throw notFound('Payment');
    const { scope } = await loadSession(db, row.cashierSessionId);
    if (this.can(auth, 'cash.reconcile', scope)) return row;
    if (mode === 'read' && this.can(auth, 'sales.read', scope)) return row;
    this.assertCan(auth, 'sales.create', scope);
    if (row.createdBy !== auth.userId) throw new AppError('NOT_SESSION_OWNER', 'This payment belongs to someone else', HttpStatus.FORBIDDEN);
    return row;
  }

  private async event(db: Database, auth: AuthContext, intentId: string, type: string, detail: Record<string, unknown> | null) {
    await db.insert(paymentEvents).values({ tenantId: tenantOf(auth).tenantId, paymentIntentId: intentId, type, detail, createdBy: auth.userId });
  }

  private view(r: IntentRow) {
    return { ...r, amount: toDec(r.amount).toFixed(2) };
  }
}
