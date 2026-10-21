import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  branches,
  cashMovements,
  eq,
  inArray,
  legalEntities,
  productVariants,
  products,
  registers,
  saleCharges,
  saleLines,
  saleReturnCharges,
  saleReturnLines,
  saleReturns,
  saleTips,
  saleTipRefunds,
  saleTenders,
  paymentIntents,
  paymentEvents,
  sales,
  sql,
  stockMovements,
  customerCreditEntries,
  users,
  unitsOfMeasure,
  type Database,
  inSequence,
  mapInSequence,
} from '@1pos/database';
import { buildReturnReceipt } from './receipt.js';
import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';
import type { CreateSaleReturnInput, PreviewSaleReturnInput, TipRefundInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { nextNumber } from '../common/sequence.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';
import { expectedCash, loadSession } from './cash.service.js';
import { saleReturnPosting, tipRefundPosting } from '@1pos/accounting';
import { PaymentProvider } from '../payments/provider.js';
import { activeCustomer } from '../customers/customers.service.js';
import { post } from '../accounting/ledger.js';
import { recordPreparedWaste } from '../restaurant/consumption.js';
import { reopenForVoidedCheck } from '../restaurant/bills.service.js';
import { recallCounterOrder } from '../restaurant/counter.js';
import { endReturnedCycleRuns } from '../laundry/job.js';
import { packageReturnValue, returnPackages, splitByWeight } from '../salon/packages.js';
import { returnFills } from '../pharmacy/dispensing.js';
import { folioRefundPlan, insertEntry } from '../lodging/folio.js';

const BUCKETS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales',
] as const;
type Bucket = (typeof BUCKETS)[number];
/** The buckets whose sum is a line's sales ex VAT. */
const SALES_BUCKETS = ['vatableSales', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales'] as const;
type Amounts = Record<Bucket | 'amountDue', Dec>;

const zero = (): Amounts => Object.fromEntries([...BUCKETS, 'amountDue'].map((k) => [k, new Dec(0)])) as Amounts;
const out = (a: Amounts) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.toFixed(4)])) as Record<keyof Amounts, string>;

const notNamed = (): never => {
  throw unprocessable('CUSTOMER_REQUIRED', 'Name the customer who gets the store credit');
};

/**
 * An exchange turns the whole refund into cash towards the new items, and any difference into change:
 * store credit (ADR-0018) and room charges (ADR-0023) must go back where they came from, so those sales
 * are returned first (to the credit or the room) and the new items rung up as a sale.
 */
function assertExchangeable(tenders: { method: string }[]) {
  if (tenders.some((t) => t.method === 'STORE_CREDIT')) {
    throw new AppError('EXCHANGE_STORE_CREDIT', 'This sale was paid with store credit: return it to the customer\'s credit, then ring up the new items', HttpStatus.CONFLICT);
  }
  if (tenders.some((t) => t.method === 'ROOM_CHARGE')) {
    throw new AppError('EXCHANGE_ROOM_CHARGE', 'This sale was charged to a room: return it to the room, then ring up the new items', HttpStatus.CONFLICT);
  }
}

/**
 * Voids and returns (ADR-0011). Append-only documents against the original sale lines, refunded
 * in cash from an open drawer. What the sale took from stock comes back (RETURN); DAMAGED lines are
 * then written off in a WASTE adjustment (Spoilage and waste). Serialized per sale.
 */
