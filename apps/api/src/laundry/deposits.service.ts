import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { downPaymentForfeitedPosting, downPaymentReceivedPosting, downPaymentRefundedPosting } from '@1pos/accounting';
import { cashMovements, desc, eq, jobOrderDeposits, jobOrderLines, paymentEvents, paymentIntents, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { JobDepositInput, RefundJobDepositInput } from '@1pos/validation';
import { post } from '../accounting/ledger.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLaundry } from '../billing/entitlements.js';
import { effectiveNow } from '../common/clock.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { frontDeskSession } from '../lodging/front-desk.js';
import { expectedCash } from '../sales/cash.service.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { depositsHeld, isOpen, jobEnded, jobScope, loadJob, lockJobDeposits, type JobRow } from './job.js';

type DepositRow = typeof jobOrderDeposits.$inferSelect;
const money = (v: string | null) => (v === null ? null : toDec(v).toFixed(2));
export const depositView = (d: DepositRow) => ({ ...d, amount: money(d.amount), netAmount: money(d.netAmount), vatAmount: money(d.vatAmount) });

export const DEPOSIT_CONFLICTS: ConflictMap = {
  job_order_deposits_balance: ['DEPOSIT_EXCEEDED', 'More than the down payment held'],
  job_order_deposits_exceed_total: ['DEPOSIT_EXCEEDS_TOTAL', 'A down payment cannot be more than the job order\'s total'],
  job_order_deposits_intent_once: ['PAYMENT_CONSUMED', 'This payment was already used'],
};

/**
 * Down payments on a laundry job order (ADR-0024 §5): taken in cash at a drawer, by card/QR (purpose
 * JOB_ORDER) or by bank transfer; held without VAT on *2330 Customer down payments* until the claim
 * applies them; refunded, or kept as income with its VAT when unclaimed laundry is disposed of. Every
 * row posts one journal entry (JOB_ORDER_DEPOSIT) in its transaction; cash goes through the drawer.
 */
@Injectable()
export class JobDepositsService extends TenantService {
  protected readonly conflicts: ConflictMap = DEPOSIT_CONFLICTS;

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {
    super(tenantDb);
  }

  list(auth: AuthContext, jobId: string) {
    return this.read(auth, async (db) => {
      const job = await loadJob(db, jobId);
      this.assertCan(auth, 'laundry.read', jobScope(job));
      const rows = await db.select().from(jobOrderDeposits).where(eq(jobOrderDeposits.jobOrderId, jobId)).orderBy(jobOrderDeposits.createdAt, jobOrderDeposits.id);
      return { data: rows.map(depositView), held: (await depositsHeld(db, jobId)).toFixed(2) };
    });
  }

  receive(auth: AuthContext, jobId: string, input: JobDepositInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, jobId, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      if (!isOpen(job.status)) throw jobEnded(job);
      if (toDec(job.amountDue).lte(0)) throw unprocessable('JOB_NOT_PRICED', 'Weigh and price the job order before taking a down payment');
      await lockJobDeposits(db, job.id);
      const tenantId = tenantOf(auth).tenantId;
      let amount: string;
      let method: string;
      let sessionId: string | null = null;
      let intentId: string | null = null;
      let reference: string | null = null;
      if (input.method === 'CASH') {
        sessionId = (await frontDeskSession(db, auth, input.cashierSessionId, job.legalEntityId, job.branchId)).session.id;
        amount = input.amount;
        method = 'CASH';
      } else if (input.method === 'INTENT') {
        sessionId = (await frontDeskSession(db, auth, input.cashierSessionId, job.legalEntityId, job.branchId)).session.id;
        const p = await this.consumeIntent(db, auth, { paymentIntentId: input.paymentIntentId, sessionId, jobId: job.id, currency: job.currency });
        amount = p.amount;
        method = p.method;
        intentId = p.id;
      } else {
        amount = input.amount;
        method = 'BANK_TRANSFER';
        reference = input.reference;
      }
      const held = await depositsHeld(db, job.id);
      if (held.plus(amount).gt(job.amountDue)) {
        throw new AppError('DEPOSIT_EXCEEDS_TOTAL', 'A down payment cannot be more than the job order\'s total', HttpStatus.CONFLICT, { total: toDec(job.amountDue).toFixed(2), held: held.toFixed(2) });
      }
      const [row] = await db
        .insert(jobOrderDeposits)
        .values({
          tenantId, jobOrderId: job.id, legalEntityId: job.legalEntityId, branchId: job.branchId, kind: 'RECEIVED', amount, method,
          cashierSessionId: method === 'CASH' ? sessionId : null, paymentIntentId: intentId, reference, createdBy: auth.userId,
        })
        .returning();
      if (method === 'CASH') {
        await db.insert(cashMovements).values({ tenantId, cashierSessionId: sessionId!, type: 'JOB_DEPOSIT', amount, jobOrderDepositId: row!.id, reason: 'Job order down payment', createdBy: auth.userId });
      }
      await post(db, {
        tenantId, legalEntityId: job.legalEntityId, branchId: job.branchId, sourceType: 'JOB_ORDER_DEPOSIT', sourceId: row!.id, memo: 'Job order down payment received',
        lines: downPaymentReceivedPosting(amount, method === 'CASH' ? 'CASH' : method === 'BANK_TRANSFER' ? 'BANK' : 'ELECTRONIC', job.branchId),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'job_order.deposit_received', 'job_order', job.id, { jobOrderDepositId: row!.id, amount: toDec(amount).toFixed(2), method });
      return { ...depositView(row!), held: (await depositsHeld(db, job.id)).toFixed(2) };
    });
  }

  refund(auth: AuthContext, jobId: string, input: RefundJobDepositInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, jobId, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      await lockJobDeposits(db, job.id);
      const held = await depositsHeld(db, job.id);
      const amount = input.amount ? toDec(input.amount) : held;
      if (amount.lte(0) || amount.gt(held)) throw new AppError('DEPOSIT_EXCEEDED', 'More than the down payment held', HttpStatus.CONFLICT, { held: held.toFixed(2) });
      const row = await this.refundHeld(db, auth, job, { refund: input.refund, reason: input.reason, amount });
      return { ...depositView(row), held: (await depositsHeld(db, job.id)).toFixed(2) };
    });
  }

  // ---------------------------------------------------------------- in the caller's transaction

  /** A card/QR payment of purpose JOB_ORDER taken at this drawer, consumed once by a down payment. */
  private async consumeIntent(db: Database, auth: AuthContext, a: { paymentIntentId: string; sessionId: string; jobId: string; currency: string }) {
    const [p] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, a.paymentIntentId)).for('update');
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND, { paymentIntentId: a.paymentIntentId });
    if (p.saleId || p.folioId || p.jobOrderId) throw new AppError('PAYMENT_CONSUMED', 'This payment was already used', HttpStatus.CONFLICT, { paymentIntentId: p.id });
    if (p.status !== 'SUCCEEDED') throw new AppError('PAYMENT_NOT_SUCCEEDED', `This payment is ${p.status.toLowerCase()}`, HttpStatus.CONFLICT, { paymentIntentId: p.id, status: p.status });
    if (p.purpose !== 'JOB_ORDER') throw unprocessable('PAYMENT_MISMATCH', 'This payment was not taken for a job order', { paymentIntentId: p.id });
    if (p.cashierSessionId !== a.sessionId || p.currency !== a.currency) throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken at another drawer', { paymentIntentId: p.id });
    await db.update(paymentIntents).set({ jobOrderId: a.jobId }).where(eq(paymentIntents.id, p.id));
    await db.insert(paymentEvents).values({ tenantId: tenantOf(auth).tenantId, paymentIntentId: p.id, type: 'CONSUMED', detail: { jobOrderId: a.jobId }, createdBy: auth.userId });
    return p;
  }

  /** Give (part of) a down payment back: cash from an open drawer of the job's entity, or a bank transfer. */
  async refundHeld(db: Database, auth: AuthContext, job: JobRow, a: { refund: RefundJobDepositInput['refund']; reason: string; amount: Dec }): Promise<DepositRow> {
    const tenantId = job.tenantId;
    let sessionId: string | null = null;
    if (a.refund.method === 'CASH') {
      sessionId = (await frontDeskSession(db, auth, a.refund.cashierSessionId, job.legalEntityId, job.branchId)).session.id;
      const drawer = toDec(await expectedCash(db, sessionId));
      if (drawer.lt(a.amount)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the refund', { available: drawer.toFixed(2) });
    }
    const [row] = await db
      .insert(jobOrderDeposits)
      .values({
        tenantId, jobOrderId: job.id, legalEntityId: job.legalEntityId, branchId: job.branchId, kind: 'REFUNDED', amount: a.amount.negated().toString(),
        method: a.refund.method, cashierSessionId: sessionId, reference: a.refund.method === 'BANK_TRANSFER' ? a.refund.reference : null, reason: a.reason, createdBy: auth.userId,
      })
      .returning();
    if (sessionId) {
      await db.insert(cashMovements).values({ tenantId, cashierSessionId: sessionId, type: 'JOB_DEPOSIT_REFUND', amount: a.amount.negated().toString(), jobOrderDepositId: row!.id, reason: a.reason, createdBy: auth.userId });
    }
    await post(db, {
      tenantId, legalEntityId: job.legalEntityId, branchId: job.branchId, sourceType: 'JOB_ORDER_DEPOSIT', sourceId: row!.id, memo: `Down payment refunded: ${a.reason}`,
      lines: downPaymentRefundedPosting(a.amount, sessionId ? 'CASH' : 'BANK', job.branchId), createdBy: auth.userId,
    });
    await this.audit(db, auth, 'job_order.deposit_refunded', 'job_order', job.id, { jobOrderDepositId: row!.id, amount: a.amount.toFixed(2), method: a.refund.method });
    return row!;
  }

  /**
   * Keep what is held (§9): income ex VAT plus its output VAT, computed by @1pos/tax with the job's main
   * service's tax category (the line that costs most), the amount VAT-inclusive.
   */
  async forfeitHeld(db: Database, auth: AuthContext, job: JobRow, reason: string): Promise<DepositRow | null> {
    await lockJobDeposits(db, job.id);
    const amount = await depositsHeld(db, job.id);
    if (amount.lte(0)) return null;
    const [main] = await db.select({ variantId: jobOrderLines.variantId }).from(jobOrderLines).where(eq(jobOrderLines.jobOrderId, job.id)).orderBy(desc(jobOrderLines.amountDue)).limit(1);
    if (!main) throw unprocessable('JOB_NOT_PRICED', 'This job order has no lines to say what the down payment was for');
    const fee = await this.tax.computeRoomCharge(db, { branchId: job.branchId, variantId: main.variantId, at: await effectiveNow(db), unitPrice: amount.toString(), inclusive: true });
    const t = fee.totals;
    const exVat = toDec(t.vatableSales).plus(t.vatExemptSales).plus(t.zeroRatedSales).plus(t.percentageTaxSales);
    // Rounding never leaves a centavo outside: VAT is what the amount does not keep ex VAT.
    const vat = amount.minus(exVat);
    const [row] = await db
      .insert(jobOrderDeposits)
      .values({
        tenantId: job.tenantId, jobOrderId: job.id, legalEntityId: job.legalEntityId, branchId: job.branchId, kind: 'FORFEITED', amount: amount.negated().toString(),
        reason, netAmount: exVat.toString(), vatAmount: vat.toString(), createdBy: auth.userId,
      })
      .returning();
    await post(db, {
      tenantId: job.tenantId, legalEntityId: job.legalEntityId, branchId: job.branchId, sourceType: 'JOB_ORDER_DEPOSIT', sourceId: row!.id, memo: `Down payment kept: ${reason}`,
      lines: downPaymentForfeitedPosting({ amount, exVat, vatAmount: vat }, job.branchId), createdBy: auth.userId,
    });
    await this.audit(db, auth, 'job_order.deposit_forfeited', 'job_order', job.id, { jobOrderDepositId: row!.id, amount: amount.toFixed(2) });
    return row!;
  }
}
