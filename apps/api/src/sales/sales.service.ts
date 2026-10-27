import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  desc,
  eq,
  saleBeneficiaries,
  customerCreditEntries,
  customers,
  saleCharges,
  saleLines,
  saleReturns,
  sales,
  saleTenders,
  branches,
  cashMovements,
  inArray,
  legalEntities,
  registers,
  users,
  paymentEvents,
  paymentIntents,
  promotions,
  sql,
  stockMovements,
  terminalTransactions,
  type Database,
  inSequence,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { OfflineFlag, OfflineSale } from '@1pos/sync-protocol';
import type { CreateExchangeInput, CreateSaleInput, SaleListQuery, TendersInput } from '@1pos/validation';
import { dbNow } from '../common/clock.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { readOnlyReason } from '../billing/entitlements.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { TaxService, unprocessable, type CartComputation } from '../tax/tax.service.js';
import { expectedCash, loadSession } from './cash.service.js';
import { ReturnsService } from './returns.service.js';
import { activeCustomer, creditBalance } from '../customers/customers.service.js';
import { buildReceipt } from './receipt.js';
import { nextNumber } from '../common/sequence.js';
import { salePosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
import { assertStockAvailable } from './stock-policy.js';
import { openPacksForSale } from '../inventory/packs.service.js';
import { assertNotExpired, expiredDraws, expiredStockRule } from '../inventory/expiry.js';

type SaleRow = typeof sales.$inferSelect;

/** Device clock drift an offline sale may show without being flagged CLOCK_ADJUSTED (ADR-0015 §5). */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

const fixed = (v: string) => toDec(v).toFixed(2);
/** Sales a `GET /v1/sales` request examines at most while filling a page with what the caller may read. */
const LIST_SCAN_LIMIT = 2000;
const MONEY_FIELDS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue',
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];
type Buckets = Record<MoneyField, string>;

const pick = (src: { [K in MoneyField]: unknown }): Buckets => Object.fromEntries(MONEY_FIELDS.map((k) => [k, String(src[k])])) as Buckets;
/** Ex-VAT sales of a bucket set (what revenue is credited with). */
const exVat = (b: Buckets) => toDec(b.vatableSales).plus(b.vatExemptSales).plus(b.zeroRatedSales).plus(b.percentageTaxSales);

/** A line ready to be recorded, from the tax path. */
interface RecordLine extends Buckets {
  clientLineId: string;
  variantId: string;
  sku: string;
  name: string;
  taxCategoryCode: string;
  vatTreatment: string;
  quantity: string;
  unitPrice: string;
  priceIncludesTax: boolean;
  priceId: string;
  priceListId: string;
  trackInventory: boolean;
  beneficiaryRef: string | null;
  schemeShare: string | null;
  snapshot: unknown;
  /** An approved price change (session 20). */
  priceOverrideId?: string | null;
  /** The promotion that priced it (ADR-0021). */
  promotionId?: string | null;
}

/** Everything priced and taxed; recording adds tenders, numbers, stock, books, audit and outbox. */
interface PricedSale {
  legalEntityId: string;
  currency: string;
  taxProfileId: string;
  taxSnapshot: unknown;
  requiresProfessionalReview: boolean;
  /** Header: Σ lines. */
  totals: Buckets;
  lines: RecordLine[];
  beneficiaries: { ref: string; schemeCode: string; schemeVersion: number; name: string; idNumber: string; tin: string | null }[];
  /** A sale rung up offline and recorded at sync (ADR-0015 §5). */
  offline?: { terminalId: string; reference: string; flags: OfflineFlag[]; completedAt: Date };
  /** The customer it was rung up for (ADR-0018); needed to pay with store credit. */
  customerId?: string | null;
  /**
   * A counter sale: refused when the branch's negative-stock policy is BLOCK and a tracked item would
   * go below zero. Offline sales (already handed over) are never refused for stock; the costing
   * trigger flags them instead.
   */
  enforceStock?: boolean;
}

/** What a terminal's offline sale needs besides the envelope: who sent it and what it had been told. */
export interface OfflineContext {
  terminalId: string;
  registerId: string;
  snapshotAsOf: Date;
  /** The business could write when the snapshot was issued (`terminal_snapshots.business_writable`). */
  snapshotWritable: boolean;
  windowHours: number;
  /** The quarantined delivery being retried, if any (it becomes RECORDED with the sale). */
  quarantinedId?: string;
  /** Rung up under a terminal since revoked, delivered by its replacement on the same register (audited). */
  recoveredFrom?: string;
  payload: unknown;
  payloadHash: string;
}


/** What a priced line was asked with: its SC/PWD beneficiary, if any. */
type LineAsked = { variantId: string; statutory?: { beneficiary?: string } | undefined };

