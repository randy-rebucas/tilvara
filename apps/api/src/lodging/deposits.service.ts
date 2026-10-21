import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { depositAppliedPosting, depositForfeitedPosting, depositReceivedPosting, depositRefundedPosting } from '@1pos/accounting';
import { cashMovements, eq, roomTypes, stayDeposits, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { ApplyDepositInput, CancelStayInput, ForfeitDepositInput, ReceiveDepositInput, RefundDepositInput } from '@1pos/validation';
import { post } from '../accounting/ledger.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLodging } from '../billing/entitlements.js';
import { effectiveNow } from '../common/clock.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { expectedCash } from '../sales/cash.service.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { depositsHeld, ensureFolio, folioBalance, folioOfStay, folioSettled, insertEntry, loadStay, lockDeposits, lockFolio, type FolioRow, type StayRow } from './folio.js';
import { consumeFolioIntent, frontDeskSession } from './front-desk.js';

type DepositRow = typeof stayDeposits.$inferSelect;
const money = (v: string | null) => (v === null ? null : toDec(v).toFixed(2));
export const depositView = (d: DepositRow) => ({ ...d, amount: money(d.amount), netAmount: money(d.netAmount), vatAmount: money(d.vatAmount) });

/**
 * Booking deposits (ADR-0023 §6): received (cash at a drawer, card/QR, bank transfer), held without VAT,
 * applied onto the folio, refunded, or forfeited as a cancellation fee with its VAT. Every row posts one
 * journal entry (STAY_DEPOSIT) in its transaction; cash goes through the drawer's movements.
 */
@Injectable()
export class DepositsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    stay_deposits_balance: ['DEPOSIT_EXCEEDED', 'More than the deposit held'],
    stay_deposits_intent_once: ['PAYMENT_CONSUMED', 'This payment was already used'],
    folio_entries_overpaid: ['FOLIO_OVERPAID', 'The folio would owe the guest money'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {
    super(tenantDb);
  }

  list(auth: AuthContext, stayId: string) {
    return this.read(auth, async (db) => {
      const stay = await loadStay(db, stayId);
      this.assertCan(auth, 'lodging.read', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
      const rows = await db.select().from(stayDeposits).where(eq(stayDeposits.stayId, stayId)).orderBy(stayDeposits.createdAt, stayDeposits.id);
      return { data: rows.map(depositView), held: (await depositsHeld(db, stayId)).toFixed(2) };
    });
  }

  receive(auth: AuthContext, stayId: string, input: ReceiveDepositInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, stayId, true);
      const scope = { branchId: stay.branchId, legalEntityId: stay.legalEntityId };
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (stay.status !== 'BOOKED' && stay.status !== 'IN_HOUSE') throw new AppError('STAY_ENDED', 'This stay has ended', HttpStatus.CONFLICT, { status: stay.status });
      const folio = await ensureFolio(db, stay, auth.userId);
      if (folio.status !== 'OPEN') throw folioSettled();
      await lockDeposits(db, stay.id);
      const tenantId = tenantOf(auth).tenantId;
      let amount: string;
      let method: string;
      let sessionId: string | null = null;
      let intentId: string | null = null;
      let reference: string | null = null;
      if (input.method === 'CASH') {
        sessionId = (await frontDeskSession(db, auth, input.cashierSessionId, stay.legalEntityId)).session.id;
        amount = input.amount;
        method = 'CASH';
      } else if (input.method === 'INTENT') {
        sessionId = (await frontDeskSession(db, auth, input.cashierSessionId, stay.legalEntityId)).session.id;
        const p = await consumeFolioIntent(db, auth, { paymentIntentId: input.paymentIntentId, sessionId, folioId: folio.id, currency: folio.currency, consumer: { stayDeposit: true } });
        amount = p.amount;
        method = p.method;
        intentId = p.id;
      } else {
        this.assertCan(auth, 'lodging.rates', scope);
        amount = input.amount;
        method = 'BANK_TRANSFER';
        reference = input.reference;
      }
      const [row] = await db
        .insert(stayDeposits)
        .values({
          tenantId, stayId: stay.id, folioId: folio.id, legalEntityId: stay.legalEntityId, branchId: stay.branchId, kind: 'RECEIVED', amount, method,
          cashierSessionId: method === 'CASH' ? sessionId : null, paymentIntentId: intentId, reference, createdBy: auth.userId,
        })
        .returning();
      if (method === 'CASH') {
        await db.insert(cashMovements).values({ tenantId, cashierSessionId: sessionId!, type: 'DEPOSIT', amount, stayDepositId: row!.id, reason: 'Booking deposit', createdBy: auth.userId });
      }
      await post(db, {
        tenantId, legalEntityId: stay.legalEntityId, branchId: stay.branchId, sourceType: 'STAY_DEPOSIT', sourceId: row!.id, memo: 'Booking deposit received',
        lines: depositReceivedPosting(amount, method === 'CASH' ? 'CASH' : method === 'BANK_TRANSFER' ? 'BANK' : 'ELECTRONIC', stay.branchId),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'stay.deposit_received', 'stay', stay.id, { stayDepositId: row!.id, amount: toDec(amount).toFixed(2), method });
      return { ...depositView(row!), held: (await depositsHeld(db, stay.id)).toFixed(2) };
    });
  }

  apply(auth: AuthContext, stayId: string, input: ApplyDepositInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, stayId, true);
      this.assertCan(auth, 'lodging.manage', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
      await assertLodging(db);
      if (stay.status !== 'IN_HOUSE') throw new AppError('STAY_NOT_IN_HOUSE', 'Deposits are applied to the folio of a guest in house', HttpStatus.CONFLICT, { status: stay.status });
      const folio = await folioOfStay(db, stay.id);
      if (!folio || folio.status !== 'OPEN') throw folioSettled();
      const row = await this.applyHeld(db, auth, stay, folio, input.amount ? toDec(input.amount) : null);
      return { applied: row ? depositView(row) : null, held: (await depositsHeld(db, stay.id)).toFixed(2), balance: (await folioBalance(db, folio.id)).toFixed(2) };
    });
  }

  refund(auth: AuthContext, stayId: string, input: RefundDepositInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, stayId, true);
      this.assertCan(auth, 'lodging.manage', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
      await assertLodging(db);
      await lockDeposits(db, stay.id);
      const held = await depositsHeld(db, stay.id);
      const amount = input.amount ? toDec(input.amount) : held;
      if (amount.lte(0) || amount.gt(held)) throw new AppError('DEPOSIT_EXCEEDED', 'More than the deposit held', HttpStatus.CONFLICT, { held: held.toFixed(2) });
      const row = await this.refundHeld(db, auth, stay, { refund: input.refund, reason: input.reason, amount });
      return { ...depositView(row), held: (await depositsHeld(db, stay.id)).toFixed(2) };
    });
  }

  forfeit(auth: AuthContext, stayId: string, input: ForfeitDepositInput) {
    return this.mutate(auth, async (db) => {
      const stay = await loadStay(db, stayId, true);
      this.assertCan(auth, 'lodging.manage', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
      await assertLodging(db);
      if (stay.status !== 'CANCELLED' && stay.status !== 'NO_SHOW') {
        throw new AppError('STAY_NOT_CANCELLED', 'A deposit is kept only for a cancelled booking or a no-show', HttpStatus.CONFLICT, { status: stay.status });
      }
      await lockDeposits(db, stay.id);
      const held = await depositsHeld(db, stay.id);
      const amount = input.amount ? toDec(input.amount) : held;
      if (amount.lte(0) || amount.gt(held)) throw new AppError('DEPOSIT_EXCEEDED', 'More than the deposit held', HttpStatus.CONFLICT, { held: held.toFixed(2) });
      const row = await this.forfeitHeld(db, auth, stay, { reason: input.reason, amount });
      return { ...depositView(row), held: (await depositsHeld(db, stay.id)).toFixed(2) };
    });
  }

  // ---------------------------------------------------------------- in the caller's transaction

  /** Move deposits held onto the folio, as far as they pay its balance (`amount` = that much at most). */
  async applyHeld(db: Database, auth: AuthContext, stay: StayRow, folio: FolioRow, amount: Dec | null): Promise<DepositRow | null> {
    await lockFolio(db, folio.id);
    await lockDeposits(db, stay.id);
    const held = await depositsHeld(db, stay.id);
    const most = Dec.min(held, Dec.max(await folioBalance(db, folio.id), 0));
    if (amount && amount.gt(most)) throw new AppError('DEPOSIT_EXCEEDED', 'More than the deposit held or the balance', HttpStatus.CONFLICT, { held: held.toFixed(2), most: most.toFixed(2) });
    const apply = amount ?? most;
    if (apply.lte(0)) return null;
    const tenantId = stay.tenantId;
    const [row] = await db
      .insert(stayDeposits)
      .values({ tenantId, stayId: stay.id, folioId: folio.id, legalEntityId: stay.legalEntityId, branchId: stay.branchId, kind: 'APPLIED', amount: apply.negated().toString(), createdBy: auth.userId })
      .returning();
    await insertEntry(db, {
      tenantId, folioId: folio.id, stayId: stay.id, kind: 'DEPOSIT_APPLIED', amount: apply.negated().toString(), description: 'Deposit applied', stayDepositId: row!.id, createdBy: auth.userId,
    }, auth.correlationId);
    await post(db, {
      tenantId, legalEntityId: stay.legalEntityId, branchId: stay.branchId, sourceType: 'STAY_DEPOSIT', sourceId: row!.id, memo: 'Deposit applied to the folio',
      lines: depositAppliedPosting(apply, stay.branchId), createdBy: auth.userId,
    });
    await this.audit(db, auth, 'stay.deposit_applied', 'stay', stay.id, { stayDepositId: row!.id, amount: apply.toFixed(2) });
    return row!;
  }

  async refundHeld(db: Database, auth: AuthContext, stay: StayRow, a: { refund: NonNullable<CancelStayInput['refund']>; reason: string; amount: Dec }): Promise<DepositRow> {
    const tenantId = stay.tenantId;
    const folio = (await folioOfStay(db, stay.id))!;
    let sessionId: string | null = null;
    if (a.refund.method === 'CASH') {
      sessionId = (await frontDeskSession(db, auth, a.refund.cashierSessionId, stay.legalEntityId)).session.id;
      const drawer = toDec(await expectedCash(db, sessionId));
      if (drawer.lt(a.amount)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the refund', { available: drawer.toFixed(2) });
    } else this.assertCan(auth, 'lodging.rates', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
    const [row] = await db
      .insert(stayDeposits)
      .values({
        tenantId, stayId: stay.id, folioId: folio.id, legalEntityId: stay.legalEntityId, branchId: stay.branchId, kind: 'REFUNDED', amount: a.amount.negated().toString(),
        method: a.refund.method, cashierSessionId: sessionId, reference: a.refund.method === 'BANK_TRANSFER' ? a.refund.reference : null, reason: a.reason, createdBy: auth.userId,
      })
      .returning();
    if (sessionId) {
      await db.insert(cashMovements).values({ tenantId, cashierSessionId: sessionId, type: 'DEPOSIT_REFUND', amount: a.amount.negated().toString(), stayDepositId: row!.id, reason: a.reason, createdBy: auth.userId });
    }
    await post(db, {
      tenantId, legalEntityId: stay.legalEntityId, branchId: stay.branchId, sourceType: 'STAY_DEPOSIT', sourceId: row!.id, memo: `Deposit refunded: ${a.reason}`,
      lines: depositRefundedPosting(a.amount, sessionId ? 'CASH' : 'BANK', stay.branchId), createdBy: auth.userId,
    });
    await this.audit(db, auth, 'stay.deposit_refunded', 'stay', stay.id, { stayDepositId: row!.id, amount: a.amount.toFixed(2), method: a.refund.method });
    return row!;
  }

  /** Kept as a cancellation fee: its VAT computed by @1pos/tax with the room night's category, the amount VAT-inclusive. */
  async forfeitHeld(db: Database, auth: AuthContext, stay: StayRow, a: { reason: string; amount: Dec }): Promise<DepositRow> {
    const tenantId = stay.tenantId;
    const folio = (await folioOfStay(db, stay.id))!;
    const [type] = await db.select().from(roomTypes).where(eq(roomTypes.id, stay.roomTypeId));
    const fee = await this.tax.computeRoomCharge(db, { branchId: stay.branchId, variantId: type!.nightVariantId, at: await effectiveNow(db), unitPrice: a.amount.toString(), inclusive: true });
    const t = fee.totals;
    const exVat = toDec(t.vatableSales).plus(t.vatExemptSales).plus(t.zeroRatedSales).plus(t.percentageTaxSales);
    // Rounding never leaves a centavo outside the fee: VAT is what the amount does not keep ex VAT.
    const vat = a.amount.minus(exVat);
    const [row] = await db
      .insert(stayDeposits)
      .values({
        tenantId, stayId: stay.id, folioId: folio.id, legalEntityId: stay.legalEntityId, branchId: stay.branchId, kind: 'FORFEITED', amount: a.amount.negated().toString(),
        reason: a.reason, netAmount: exVat.toString(), vatAmount: vat.toString(), createdBy: auth.userId,
      })
      .returning();
    await post(db, {
      tenantId, legalEntityId: stay.legalEntityId, branchId: stay.branchId, sourceType: 'STAY_DEPOSIT', sourceId: row!.id, memo: `Deposit kept: ${a.reason}`,
      lines: depositForfeitedPosting({ amount: a.amount, exVat, vatAmount: vat }, stay.branchId), createdBy: auth.userId,
    });
    await this.audit(db, auth, 'stay.deposit_forfeited', 'stay', stay.id, { stayDepositId: row!.id, amount: a.amount.toFixed(2) });
    return row!;
  }
}