@Injectable()
export class ReturnsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
  ) {
    super(tenantDb);
  }

  /**
   * A void or return. A voided sale's card tip is given back right after the void commits, by
   * cancelling the tip's own charge (the provider is never called inside a transaction); if that
   * cannot be done now, the void says so (`tipRefundPending`) and `refundTip` finishes it later.
   */
  async create(auth: AuthContext, saleId: string, input: CreateSaleReturnInput) {
    const doc = await this.mutate(auth, async (db) => this.view(db, await this.record(db, auth, saleId, input)));
    if (!doc.tipRefundPending) return doc;
    const id = String((doc as { id?: unknown }).id);
    try {
      await this.refundTip(auth, id, {});
    } catch {
      // Left pending: the slip and the sale say so; "Give the tip back" retries.
    }
    return this.get(auth, id);
  }

  /**
   * Give a voided sale's card tip back (session 25): cancel its charge with the provider; when the
   * provider refuses, from the drawer in cash (the void's shift, or `cashierSessionId` if that one has
   * closed). Once per void: a second call returns what was done. A provider that cancelled but whose
   * answer was lost is asked again before any cash leaves the drawer.
   */
  async refundTip(auth: AuthContext, saleReturnId: string, input: TipRefundInput) {
    const plan = await this.read(auth, async (db) => {
      const [doc] = await db.select().from(saleReturns).where(eq(saleReturns.id, saleReturnId));
      if (!doc) throw notFound('Return');
      this.assertCan(auth, 'sales.void', { legalEntityId: doc.legalEntityId, branchId: doc.branchId, registerId: doc.registerId });
      const [tip] = doc.kind === 'VOID' ? await db.select().from(saleTips).where(eq(saleTips.saleId, doc.saleId)) : [];
      if (!tip || tip.method === 'CASH') throw unprocessable('NO_CARD_TIP', 'This void has no card tip to give back');
      const [done] = await db.select().from(saleTipRefunds).where(eq(saleTipRefunds.saleReturnId, saleReturnId));
      return { doc, tip, done };
    });
    if (plan.done) return this.get(auth, saleReturnId);
    const intentId = plan.tip.paymentIntentId!;
    let cancelled = (await this.provider.cancel(intentId)).status === 'CANCELED';
    // Cancelled on an earlier attempt whose answer was lost: the provider says so, never cash twice.
    if (!cancelled) {
      const found = await this.provider.retrieve(intentId);
      cancelled = found.status === 'FAILED' && found.failureCode === 'canceled';
    }
    await this.tenantDb.run(auth, async (db) => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tip-refund:${saleReturnId}`}, 0))`);
      const [already] = await db.select().from(saleTipRefunds).where(eq(saleTipRefunds.saleReturnId, saleReturnId));
      if (already) return;
      const { doc, tip } = plan;
      const tenantId = tenantOf(auth).tenantId;
      let sessionId: string | null = null;
      if (!cancelled) {
        sessionId = input.cashierSessionId ?? doc.cashierSessionId;
        const { session } = await loadSession(db, sessionId, true);
        if (session.status !== 'OPEN' || session.branchId !== doc.branchId) {
          throw new AppError('TIP_REFUND_NEEDS_DRAWER', 'The card provider refused; give the tip back in cash from an open drawer at this branch', HttpStatus.CONFLICT);
        }
        const drawer = toDec(await expectedCash(db, session.id));
        if (drawer.lt(tip.amount)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the tip', { available: drawer.toFixed(2) });
      }
      const [row] = await db.insert(saleTipRefunds).values({
        tenantId, saleReturnId, saleTipId: tip.id, method: cancelled ? 'CARD' : 'CASH',
        paymentIntentId: cancelled ? tip.paymentIntentId : null, amount: tip.amount, createdBy: auth.userId,
      }).returning();
      if (cancelled) {
        await db.update(paymentIntents).set({ status: 'CANCELED' }).where(eq(paymentIntents.id, intentId));
        await db.insert(paymentEvents).values({ tenantId, paymentIntentId: intentId, type: 'CANCELED', detail: { saleReturnId, tip: true }, createdBy: auth.userId });
      } else {
        await db.insert(cashMovements).values({
          tenantId, cashierSessionId: sessionId!, type: 'TIP_REFUND', amount: toDec(tip.amount).negated().toString(), saleId: doc.saleId, saleReturnId,
          reason: `Card tip of void #${doc.returnNumber} (card refused)`, createdBy: auth.userId,
        });
      }
      await post(db, {
        tenantId, legalEntityId: doc.legalEntityId, branchId: doc.branchId, sourceType: 'SALE_TIP_REFUND', sourceId: row!.id,
        memo: `Tip given back, void #${doc.returnNumber}`, lines: tipRefundPosting(tip.amount, cancelled ? 'CARD' : 'CASH', doc.branchId), createdBy: auth.userId,
      });
      await this.audit(db, auth, 'sale.tip_refunded', 'sale', doc.saleId, { saleReturnId, method: cancelled ? 'CARD' : 'CASH', amount: toDec(tip.amount).toFixed(2) });
    });
    return this.get(auth, saleReturnId);
  }

  /**
   * Record a void or return in the caller's transaction. In an exchange (`exchange`), the refund pays
   * for the new sale recorded right after it on the same shift, so the drawer is checked by the
   * exchange once both are in, not here.
   */
  async record(db: Database, auth: AuthContext, saleId: string, input: CreateSaleReturnInput, options: { exchange?: boolean } = {}) {
    const tenantId = tenantOf(auth).tenantId;
    const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
    if (!sale) throw notFound('Sale');
    const saleScope = { legalEntityId: sale.legalEntityId, branchId: sale.branchId, registerId: sale.registerId };
    this.assertCan(auth, input.kind === 'VOID' ? 'sales.void' : 'sales.refund', saleScope);
    // A laundry claim released the customer's things (ADR-0024 §5): a mistake is a return, never a void.
    if (input.kind === 'VOID' && sale.jobOrderId) {
      throw new AppError('CLAIM_SALE_NOT_VOIDABLE', 'A laundry claim cannot be voided; record a return instead', HttpStatus.CONFLICT, { jobOrderId: sale.jobOrderId });
    }
    // One return at a time per sale, so "remaining quantity" cannot be raced.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${saleId}, 0))`);

    const { session, scope } = await loadSession(db, input.cashierSessionId, true);
    if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'The refund drawer session is not open', HttpStatus.CONFLICT);
    if (session.branchId !== sale.branchId) throw unprocessable('WRONG_BRANCH', 'Returns are processed at the branch that made the sale');
    if (session.openedBy !== auth.userId && !this.can(auth, 'cash.reconcile', scope)) {
      throw new AppError('NOT_SESSION_OWNER', 'Refund from your own drawer', HttpStatus.FORBIDDEN);
    }

    const { planned, chargeParts, totals } = await this.plan(db, sale, input.kind, input.lines, session.id);

    const refund = totals.amountDue;
    if (input.expectedRefund !== undefined && !toDec(input.expectedRefund).equals(refund.toDecimalPlaces(2))) {
      throw new AppError('REFUND_CHANGED', 'The refund amount differs from what was shown', HttpStatus.CONFLICT, { refund: refund.toFixed(2) });
    }
    // A refund as store credit (ADR-0018) goes to a customer: the sale's, or one named now. No cash moves.
    const toCredit = input.refundTo === 'STORE_CREDIT';
    if (toCredit && options.exchange) throw unprocessable('EXCHANGE_IN_CASH', 'An exchange puts the refund towards the new items');
    const creditCustomer = toCredit ? await activeCustomer(db, input.customerId ?? sale.customerId ?? notNamed()) : null;
    // A void gives the sale's tip back too (session 25): a cash tip here, from the drawer; a card tip
    // by cancelling its charge once this commits (`refundTip`). A return keeps the tip.
    const [tip] = input.kind === 'VOID' ? await db.select({ amount: saleTips.amount, method: saleTips.method }).from(saleTips).where(eq(saleTips.saleId, saleId)) : [];
    const tipRefund = toDec(tip?.method === 'CASH' ? tip.amount : '0');
    const tenders = await db.select({ method: saleTenders.method, amount: saleTenders.amount, stayId: saleTenders.stayId }).from(saleTenders).where(eq(saleTenders.saleId, saleId));
    const creditUsed = tenders.filter((t) => t.method === 'STORE_CREDIT').reduce((a, t) => a.plus(t.amount), new Dec(0));
    const roomTender = tenders.find((t) => t.method === 'ROOM_CHARGE');
    if (options.exchange) assertExchangeable(tenders);
    // A room-charged sale returned while the guest's folio is open goes back onto the folio (ADR-0023 §5.1),
    // as far as it was charged there and the folio still owes; the rest is refunded as usual.
    const toFolio = roomTender?.stayId ? await folioRefundPlan(db, { saleId, stayId: roomTender.stayId, refund }) : null;
    const folioRefund = toFolio?.amount ?? new Dec(0);
    const rest = refund.minus(folioRefund);
    // Store credit never turns into drawer cash (ADR-0018): the share of the refund the sale paid with
    // credit goes back to the sale's customer as credit. Several returns never give back more than was
    // used; the one that completes the sale gives back exactly what is left of it.
    const creditBack = creditUsed.gt(0) && !toCredit ? await this.creditShare(db, sale, refund, rest, creditUsed) : new Dec(0);
    if (toCredit && creditUsed.gt(0) && creditCustomer!.id !== sale.customerId) {
      throw unprocessable('CREDIT_GOES_TO_PAYER', 'This sale was paid with store credit: the refund goes back to the same customer');
    }
    const cashBack = toCredit ? new Dec(0) : rest.minus(creditBack);
    if (!options.exchange) {
      const cashOut = cashBack.plus(tipRefund);
      const drawer = toDec(await expectedCash(db, session.id));
      if (cashOut.gt(0) && drawer.lt(cashOut)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the refund', { available: drawer.toFixed(2) });
    }

    const returnNumber = await nextNumber(db, tenantId, session.registerId, 'RETURN');
    const [doc] = await db
      .insert(saleReturns)
      .values({
        tenantId,
        saleId,
        legalEntityId: sale.legalEntityId,
        branchId: session.branchId,
        registerId: session.registerId,
        cashierSessionId: session.id,
        kind: input.kind,
        returnNumber,
        reason: input.reason,
        processedBy: auth.userId,
        currency: sale.currency,
        ...out(totals),
        refundMethod: folioRefund.gt(0) && rest.isZero() ? 'ROOM_CHARGE' : toCredit || (rest.gt(0) && cashBack.isZero()) ? 'STORE_CREDIT' : 'CASH',
        tipRefund: tipRefund.toString(),
      })
      .returning();
    const inserted = await db
      .insert(saleReturnLines)
      .values(planned.map((p) => ({ tenantId, saleReturnId: doc!.id, saleLineId: p.line.id, quantity: p.quantity.toString(), disposition: p.req.disposition, ...out(p.amounts) })))
      .returning({ id: saleReturnLines.id, saleLineId: saleReturnLines.saleLineId });
    // Medicines given back return their pieces to the prescriptions they filled (ADR-0025 §6).
    await returnFills(db, { tenantId, userId: auth.userId }, planned.filter((p) => p.line.drugClass !== null).map((p) => ({ saleLineId: p.line.id, saleReturnLineId: inserted.find((i) => i.saleLineId === p.line.id)!.id, quantity: p.quantity })));
    // Packages (ADR-0022 §6): whole unused packages leave what is owed; sessions come back to their package.
    const packages = await returnPackages(
      db,
      { tenantId, saleReturnId: doc!.id, userId: auth.userId },
      planned.map((p) => ({ saleLineId: p.line.id, quantity: p.quantity, soldQuantity: toDec(p.line.quantity), customerPackageId: p.line.customerPackageId, packageValue: p.line.packageValue })),
    );
    if (chargeParts.length) {
      await db.insert(saleReturnCharges).values(chargeParts.map((c) => ({ tenantId, saleReturnId: doc!.id, saleChargeId: c.chargeId, ...out(c.amounts) })));
    }
    const serviceCharge = chargeParts.reduce((a, c) => a.plus(c.amounts.vatableSales).plus(c.amounts.vatExemptSales).plus(c.amounts.zeroRatedSales).plus(c.amounts.percentageTaxSales), new Dec(0));

    // Sorted by variant (lock order, ADR-0012 §7); the ledger trigger costs them at the sale's cost.
    // Damaged goods come back too and are written off right after as waste, so their cost leaves
    // COGS for Spoilage and waste (the stock nets to what it was).
    const restock = planned
      .filter((p) => p.trackInventory)
      .sort((a, b) => (a.line.variantId < b.line.variantId ? -1 : a.line.variantId > b.line.variantId ? 1 : 0));
    let restockedValue = new Dec(0);
    if (restock.length) {
      const moved = await db.insert(stockMovements).values(
        restock.map((p) => ({
          tenantId,
          branchId: sale.branchId,
          variantId: p.line.variantId,
          quantity: p.quantity.toString(),
          type: 'RETURN',
          saleId,
          saleLineId: p.line.id,
          saleReturnLineId: inserted.find((i) => i.saleLineId === p.line.id)!.id,
          createdBy: auth.userId,
        })),
      ).returning({ value: stockMovements.value });
      restockedValue = moved.reduce((a, m) => a.plus(m.value), new Dec(0));
    }
    const damaged = restock.filter((p) => p.req.disposition === 'DAMAGED');
    const wasteAdjustmentId = damaged.length
      ? await recordPreparedWaste(db, {
          tenantId,
          branchId: sale.branchId,
          legalEntityId: sale.legalEntityId,
          reason: `Damaged on ${input.kind === 'VOID' ? 'void' : 'return'} #${returnNumber} of sale #${sale.saleNumber}`,
          userId: auth.userId,
          items: damaged.map((p) => ({ variantId: p.line.variantId, quantity: p.quantity.toString(), tracked: true })),
        })
      : null;
    await post(db, {
      tenantId,
      legalEntityId: sale.legalEntityId,
      branchId: sale.branchId,
      sourceType: 'SALE_RETURN',
      sourceId: doc!.id,
      memo: `${input.kind === 'VOID' ? 'Void' : 'Return'} #${returnNumber} of sale #${sale.saleNumber}`,
      lines: saleReturnPosting({
        salesExVat: totals.vatableSales.plus(totals.vatExemptSales).plus(totals.zeroRatedSales).plus(totals.percentageTaxSales).minus(serviceCharge),
        serviceCharge,
        vatAmount: totals.vatAmount,
        statutoryDiscount: totals.statutoryDiscount,
        refund,
        refundTo: toCredit ? 'STORE_CREDIT' : 'CASH',
        storeCredit: creditBack,
        folioRefund,
        restocked: restockedValue,
        tipRefund,
        packagesRefunded: packages.prepaid,
        packageSessionsRestored: packages.restored,
      }, sale.branchId),
      createdBy: auth.userId,
    });
    if (toFolio) {
      await insertEntry(db, {
        tenantId, folioId: toFolio.folio.id, stayId: toFolio.folio.stayId, kind: 'CHARGE_RETURN', amount: folioRefund.negated().toString(), saleId, saleReturnId: doc!.id,
        description: `${input.kind === 'VOID' ? 'Void' : 'Return'} #${returnNumber} of sale #${sale.saleNumber}`, createdBy: auth.userId,
      }, auth.correlationId);
    }
    const creditIn = toCredit ? rest : creditBack;
    if (creditIn.gt(0)) {
      await db.insert(customerCreditEntries).values({
        tenantId, legalEntityId: sale.legalEntityId, branchId: sale.branchId, customerId: creditCustomer?.id ?? sale.customerId!, kind: 'RETURN',
        amount: creditIn.toString(), saleReturnId: doc!.id, createdBy: auth.userId,
      });
    }
    if (cashBack.gt(0)) {
      await db.insert(cashMovements).values({
        tenantId,
        cashierSessionId: session.id,
        type: 'REFUND',
        amount: cashBack.negated().toString(),
        saleId,
        saleReturnId: doc!.id,
        reason: `${input.kind === 'VOID' ? 'Void' : 'Return'} #${returnNumber}`,
        createdBy: auth.userId,
      });
    }
    if (tipRefund.gt(0)) {
      await db.insert(cashMovements).values({
        tenantId, cashierSessionId: session.id, type: 'TIP_REFUND', amount: tipRefund.negated().toString(), saleId, saleReturnId: doc!.id,
        reason: `Tip of void #${returnNumber}`, createdBy: auth.userId,
      });
    }
    // A voided restaurant check gives its share of the bill back (ADR-0014 §8, audit 2026-10-21): the bill
    // (and its order) is payable again. A return of part of a check leaves the bill as it is.
    const reopened = input.kind === 'VOID' && sale.orderBillId ? await reopenForVoidedCheck(db, sale.orderBillId) : null;
    // Counter service: a voided sale's food the kitchen has not handed over yet comes off its screen.
    const recalled = input.kind === 'VOID' ? await recallCounterOrder(db, saleId, auth.userId, `Sale #${sale.saleNumber} voided`) : 0;
    // Self-service laundry cycles given back: their machine runs end (ADR-0024 §7).
    const runsEnded = await endReturnedCycleRuns(db, planned.map((p) => p.line.id), auth.userId);
    await this.audit(db, auth, input.kind === 'VOID' ? 'sale.voided' : 'sale.returned', 'sale', saleId, {
      saleReturnId: doc!.id,
      returnNumber,
      refund: refund.toFixed(2),
      ...(tipRefund.gt(0) && { tipRefund: tipRefund.toFixed(2) }),
      ...(recalled > 0 && { kitchenItemsRecalled: recalled }),
      ...(runsEnded.length > 0 && { machineRunsEnded: runsEnded }),
      ...(sale.orderBillId && input.kind === 'VOID' && { orderBillId: sale.orderBillId, billReopened: reopened?.billReopened ?? false }),
      reason: input.reason,
      ...(wasteAdjustmentId && { wasteAdjustmentId }),
      ...(options.exchange && { exchange: true }),
      ...(creditCustomer && { refundTo: 'STORE_CREDIT', customerId: creditCustomer.id }),
      ...(creditBack.gt(0) && { storeCreditBack: creditBack.toFixed(2), customerId: sale.customerId }),
      ...(toFolio && { folioRefund: folioRefund.toFixed(2), folioId: toFolio.folio.id }),
    });
    await emitEvent(db, {
      tenantId,
      topic: input.kind === 'VOID' ? 'sale.voided' : 'sale.returned',
      payload: { saleId, saleReturnId: doc!.id, returnNumber },
      correlationId: auth.correlationId,
    });
    return doc!;
  }

  /**
   * The part of a refund that goes back to store credit (ADR-0018): the refund × (credit tendered ÷
   * amount paid), never more than the credit not given back yet by earlier returns of the sale (a return
   * refunded wholly as credit counts in full) nor more than what is refunded outside the folio. The
   * return that completes the sale gives back exactly the rest of the credit.
   */
  private async creditShare(db: Database, sale: typeof sales.$inferSelect, refund: Dec, rest: Dec, creditUsed: Dec) {
    const { rows: [before] } = await db.execute<{ refunded: string; credited: string }>(sql`
      SELECT coalesce(sum(r.amount_due), 0)::text AS refunded,
             coalesce((SELECT sum(c.amount) FROM customer_credit_entries c JOIN sale_returns x ON x.id = c.sale_return_id
                        WHERE x.sale_id = ${sale.id} AND c.kind = 'RETURN'), 0)::text AS credited
        FROM sale_returns r WHERE r.sale_id = ${sale.id}`);
    const left = Dec.max(creditUsed.minus(before!.credited), new Dec(0));
    const paid = toDec(sale.amountDue);
    const completes = toDec(before!.refunded).plus(refund).gte(paid);
    const share = completes || paid.isZero() ? left : Dec.min(left, roundTo(refund.times(creditUsed).dividedBy(paid), 2, 'HALF_UP'));
    return Dec.max(Dec.min(share, rest), new Dec(0));
  }

  /** The refund of a return of these lines, as recording it now would give (the exchange screen shows it first). */
  preview(auth: AuthContext, saleId: string, input: PreviewSaleReturnInput) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
      if (!sale) throw notFound('Sale');
      this.assertCan(auth, 'sales.refund', { legalEntityId: sale.legalEntityId, branchId: sale.branchId, registerId: sale.registerId });
      // The exchange screen asks first: refuse here what the exchange itself would refuse.
      assertExchangeable(await db.select({ method: saleTenders.method }).from(saleTenders).where(eq(saleTenders.saleId, saleId)));
      const { planned, totals } = await this.plan(db, sale, 'RETURN', input.lines, null);
      return {
        saleId,
        refund: totals.amountDue.toFixed(2),
        lines: planned.map((p) => ({ saleLineId: p.line.id, quantity: p.quantity.toString(), amountDue: p.amounts.amountDue.toFixed(2) })),
      };
    });
  }

  /**
   * What a void or return of these lines gives back, line by line and for the sale's charges
   * (prorated; the return that empties a line or the sale takes the exact remainder). Reads only:
   * shared by recording and by the preview the counter shows before an exchange.
   */
  private async plan(
    db: Database,
    sale: typeof sales.$inferSelect,
    kind: 'VOID' | 'RETURN',
    inputLines: CreateSaleReturnInput['lines'],
    /** The drawer's shift (a void must be in the sale's own shift); null for a preview. */
    sessionId: string | null,
  ) {
    const lines = await db
      .select({ line: saleLines, soldBy: products.soldBy, productType: products.productType, allowsFraction: unitsOfMeasure.allowsFraction })
      .from(saleLines)
      .innerJoin(productVariants, eq(productVariants.id, saleLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.uomId))
      .where(eq(saleLines.saleId, sale.id))
      .orderBy(saleLines.lineNo);
    const prior = await db.select().from(saleReturnLines).where(inArray(saleReturnLines.saleLineId, lines.map((l) => l.line.id)));
    const priorBy = new Map<string, { quantity: Dec; amounts: Amounts }>();
    for (const p of prior) {
      const acc = priorBy.get(p.saleLineId) ?? { quantity: new Dec(0), amounts: zero() };
      acc.quantity = acc.quantity.plus(p.quantity);
      for (const k of [...BUCKETS, 'amountDue'] as const) acc.amounts[k] = acc.amounts[k].plus(p[k]);
      priorBy.set(p.saleLineId, acc);
    }

    // Lines made from a recipe consumed their ingredients; cooked food never goes back on the shelf (ADR-0014 §4).
    // What left stock with the sale decides what goes back, not whether the item is tracked now:
    // a line with a SALE movement is restocked, one that consumed a recipe never is (ADR-0014 §4).
    const movedRows = await db
      .selectDistinct({ saleLineId: stockMovements.saleLineId, type: stockMovements.type })
      .from(stockMovements)
      .where(and(eq(stockMovements.saleId, sale.id), inArray(stockMovements.type, ['SALE', 'CONSUMPTION'])));
    const consumed = new Set(movedRows.filter((r) => r.type === 'CONSUMPTION').map((r) => r.saleLineId));
    const tookStock = new Set(movedRows.filter((r) => r.type === 'SALE').map((r) => r.saleLineId));

    let requested: { saleLineId: string; quantity: string; disposition: 'RESTOCK' | 'DAMAGED' }[];
    if (kind === 'VOID') {
      if (prior.length) throw new AppError('ALREADY_RETURNED', 'Part of this sale was already returned; use a return instead', HttpStatus.CONFLICT);
      if (sessionId !== null && sale.cashierSessionId !== sessionId) {
        throw unprocessable('VOID_OUTSIDE_SESSION', 'A sale can only be voided in the session that made it; use a return');
      }
      requested = lines.map((l) => ({ saleLineId: l.line.id, quantity: l.line.quantity, disposition: consumed.has(l.line.id) ? 'DAMAGED' : 'RESTOCK' }));
    } else {
      requested = inputLines!;
      const cooked = requested.find((r) => r.disposition === 'RESTOCK' && consumed.has(r.saleLineId));
      if (cooked) {
        throw unprocessable('NOT_RESTOCKABLE', 'This item was made from ingredients and cannot go back into stock; return it as damaged', { saleLineId: cooked.saleLineId });
      }
    }

    const rounding = ((sale.taxSnapshot as { roundingMode?: RoundingMode }).roundingMode ?? 'HALF_UP') as RoundingMode;
    const r2 = (d: Dec) => roundTo(d, 2, rounding);
    const totals = zero();
    const planned = await mapInSequence(requested, async (req) => {
      const found = lines.find((l) => l.line.id === req.saleLineId);
      if (!found) throw new AppError('NOT_FOUND', 'Sale line not found', HttpStatus.NOT_FOUND, { saleLineId: req.saleLineId });
      const sold = toDec(found.line.quantity);
      const before = priorBy.get(found.line.id) ?? { quantity: new Dec(0), amounts: zero() };
      const remaining = sold.minus(before.quantity);
      const q = toDec(req.quantity);
      // Packages and their sessions come back whole (ADR-0022 §6), whatever the unit allows.
      if ((found.productType === 'PACKAGE' || found.line.customerPackageId) && !q.isInteger()) {
        throw unprocessable('QUANTITY_NOT_ALLOWED', found.line.customerPackageId ? 'Package sessions are returned in whole sessions' : 'A package is returned in whole units', { saleLineId: req.saleLineId });
      }
      // Whole-unit items come back in whole units; a check's share of one (0.3333) comes back whole.
      if (found.soldBy === 'UNIT' && !found.allowsFraction && !q.isInteger() && !q.equals(remaining)) {
        throw unprocessable('QUANTITY_NOT_ALLOWED', 'This item is returned in whole units', { saleLineId: req.saleLineId });
      }
      if (q.gt(remaining)) {
        throw unprocessable('RETURN_EXCEEDS_SOLD', 'More than what is left to return on this line', { saleLineId: req.saleLineId, remaining: remaining.toString() });
      }
      const amounts = zero();
      const last = q.equals(remaining);
      for (const k of BUCKETS) {
        const lineValue = toDec(found.line[k]);
        // The final return of a line takes the exact remainder, so returns always sum to the sale.
        amounts[k] = last ? lineValue.minus(before.amounts[k]) : r2(lineValue.times(q).dividedBy(sold));
      }
      // A package line gives back exactly the recorded value of the packages that leave (ADR-0022 §6), so
      // Sales returns nets to zero against Prepaid service packages; the line's last return takes the rest.
      const packaged = found.productType === 'PACKAGE' && !last && q.gt(0) ? await packageReturnValue(db, found.line.id, q) : null;
      if (packaged) {
        const parts = splitByWeight(packaged, SALES_BUCKETS.map((k) => toDec(found.line[k])));
        for (const [i, k] of SALES_BUCKETS.entries()) amounts[k] = parts[i]!;
      }
      amounts.amountDue = amounts.vatableSales.plus(amounts.vatAmount).plus(amounts.vatExemptSales).plus(amounts.zeroRatedSales).plus(amounts.percentageTaxSales).minus(amounts.statutoryDiscount);
      for (const k of [...BUCKETS, 'amountDue'] as const) totals[k] = totals[k].plus(amounts[k]);
      return { req, line: found.line, trackInventory: tookStock.has(found.line.id), quantity: q, amounts };
    });

    // A charge (service charge) goes back in proportion to the items returned; the return that
    // empties the sale takes the exact remainder, so returns never give back more than was paid.
    const charges = await db.select().from(saleCharges).where(eq(saleCharges.saleId, sale.id));
    const chargeParts: { chargeId: string; amounts: Amounts }[] = [];
    if (charges.length) {
      const backBefore = await db.select().from(saleReturnCharges).where(inArray(saleReturnCharges.saleChargeId, charges.map((c) => c.id)));
      const allBack = lines.every((l) => {
        const q = planned.filter((p) => p.line.id === l.line.id).reduce((a, p) => a.plus(p.quantity), new Dec(0));
        return toDec(l.line.quantity).minus(priorBy.get(l.line.id)?.quantity ?? 0).minus(q).isZero();
      });
      const itemsDue = lines.reduce((a, l) => a.plus(l.line.amountDue), new Dec(0));
      const ratio = itemsDue.isZero() ? new Dec(0) : planned.reduce((a, p) => a.plus(p.amounts.amountDue), new Dec(0)).dividedBy(itemsDue);
      for (const c of charges) {
        const amounts = zero();
        for (const k of BUCKETS) {
          const before = backBefore.filter((b) => b.saleChargeId === c.id).reduce((a, b) => a.plus(b[k]), new Dec(0));
          amounts[k] = allBack ? toDec(c[k]).minus(before) : r2(toDec(c[k]).times(ratio));
        }
        amounts.amountDue = amounts.vatableSales.plus(amounts.vatAmount).plus(amounts.vatExemptSales).plus(amounts.zeroRatedSales).plus(amounts.percentageTaxSales).minus(amounts.statutoryDiscount);
        if (amounts.amountDue.isZero()) continue;
        for (const k of [...BUCKETS, 'amountDue'] as const) totals[k] = totals[k].plus(amounts[k]);
        chargeParts.push({ chargeId: c.id, amounts });
      }
    }

    return { planned, chargeParts, totals };
  }

  list(auth: AuthContext, saleId: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
      if (!sale) throw notFound('Sale');
      const scope = { legalEntityId: sale.legalEntityId, branchId: sale.branchId, registerId: sale.registerId };
      if (sale.cashierUserId !== auth.userId) this.assertCan(auth, 'sales.read', scope);
      const docs = await db.select().from(saleReturns).where(eq(saleReturns.saleId, saleId)).orderBy(saleReturns.createdAt, saleReturns.id);
      return { data: await mapInSequence(docs, (d) => this.view(db, d)) };
    });
  }

  /** The refund or void slip for a return document (printed at the counter), from its own records. */
  receipt(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [doc] = await db.select().from(saleReturns).where(eq(saleReturns.id, id));
      if (!doc) throw notFound('Return');
      const [sale] = await db.select().from(sales).where(eq(sales.id, doc.saleId));
      const scope = { legalEntityId: sale!.legalEntityId, branchId: sale!.branchId, registerId: sale!.registerId };
      if (sale!.cashierUserId !== auth.userId) this.assertCan(auth, 'sales.read', scope);
      const [[entity], [branch], [register], [person], lines] = await inSequence(
        () => db.select().from(legalEntities).where(eq(legalEntities.id, sale!.legalEntityId)),
        () => db.select().from(branches).where(eq(branches.id, sale!.branchId)),
        () => db.select().from(registers).where(eq(registers.id, sale!.registerId)),
        () => db.select({ displayName: users.displayName }).from(users).where(eq(users.id, doc.processedBy)),
        () => db.select({ r: saleReturnLines, name: saleLines.name, unitPrice: saleLines.unitPrice, vatTreatment: saleLines.vatTreatment })
          .from(saleReturnLines)
          .innerJoin(saleLines, eq(saleLines.id, saleReturnLines.saleLineId))
          .where(eq(saleReturnLines.saleReturnId, doc.id))
          .orderBy(saleLines.lineNo),
      );
      const snapshot = sale!.taxSnapshot as { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
      return buildReturnReceipt({
        invoicingMode: entity!.invoicingMode,
        seller: { registeredName: entity!.registeredName, tradeName: entity!.tradeName, registeredAddress: entity!.registeredAddress, tin: entity!.tin, vatStatus: snapshot.vatStatus },
        branch: { name: branch!.name, code: branch!.code, birBranchCode: branch!.birBranchCode, address: branch!.address, timezone: branch!.timezone },
        register: { code: register!.code, name: register!.name },
        processedBy: person?.displayName ?? 'Staff',
        sale: { saleNumber: sale!.saleNumber, registerCode: register!.code, vatRate: snapshot.vatRate, currency: sale!.currency },
        doc: { ...doc, kind: doc.kind as 'RETURN' | 'VOID' },
        lines: lines.map((l) => ({
          name: l.name,
          quantity: toDec(l.r.quantity).toString(),
          unitPrice: l.unitPrice,
          amountDue: l.r.amountDue,
          vatTreatment: l.vatTreatment,
          vatableSales: l.r.vatableSales,
          vatExemptSales: l.r.vatExemptSales,
          disposition: l.r.disposition,
        })),
        refunds: await this.refundParts(db, doc),
      });
    });
  }

  /**
   * How a refund was given back when it went more than one way: store credit (the sale's credit share,
   * ADR-0018), the guest's folio (ADR-0023) and cash for the rest. Empty when it went one way only.
   */
  private async refundParts(db: Database, doc: typeof saleReturns.$inferSelect) {
    const { rows: [r] } = await db.execute<{ credit: string; folio: string }>(sql`
      SELECT coalesce((SELECT sum(amount) FROM customer_credit_entries WHERE sale_return_id = ${doc.id} AND kind = 'RETURN'), 0)::text AS credit,
             coalesce((SELECT -sum(amount) FROM folio_entries WHERE sale_return_id = ${doc.id} AND kind = 'CHARGE_RETURN'), 0)::text AS folio`);
    const credit = toDec(r!.credit);
    const folio = toDec(r!.folio);
    const cash = toDec(doc.amountDue).minus(credit).minus(folio);
    const parts = [
      { method: 'STORE_CREDIT', amount: credit },
      { method: 'ROOM_CHARGE', amount: folio },
      { method: 'CASH', amount: cash },
    ].filter((p) => p.amount.gt(0));
    return parts.length > 1 ? parts.map((p) => ({ method: p.method, amount: p.amount.toFixed(2) })) : [];
  }

  /** One return or void by its own id (journal entries point here); same access as the sale's list. */
  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [doc] = await db.select().from(saleReturns).where(eq(saleReturns.id, id));
      if (!doc) throw notFound('Return');
      const [sale] = await db.select().from(sales).where(eq(sales.id, doc.saleId));
      const scope = { legalEntityId: sale!.legalEntityId, branchId: sale!.branchId, registerId: sale!.registerId };
      if (sale!.cashierUserId !== auth.userId) this.assertCan(auth, 'sales.read', scope);
      return this.view(db, doc);
    });
  }

  async view(db: Database, d: typeof saleReturns.$inferSelect) {
    const lines = await db.select().from(saleReturnLines).where(eq(saleReturnLines.saleReturnId, d.id));
    const money = (v: string) => toDec(v).toFixed(2);
    const fmt = <T extends Record<string, unknown>>(r: T) => {
      const o: Record<string, unknown> = { ...r };
      for (const k of [...BUCKETS, 'amountDue', 'tipRefund']) if (typeof o[k] === 'string') o[k] = money(o[k] as string);
      return o;
    };
    // A voided sale's card tip (session 25): given back by card or cash afterwards, or still pending.
    const [[cardTip], [given]] = d.kind === 'VOID'
      ? await inSequence(
          () => db.select({ amount: saleTips.amount }).from(saleTips).where(and(eq(saleTips.saleId, d.saleId), sql`${saleTips.method} <> 'CASH'`)),
          () => db.select({ method: saleTipRefunds.method, amount: saleTipRefunds.amount }).from(saleTipRefunds).where(eq(saleTipRefunds.saleReturnId, d.id)),
        )
      : [[], []];
    return {
      ...fmt(d),
      lines: lines.map((l) => ({ ...fmt(l), quantity: toDec(l.quantity).toString() })),
      cardTipRefund: given ? { method: given.method, amount: money(given.amount) } : null,
      refunds: await this.refundParts(db, d),
      tipRefundPending: Boolean(cardTip && !given),
    };
  }
}