/** A cart from the tax path, ready to record (counter checkout and offline sales). `lines` are the lines the cart was computed from. */
function pricedFromCart(cart: CartComputation, lines: LineAsked[], beneficiaries: CreateSaleInput['beneficiaries']): PricedSale {
  return {
    legalEntityId: cart.legalEntityId,
    currency: cart.currency,
    taxProfileId: cart.taxProfile.id,
    taxSnapshot: cart.taxProfile,
    requiresProfessionalReview: cart.requiresProfessionalReview,
    totals: pick(cart.totals),
    lines: cart.lines.map((l, i) => {
      const statutory = lines[i]!.statutory;
      return {
        ...pick(l),
        clientLineId: l.id,
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        taxCategoryCode: l.taxCategoryCode,
        vatTreatment: l.vatTreatment,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceIncludesTax: l.priceIncludesTax,
        priceId: l.priceId,
        priceListId: l.priceListId,
        trackInventory: l.trackInventory,
        beneficiaryRef: statutory?.beneficiary ?? null,
        schemeShare: statutory ? (l.snapshot.scheme?.share ?? '1') : null,
        snapshot: l.snapshot,
        priceOverrideId: l.priceOverrideId,
        promotionId: l.promotionId,
      };
    }),
    beneficiaries: beneficiaries.map((b) => {
      const scheme = cart.lines.find((_, i) => lines[i]!.statutory?.beneficiary === b.ref)!.snapshot.scheme!;
      return { ref: b.ref, schemeCode: scheme.code, schemeVersion: scheme.version, name: b.name, idNumber: b.idNumber, tin: b.tin ?? null };
    }),
  };
}

/** The names of the promotions that priced these lines (ADR-0021). */
async function promotionNames(db: Database, lines: { promotionId: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(lines.flatMap((l) => (l.promotionId ? [l.promotionId] : [])))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: promotions.id, name: promotions.name }).from(promotions).where(inArray(promotions.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

@Injectable()
export class SalesService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    sales_register_client_tx_unique: ['DUPLICATE_TRANSACTION', 'This register already recorded a sale with this transaction id'],
    terminal_transactions_txn_unique: ['DUPLICATE_TRANSACTION', 'This terminal already delivered this transaction'],
    sale_lines_price_override_once: ['PRICE_OVERRIDE_USED', 'This approved price was already used on a sale'],
    sale_tenders_exchange_once: ['ALREADY_EXCHANGED', 'This return already paid for an exchange'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
  ) {
    super(tenantDb);
  }

  /** A counter cart priced on the tax path, SC/PWD as asked. */
  private async priceCounterCart(db: Database, auth: AuthContext, branchId: string, sale: Pick<CreateSaleInput, 'lines' | 'beneficiaries'>) {
    const cart = await this.tax.computeCart(db, auth, {
      branchId,
      lines: sale.lines.map(({ statutory, ...l }) => ({
        ...l,
        ...(statutory && { statutory: { scheme: statutory.scheme, ...(statutory.share && { share: statutory.share }) } }),
      })),
    });
    return pricedFromCart(cart, sale.lines, sale.beneficiaries);
  }

  /**
   * Checkout (SPEC §checkout workflow). One transaction: lock the session, recompute prices and
   * taxes on the server, number the sale, write sale + lines + tenders + cash and stock movements +
   * books + audit + outbox. Any refusal leaves nothing behind; the required Idempotency-Key makes
   * retries return the original sale.
   */
  create(auth: AuthContext, input: CreateSaleInput) {
    return this.mutate(auth, async (db) => {
      const session = await this.checkoutSession(db, auth, input.cashierSessionId, input.clientTransactionId);
      const customerId = input.customerId ? (await activeCustomer(db, input.customerId)).id : null;
      const priced = { ...(await this.priceCounterCart(db, auth, session.branchId, input)), enforceStock: true, customerId };
      const sale = await this.record(db, auth, session, input, priced);
      return this.view(db, sale);
    });
  }

  /**
   * An exchange (SPEC §6.3, session 20): a return of lines of an earlier sale and a new sale, in one
   * transaction on the cashier's own shift. The refund is tendered first on the new sale as cash
   * (`sale_tenders.exchange_return_id`); the customer pays the rest with `sale.tenders`, or takes the
   * difference back as change. Both documents move the drawer as they always do (REFUND out, SALE in),
   * so the drawer, the books and every report net to the cash that really changed hands, and the
   * return and the sale stay ordinary documents (their own numbers, postings and slips).
   */
  exchange(auth: AuthContext, input: CreateExchangeInput) {
    return this.mutate(auth, async (db) => {
      const session = await this.checkoutSession(db, auth, input.cashierSessionId, input.sale.clientTransactionId);
      const back = await this.returns.record(db, auth, input.saleId, {
        cashierSessionId: session.id, kind: 'RETURN', reason: input.reason, lines: input.returnLines, refundTo: 'CASH',
        ...(input.expectedRefund !== undefined && { expectedRefund: input.expectedRefund }),
      }, { exchange: true });
      const customerId = input.sale.customerId ? (await activeCustomer(db, input.sale.customerId)).id : null;
      const priced = { ...(await this.priceCounterCart(db, auth, session.branchId, input.sale)), enforceStock: true, customerId };
      const refund = toDec(back.amountDue);
      const sale = await this.record(db, auth, session, input.sale, priced, refund.gt(0) ? { saleReturnId: back.id, amount: refund.toString() } : undefined);
      // The refund went out before the new sale came in: only the net may not exceed the drawer.
      const drawer = toDec(await expectedCash(db, session.id));
      if (drawer.lt(0)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the difference', { shortBy: drawer.negated().toFixed(2) });
      await this.audit(db, auth, 'sale.exchanged', 'sale', sale.id, { originalSaleId: input.saleId, saleReturnId: back.id, returnNumber: back.returnNumber, refund: refund.toFixed(2), amountDue: toDec(sale.amountDue).toFixed(2) });
      return { sale: await this.view(db, sale), saleReturn: await this.returns.view(db, back) };
    });
  }

  /**
   * An offline cash sale delivered by its terminal (ADR-0015 §5), recorded as the shift's cashier
   * (`auth`). Re-priced as of the terminal's snapshot, so the server reproduces the total the terminal
   * charged or refuses (TOTAL_MISMATCH); flagged, never refused, when prices moved meanwhile, the
   * snapshot had expired or the device clock was off. The delivery row (RECORDED) commits with the sale.
   * Any refusal leaves nothing; the caller quarantines the envelope.
   *
   * A business that has since lapsed or been suspended (session 21 decision): the sale is still recorded
   * when its snapshot was issued while the business could write and it was rung within that snapshot's
   * window, so a till that was offline at the moment of the lapse loses nothing. Anything else is refused
   * with the business's read-only reason. Such a sale is audited (`offline_sale.recorded_while_read_only`).
   */
  recordOffline(auth: AuthContext, env: OfflineSale, ctx: OfflineContext) {
    return this.mutate(auth, async (db) => {
      const readOnly = await readOnlyReason(db, tenantOf(auth).status);
      if (readOnly && !ctx.snapshotWritable) throw readOnly;
      const session = await this.checkoutSession(db, auth, env.cashierSessionId, env.terminalTxnId);
      if (session.registerId !== ctx.registerId) {
        throw new AppError('WRONG_REGISTER', 'This shift is on another register than the terminal', HttpStatus.CONFLICT);
      }
      const cartAt = (at: Date, knownAt?: Date) =>
        this.tax.computeCart(db, auth, { branchId: session.branchId, lines: env.lines }, at, knownAt && { knownAt });
      // As the snapshot held it: a price or promotion made later (even back-dated within the minute
      // allowed) was not on the till (audit 2026-10-21); it still flags PRICE_CHANGED below.
      const cart = await cartAt(ctx.snapshotAsOf, ctx.snapshotAsOf);

      const flags: OfflineFlag[] = [];
      const now = await dbNow(db);
      const occurred = new Date(env.occurredAt);
      const completedAt = new Date(Math.min(Math.max(occurred.getTime(), session.openedAt.getTime()), now.getTime()));
      // Clamped always; flagged when the device clock was off by more than ordinary drift.
      // So is a sale the till says it rang before it was given the snapshot it was priced from (impossible
      // with an honest clock; the device time is kept as it is clamped, the flag tells a person to look).
      if (Math.abs(completedAt.getTime() - occurred.getTime()) > CLOCK_TOLERANCE_MS || occurred.getTime() < ctx.snapshotAsOf.getTime() - CLOCK_TOLERANCE_MS) {
        flags.push('CLOCK_ADJUSTED');
      }
      // Prices or the tax profile that were in force when the sale happened, if the terminal could not know them.
      const then = await cartAt(completedAt).catch(() => null);
      const sameAsThen = then && then.taxProfile.id === cart.taxProfile.id && then.lines.every((l, i) => l.priceId === cart.lines[i]!.priceId && l.promotionId === cart.lines[i]!.promotionId);
      if (!sameAsThen) flags.push('PRICE_CHANGED');
      if (completedAt.getTime() > ctx.snapshotAsOf.getTime() + ctx.windowHours * 3_600_000) flags.push('SNAPSHOT_EXPIRED');
      if (readOnly && flags.includes('SNAPSHOT_EXPIRED')) throw readOnly;

      const priced = pricedFromCart(cart, env.lines, []);
      priced.offline = { terminalId: ctx.terminalId, reference: env.localReference, flags, completedAt };
      let sale: SaleRow;
      try {
        sale = await this.record(db, auth, session, { clientTransactionId: env.terminalTxnId, tenders: env.tenders, expectedAmountDue: env.amountDue }, priced);
      } catch (e) {
        if (e instanceof AppError && e.code === 'TOTAL_CHANGED') {
          throw new AppError('TOTAL_MISMATCH', 'The terminal charged a different total than its snapshot gives', HttpStatus.CONFLICT, {
            charged: toDec(env.amountDue).toFixed(2), expected: toDec(priced.totals.amountDue).toFixed(2),
          });
        }
        throw e;
      }
      if (ctx.quarantinedId) {
        await db.update(terminalTransactions)
          .set({ status: 'RECORDED', saleId: sale.id, errorCode: null, errorDetail: null, attempts: sql`${terminalTransactions.attempts} + 1`, resolvedAt: sql`now()`, resolvedBy: auth.userId })
          .where(eq(terminalTransactions.id, ctx.quarantinedId));
      } else {
        await db.insert(terminalTransactions).values({
          tenantId: tenantOf(auth).tenantId, terminalId: ctx.terminalId, terminalTxnId: env.terminalTxnId, deviceSeq: env.deviceSeq,
          payload: ctx.payload, payloadHash: ctx.payloadHash, cashierSessionId: session.id, status: 'RECORDED', saleId: sale.id,
        });
      }
      if (ctx.recoveredFrom) {
        await this.audit(db, auth, 'offline_sale.recovered', 'sale', sale.id, {
          terminalId: ctx.terminalId, revokedTerminalId: ctx.recoveredFrom, localReference: env.localReference,
        });
      }
      if (readOnly) {
        await this.audit(db, auth, 'offline_sale.recorded_while_read_only', 'sale', sale.id, {
          terminalId: ctx.terminalId, reason: readOnly.code, snapshotAsOf: ctx.snapshotAsOf.toISOString(), localReference: env.localReference,
        });
      }
      const [reg] = await db.select({ code: registers.code }).from(registers).where(eq(registers.id, session.registerId));
      return { saleId: sale.id, saleNumber: sale.saleNumber, reference: `${reg!.code}-${String(sale.saleNumber).padStart(6, '0')}`, flags };
    }, { allowReadOnlyBusiness: ctx.snapshotWritable });
  }

  /** The calendar date of an instant in the branch's timezone (DB arithmetic). */
  private async localDate(db: Database, branchId: string, at: Date) {
    const { rows } = await db.execute<{ d: string }>(sql`
      SELECT (${at.toISOString()}::timestamptz AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id = ${branchId}`);
    return rows[0]!.d;
  }

  /** Lock the session, check who may sell on it, and refuse a transaction id the register already used. */
  private async checkoutSession(db: Database, auth: AuthContext, sessionId: string, clientTransactionId: string) {
    const { session, scope } = await loadSession(db, sessionId, true);
    this.assertCan(auth, 'sales.create', scope);
    if (session.openedBy !== auth.userId) {
      throw new AppError('NOT_SESSION_OWNER', 'Sell on your own cashier session', HttpStatus.FORBIDDEN);
    }
    // A resubmit under a new key (e.g. after an unanswered request) points at the recorded sale,
    // so the counter can show its receipt instead of ringing it again. The unique index still
    // catches a concurrent duplicate (conflict map above).
    const [recorded] = await db
      .select({ id: sales.id, saleNumber: sales.saleNumber })
      .from(sales)
      .where(and(eq(sales.registerId, session.registerId), eq(sales.clientTransactionId, clientTransactionId)));
    if (recorded) {
      throw new AppError('DUPLICATE_TRANSACTION', 'This register already recorded a sale with this transaction id', HttpStatus.CONFLICT, {
        saleId: recorded.id,
        saleNumber: recorded.saleNumber,
      });
    }
    if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
    return session;
  }

  /**
   * Record a priced sale in the caller's transaction: stale-total and review gates, tenders (intents
   * first, cash covers the rest), number, sale + beneficiaries + lines + tenders, cash movement, stock
   * (SALE for tracked items, packs it opens), one journal entry, audit and outbox.
   */
  private async record(
    db: Database,
    auth: AuthContext,
    session: Awaited<ReturnType<typeof loadSession>>['session'],
    input: { clientTransactionId: string; tenders: TendersInput; expectedAmountDue?: string | undefined },
    priced: PricedSale,
    /** An exchange: the refund of this return, tendered as cash before anything the customer pays. */
    exchangeCredit?: { saleReturnId: string; amount: string },
  ): Promise<SaleRow> {
    const tenantId = tenantOf(auth).tenantId;
    const due = toDec(priced.totals.amountDue);
    if (input.expectedAmountDue !== undefined && !toDec(input.expectedAmountDue).equals(due)) {
      throw new AppError('TOTAL_CHANGED', 'Prices or taxes changed since the cart was shown; review the new total', HttpStatus.CONFLICT, {
        amountDue: due.toFixed(2),
      });
    }
    if (priced.requiresProfessionalReview && this.env.NODE_ENV === 'production') {
      throw unprocessable('SCHEME_PENDING_REVIEW', 'Statutory discounts are disabled until a tax professional signs off the computation (ADR-0008)');
    }

    // Non-cash tenders: authorized payment intents of this checkout, locked and applied first (ADR-0010).
    const intentIds = input.tenders.flatMap((t) => (t.method === 'INTENT' ? [t.paymentIntentId] : []));
    if (new Set(intentIds).size !== intentIds.length) throw unprocessable('DUPLICATE_TENDER', 'A payment can be tendered once');
    const intents = intentIds.length
      ? await db.select().from(paymentIntents).where(inArray(paymentIntents.id, intentIds)).for('update')
      : [];
    for (const pid of intentIds) {
      const p = intents.find((x) => x.id === pid);
      if (!p) throw new AppError('NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND, { paymentIntentId: pid });
      if (p.saleId) throw new AppError('PAYMENT_CONSUMED', 'This payment already paid for another sale', HttpStatus.CONFLICT, { paymentIntentId: pid });
      if (p.status !== 'SUCCEEDED') {
        throw new AppError('PAYMENT_NOT_SUCCEEDED', `This payment is ${p.status.toLowerCase()}`, HttpStatus.CONFLICT, { paymentIntentId: pid, status: p.status });
      }
      if (p.cashierSessionId !== session.id || p.clientTransactionId !== input.clientTransactionId || p.currency !== priced.currency) {
        throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken for a different checkout', { paymentIntentId: pid });
      }
      // A payment of a feature no longer offered (a folio or a down payment, before 0110–0111) never pays for a sale.
      if (p.purpose !== 'SALE') throw unprocessable('PAYMENT_NOT_FOR_SALE', 'This payment was not taken for a sale', { paymentIntentId: pid });
    }
    const electronic = intents.reduce((a, p) => a.plus(p.amount), new Dec(0));
    if (electronic.gt(due)) throw unprocessable('OVERPAYMENT', 'Card/QR payments exceed the total; cancel one and take the exact amount', { amountDue: due.toFixed(2) });

    // Store credit (ADR-0018) next: the customer's balance with this legal entity, never more than is left to pay.
    const creditTender = input.tenders.find((t): t is Extract<TendersInput[number], { method: 'STORE_CREDIT' }> => t.method === 'STORE_CREDIT');
    const storeCredit = creditTender ? toDec(creditTender.amount) : new Dec(0);
    if (creditTender) {
      if (!priced.customerId) throw unprocessable('STORE_CREDIT_NEEDS_CUSTOMER', 'Store credit needs the customer on the sale');
      if (storeCredit.gt(due.minus(electronic))) throw unprocessable('OVERPAYMENT', 'Store credit is more than what is left to pay', { amountDue: due.minus(electronic).toFixed(2) });
      // One redemption per customer at a time (the insert trigger takes the same lock and re-checks).
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${priced.customerId}:${priced.legalEntityId}`}, 0))`);
      const balance = await creditBalance(db, priced.customerId, priced.legalEntityId);
      if (balance.lt(storeCredit)) throw new AppError('INSUFFICIENT_STORE_CREDIT', 'The customer has less store credit than that', HttpStatus.CONFLICT, { balance: balance.toFixed(2) });
    }

    // Cash covers the rest; only the last cash tender may give change.
    let remaining = due.minus(electronic).minus(storeCredit);
    const cashTenders: { t: { tendered: string }; i: number; exchangeReturnId?: string }[] = [
      ...(exchangeCredit ? [{ t: { tendered: exchangeCredit.amount }, i: -1, exchangeReturnId: exchangeCredit.saleReturnId }] : []),
      ...input.tenders.flatMap((t, i) => (t.method === 'CASH' ? [{ t, i }] : [])),
    ];
    const cash = cashTenders.map(({ t, i, exchangeReturnId }) => {
      if (remaining.isZero() && !due.isZero()) throw unprocessable('UNNECESSARY_TENDER', 'The sale is already paid', { tender: i });
      const tendered = toDec(t.tendered);
      const applied = Dec.min(tendered, remaining);
      remaining = remaining.minus(applied);
      return { tendered, applied, change: tendered.minus(applied), exchangeReturnId: exchangeReturnId ?? null };
    });
    if (remaining.gt(0)) throw unprocessable('INSUFFICIENT_TENDER', 'The tendered amount does not cover the total', { amountDue: due.toFixed(2) });
    if (cash.slice(0, -1).some((t) => t.change.gt(0))) throw unprocessable('UNNECESSARY_TENDER', 'Only the last tender may give change');
    const cashApplied = cash.reduce((a, t) => a.plus(t.applied), new Dec(0));
    const tendered = cash.reduce((a, t) => a.plus(t.tendered), electronic.plus(storeCredit));
    const change = tendered.minus(due);

    const saleNumber = await nextNumber(db, tenantId, session.registerId, 'SALE');
    const [sale] = await db
      .insert(sales)
      .values({
        tenantId,
        legalEntityId: priced.legalEntityId,
        branchId: session.branchId,
        registerId: session.registerId,
        cashierSessionId: session.id,
        cashierUserId: auth.userId,
        clientTransactionId: input.clientTransactionId,
        saleNumber,
        currency: priced.currency,
        taxProfileId: priced.taxProfileId,
        ...priced.totals,
        amountTendered: tendered.toString(),
        changeDue: change.toString(),
        requiresProfessionalReview: priced.requiresProfessionalReview,
        taxSnapshot: priced.taxSnapshot,
        customerId: priced.customerId ?? null,
        ...(priced.offline && {
          origin: 'OFFLINE',
          terminalId: priced.offline.terminalId,
          offlineReference: priced.offline.reference,
          offlineFlags: priced.offline.flags,
          completedAt: priced.offline.completedAt,
        }),
      })
      .returning();

    const beneficiaryIds = new Map<string, string>();
    for (const b of priced.beneficiaries) {
      const [row] = await db
        .insert(saleBeneficiaries)
        .values({ tenantId, saleId: sale!.id, schemeCode: b.schemeCode, schemeVersion: b.schemeVersion, name: b.name, idNumber: b.idNumber, tin: b.tin })
        .returning({ id: saleBeneficiaries.id });
      beneficiaryIds.set(b.ref, row!.id);
    }

    const lineRows = priced.lines.map((l, i) =>
      ({
        tenantId,
        saleId: sale!.id,
        lineNo: i + 1,
        clientLineId: l.clientLineId,
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        taxCategoryCode: l.taxCategoryCode,
        vatTreatment: l.vatTreatment,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceIncludesTax: l.priceIncludesTax,
        priceId: l.priceId,
        priceListId: l.priceListId,
        ...pick(l),
        beneficiaryId: l.beneficiaryRef ? beneficiaryIds.get(l.beneficiaryRef)! : null,
        schemeShare: l.schemeShare,
        taxSnapshot: l.snapshot,
        priceOverrideId: l.priceOverrideId ?? null,
        promotionId: l.promotionId ?? null,
      }) as typeof saleLines.$inferInsert);
    const lineIds: string[] = [];
    for (const r of await db.insert(saleLines).values(lineRows).returning({ id: saleLines.id, lineNo: saleLines.lineNo })) lineIds[r.lineNo - 1] = r.id;
    const tenderRows = [
      ...intents.map((p) => ({ tenantId, saleId: sale!.id, method: p.method, paymentIntentId: p.id, amount: p.amount, tendered: p.amount, change: '0' })),
      ...(creditTender ? [{ tenantId, saleId: sale!.id, method: 'STORE_CREDIT', amount: storeCredit.toString(), tendered: storeCredit.toString(), change: '0' }] : []),
      ...cash.map((t) => ({ tenantId, saleId: sale!.id, method: 'CASH', amount: t.applied.toString(), tendered: t.tendered.toString(), change: t.change.toString(), exchangeReturnId: t.exchangeReturnId })),
    ];
    // A sale of nothing but zero-priced lines has nothing to tender.
    if (tenderRows.length) await db.insert(saleTenders).values(tenderRows);
    for (const p of intents) {
      await db.update(paymentIntents).set({ saleId: sale!.id }).where(eq(paymentIntents.id, p.id));
      await db.insert(paymentEvents).values({ tenantId, paymentIntentId: p.id, type: 'CONSUMED', detail: { saleId: sale!.id }, createdBy: auth.userId });
    }
    if (creditTender) {
      await db.insert(customerCreditEntries).values({
        tenantId, legalEntityId: priced.legalEntityId, branchId: session.branchId, customerId: priced.customerId!, kind: 'REDEEM',
        amount: storeCredit.negated().toString(), saleId: sale!.id, createdBy: auth.userId,
      });
    }
    // Net cash into the drawer = the cash part of the sale (tendered minus change).
    if (cash.length) {
      await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'SALE', amount: cashApplied.toString(), saleId: sale!.id, createdBy: auth.userId });
    }
    const stock: (typeof stockMovements.$inferInsert & { variantId: string })[] = priced.lines.flatMap((l, i) =>
      l.trackInventory
        ? [{ tenantId, branchId: session.branchId, variantId: l.variantId, quantity: toDec(l.quantity).negated().toString(), type: 'SALE', saleId: sale!.id, saleLineId: lineIds[i]!, createdBy: auth.userId }]
        : [],
    );
    // Tingi (ADR-0020): pieces this sale needs and does not have come out of packs it opens itself.
    const entryDate = priced.offline ? await this.localDate(db, session.branchId, priced.offline.completedAt) : undefined;
    // Only a sale that moves stock asks the branch's expired-stock rule.
    const expiredRule = stock.length ? await expiredStockRule(db, session.branchId) : 'ALLOW';
    const opened = await openPacksForSale(
      db,
      { tenantId, branchId: session.branchId, legalEntityId: priced.legalEntityId, userId: auth.userId, saleId: sale!.id, saleNumber: String(saleNumber), ...(entryDate && { entryDate }) },
      stock.map((m) => ({ variantId: m.variantId, quantity: toDec(m.quantity).negated().toString() })),
      { sellableOnly: !priced.offline, expired: expiredRule === 'BLOCK' },
    );
    // Held lots are never sold online, expired ones not where the branch blocks them; offline sales are flagged instead.
    if (!priced.offline) {
      await assertNotExpired(db, session.branchId, priced.lines.flatMap((l) => (l.trackInventory ? [{ variantId: l.variantId, quantity: l.quantity, name: l.name }] : [])), expiredRule);
    }
    if (priced.enforceStock) {
      await assertStockAvailable(db, session.branchId, priced.lines.flatMap((l) => (l.trackInventory ? [{ variantId: l.variantId, quantity: l.quantity, name: l.name }] : [])));
    }
    // Sorted by variant: concurrent sales lock balance rows in the same order (ADR-0012 §7).
    const moved = stock.length
      ? await db.insert(stockMovements).values(stock.sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))).returning({ value: stockMovements.value })
      : [];
    const expiredOut = expiredRule === 'BLOCK' && stock.length ? await expiredDraws(db, sale!.id) : [];
    if (expiredOut.length) {
      await emitEvent(db, { tenantId, topic: 'stock.expired_sold', payload: { saleId: sale!.id, branchId: session.branchId, lots: expiredOut.length }, correlationId: auth.correlationId });
    }

    // Books (ADR-0013): money in, revenue, output VAT, COGS at the ledger's cost — same transaction.
    await post(db, {
      tenantId,
      legalEntityId: priced.legalEntityId,
      branchId: session.branchId,
      sourceType: 'SALE',
      sourceId: sale!.id,
      memo: priced.offline ? `Sale #${saleNumber} (offline ${priced.offline.reference})` : `Sale #${saleNumber}`,
      // An offline sale is booked on the day it happened, in the branch's calendar.
      ...(entryDate && { entryDate }),
      lines: salePosting({
        salesExVat: exVat(priced.totals),
        vatAmount: priced.totals.vatAmount,
        statutoryDiscount: priced.totals.statutoryDiscount,
        cash: cashApplied,
        electronic,
        storeCredit,
        cogs: moved.reduce((a, m) => a.minus(m.value), new Dec(0)),
      }, session.branchId),
      createdBy: auth.userId,
    });

    await this.audit(db, auth, 'sale.completed', 'sale', sale!.id, {
      saleNumber, amountDue: due.toFixed(2), registerId: session.registerId,
      ...(priced.customerId && { customerId: priced.customerId }),
      ...(creditTender && { storeCredit: storeCredit.toFixed(2) }),
      ...(opened.length > 0 && { packOpenings: opened.map((o) => o.id) }),
      ...(expiredOut.length > 0 && { expiredStockLots: expiredOut.length }),
      ...(priced.offline && { origin: 'OFFLINE', terminalId: priced.offline.terminalId, offlineReference: priced.offline.reference, flags: priced.offline.flags }),
    });
    await emitEvent(db, {
      tenantId,
      topic: 'sale.completed',
      payload: { saleId: sale!.id, registerId: session.registerId, branchId: session.branchId, saleNumber },
      correlationId: auth.correlationId,
    });
    return sale!;
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, id));
      if (!sale) throw notFound('Sale');
      this.assertCanRead(auth, sale);
      return this.view(db, sale);
    });
  }

  /** Receipt data (not an invoice while invoicing is DISABLED), built from the sale's own snapshot. */
  receipt(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, id));
      if (!sale) throw notFound('Sale');
      this.assertCanRead(auth, sale);
      const [[entity], [branch], [register], [cashier], lines, tenders, beneficiaries, charges] = await inSequence(
        () => db.select().from(legalEntities).where(eq(legalEntities.id, sale.legalEntityId)),
        () => db.select().from(branches).where(eq(branches.id, sale.branchId)),
        () => db.select().from(registers).where(eq(registers.id, sale.registerId)),
        () => db.select({ displayName: users.displayName }).from(users).where(eq(users.id, sale.cashierUserId)),
        () => db.select().from(saleLines).where(eq(saleLines.saleId, id)).orderBy(saleLines.lineNo),
        () => db.select().from(saleTenders).where(eq(saleTenders.saleId, id)).orderBy(saleTenders.createdAt, saleTenders.id),
        () => db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, id)),
        () => db.select().from(saleCharges).where(eq(saleCharges.saleId, id)),
      );
      const [customer] = sale.customerId ? await db.select({ name: customers.displayName, tin: customers.tin }).from(customers).where(eq(customers.id, sale.customerId)) : [];
      const exchangeIds = tenders.flatMap((t) => (t.exchangeReturnId ? [t.exchangeReturnId] : []));
      const exchanged = exchangeIds.length ? await db.select({ id: saleReturns.id, returnNumber: saleReturns.returnNumber }).from(saleReturns).where(inArray(saleReturns.id, exchangeIds)) : [];
      const snapshot = sale.taxSnapshot as { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
      const promos = await promotionNames(db, lines);
      // The expiry lots each line was drawn from (ADR-0020 §3, ADR-0025 §5).
      const { rows: lotRows } = await db.execute<{ sale_line_id: string; lot_code: string | null; expires_on: string }>(sql`
        SELECT m.sale_line_id, l.lot_code, l.expires_on::text FROM stock_movements m
          JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id
          JOIN stock_lots l ON l.tenant_id = lm.tenant_id AND l.id = lm.lot_id
         WHERE m.sale_id = ${id} AND m.type = 'SALE' GROUP BY 1, 2, 3 ORDER BY 3, 2`);
      return buildReceipt({
        invoicingMode: entity!.invoicingMode,
        seller: { registeredName: entity!.registeredName, tradeName: entity!.tradeName, registeredAddress: entity!.registeredAddress, tin: entity!.tin, vatStatus: snapshot.vatStatus },
        branch: { name: branch!.name, code: branch!.code, birBranchCode: branch!.birBranchCode, address: branch!.address, timezone: branch!.timezone },
        register: { code: register!.code, name: register!.name },
        cashierName: cashier?.displayName ?? 'Cashier',
        sale: {
          ...Object.fromEntries([...MONEY_FIELDS, 'amountTendered', 'changeDue'].map((k) => [k, fixed(sale[k as keyof SaleRow] as string)])),
          saleNumber: sale.saleNumber,
          completedAt: sale.completedAt,
          currency: sale.currency,
          vatRate: snapshot.vatRate,
        } as Parameters<typeof buildReceipt>[0]['sale'],
        lines: lines.map((l) => ({
          name: l.name,
          quantity: toDec(l.quantity).toString(),
          unitPrice: l.unitPrice,
          gross: l.gross,
          discount: l.discount,
          statutoryDiscount: l.statutoryDiscount,
          vatTreatment: l.vatTreatment,
          vatableSales: l.vatableSales,
          vatExemptSales: l.vatExemptSales,
          beneficiaryId: l.beneficiaryId,
          isChoice: l.parentLineId !== null,
          promotion: l.promotionId ? (promos.get(l.promotionId) ?? null) : null,
          lots: lotRows.filter((r) => r.sale_line_id === l.id).map((r) => ({ lotCode: r.lot_code, expiresOn: r.expires_on })),
        })),
        tenders: tenders.map((t) => ({
          method: t.method, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change),
          exchangeReturnNumber: t.exchangeReturnId ? (exchanged.find((r) => r.id === t.exchangeReturnId)?.returnNumber ?? null) : null,
        })),
        beneficiaries,
        charges: charges.map((c) => ({ kind: c.kind, rate: toDec(c.rate).toString(), gross: c.gross, amountDue: c.amountDue, vatTreatment: c.vatTreatment })),
        customer: customer ?? null,
      });
    });
  }

  list(auth: AuthContext, q: SaleListQuery) {
    return this.read(auth, async (db) => {
      // What the caller may read depends on scoped grants (or being the sale's cashier), so rows are
      // filtered here, a batch at a time until the page is full. The cursor is the last row examined,
      // never one past a row left out, so pages neither repeat nor skip; each request examines at most
      // LIST_SCAN_LIMIT rows (a short page with a cursor then just means "look further").
      const page: SaleRow[] = [];
      let cursor = q.cursor;
      let more = true;
      for (let scanned = 0; more && page.length < q.limit && scanned < LIST_SCAN_LIMIT; ) {
        const batch = await db
          .select()
          .from(sales)
          .where(
            and(
              q.cashierSessionId ? eq(sales.cashierSessionId, q.cashierSessionId) : undefined,
              q.registerId ? eq(sales.registerId, q.registerId) : undefined,
              q.saleNumber ? eq(sales.saleNumber, q.saleNumber) : undefined,
              cursor ? sql`${sales.id} < ${cursor}` : undefined,
            ),
          )
          .orderBy(desc(sales.id))
          .limit(q.limit + 1);
        let examined = 0;
        for (const s of batch) {
          if (page.length === q.limit) break;
          examined += 1;
          cursor = s.id;
          if (this.canRead(auth, s)) page.push(s);
        }
        scanned += examined;
        // Rows left in this batch, or a full batch examined to its end: there may be more.
        more = examined < batch.length || batch.length > q.limit;
      }
      // How each sale was paid and whether it was voided or returned since (a sale row never changes).
      const ids = page.map((s) => s.id);
      const [{ rows: tenders }, { rows: backs }] = ids.length
        ? await inSequence(
            () => db.execute<{ sale_id: string; methods: string[] }>(sql`SELECT sale_id, array_agg(DISTINCT method ORDER BY method) AS methods FROM sale_tenders WHERE sale_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY 1`),
            () => db.execute<{ sale_id: string; voided: boolean; returns: number }>(sql`SELECT sale_id, bool_or(kind = 'VOID') AS voided, count(*)::int AS returns FROM sale_returns WHERE sale_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY 1`),
          )
        : [{ rows: [] }, { rows: [] }];
      return {
        data: page.map((s) => {
          const back = backs.find((b) => b.sale_id === s.id);
          return { ...this.summary(s), tenderMethods: tenders.find((x) => x.sale_id === s.id)?.methods ?? [], voided: back?.voided ?? false, returnCount: back?.returns ?? 0 };
        }),
        nextCursor: more ? (cursor ?? null) : null,
      };
    });
  }

  private canRead(auth: AuthContext, s: SaleRow) {
    const scope = { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId };
    return this.can(auth, 'sales.read', scope) || s.cashierUserId === auth.userId;
  }

  private assertCanRead(auth: AuthContext, s: SaleRow) {
    if (!this.canRead(auth, s)) this.assertCan(auth, 'sales.read', { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId });
  }

  private summary(s: SaleRow) {
    const out: Record<string, unknown> = { ...s };
    for (const k of [...MONEY_FIELDS, 'amountTendered', 'changeDue'] as const) out[k] = fixed(s[k]);
    return out;
  }

  private async view(db: Database, s: SaleRow) {
    const { rows: returned } = await db.execute<{ sale_line_id: string; quantity: string }>(
      sql`SELECT rl.sale_line_id, sum(rl.quantity)::text AS quantity FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id WHERE r.sale_id = ${s.id} GROUP BY 1`,
    );
    const [lines, tenders, beneficiaries, charges, [cashier]] = await inSequence(
      () => db.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(saleLines.lineNo),
      () => db.select().from(saleTenders).where(eq(saleTenders.saleId, s.id)).orderBy(saleTenders.createdAt, saleTenders.id),
      () => db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, s.id)),
      () => db.select().from(saleCharges).where(eq(saleCharges.saleId, s.id)),
      // The cashier's name rides along: readers of a sale need not be able to read the team.
      () => db.select({ displayName: users.displayName }).from(users).where(eq(users.id, s.cashierUserId)),
    );
    const promos = await promotionNames(db, lines);
    return {
      ...this.summary(s),
      cashierName: cashier?.displayName ?? null,
      lines: lines.map((l) => {
        const back = returned.find((r) => r.sale_line_id === l.id)?.quantity ?? '0';
        const out: Record<string, unknown> = {
          ...l, quantity: toDec(l.quantity).toString(), unitPrice: toDec(l.unitPrice).toString(), returnedQuantity: toDec(back).toString(),
          promotionName: l.promotionId ? (promos.get(l.promotionId) ?? null) : null,
        };
        for (const k of MONEY_FIELDS) out[k] = fixed(l[k]);
        return out;
      }),
      charges: charges.map((c) => {
        const out: Record<string, unknown> = { ...c, rate: toDec(c.rate).toString(), base: fixed(c.base) };
        for (const k of MONEY_FIELDS) out[k] = fixed(c[k]);
        return out;
      }),
      tenders: tenders.map((t) => ({ ...t, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change) })),
      beneficiaries,
    };
  }
}
