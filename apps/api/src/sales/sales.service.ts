import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  desc,
  eq,
  saleBeneficiaries,
  saleCharges,
  saleLines,
  sales,
  saleTenders,
  branches,
  cashMovements,
  inArray,
  legalEntities,
  orderBillAllocations,
  orderBillBeneficiaries,
  orderBillCharges,
  orderBillLines,
  orderBills,
  registers,
  restaurantOrders,
  users,
  paymentEvents,
  paymentIntents,
  sql,
  stockMovements,
  terminalTransactions,
  type Database,
} from '@1pos/database';
import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';
import type { OfflineFlag, OfflineSale } from '@1pos/sync-protocol';
import type { CreateCheckInput, CreateSaleInput, PreviewCheckInput, SaleListQuery, TendersInput } from '@1pos/validation';
import { dbNow } from '../common/clock.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { TaxService, unprocessable, type CartComputation } from '../tax/tax.service.js';
import { loadSession } from './cash.service.js';
import { buildReceipt } from './receipt.js';
import { nextNumber } from '../common/sequence.js';
import { salePosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
import { planConsumption } from '../restaurant/consumption.js';
import { addFraction, compareFraction, frac, fractionDec, ONE_FRACTION, ratioOf, subFraction, ZERO_FRACTION, type Fraction } from '../common/fraction.js';

type SaleRow = typeof sales.$inferSelect;

/** Device clock drift an offline sale may show without being flagged CLOCK_ADJUSTED (ADR-0015 §5). */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

const fixed = (v: string) => toDec(v).toFixed(2);
const MONEY_FIELDS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue',
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];
type Buckets = Record<MoneyField, string>;

const pick = (src: { [K in MoneyField]: unknown }): Buckets => Object.fromEntries(MONEY_FIELDS.map((k) => [k, String(src[k])])) as Buckets;
const ZERO_BUCKETS = Object.fromEntries(MONEY_FIELDS.map((k) => [k, '0'])) as Buckets;
const sumBuckets = (rows: Buckets[]): Buckets =>
  Object.fromEntries(MONEY_FIELDS.map((k) => [k, rows.reduce((a, r) => a.plus(r[k]), new Dec(0)).toString()])) as Buckets;
/** Ex-VAT sales of a bucket set (what revenue or the service charge liability is credited with). */
const exVat = (b: Buckets) => toDec(b.vatableSales).plus(b.vatExemptSales).plus(b.zeroRatedSales).plus(b.percentageTaxSales);
const SALES_BUCKETS = ['vatableSales', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales'] as const;

/**
 * `f` of a bucket set, rounded: the amount due is prorated first and one sales bucket (the line's
 * first non-zero one) takes whatever keeps the buckets adding up to it — so half of ₱40.00 is
 * ₱20.00, not ₱20.01 from rounding each bucket on its own.
 */
function prorate(b: Buckets, f: Dec, r2: (d: Dec) => Dec): Buckets {
  const out = Object.fromEntries(MONEY_FIELDS.map((k) => [k, r2(toDec(b[k]).times(f)).toString()])) as Buckets;
  const residual = SALES_BUCKETS.find((k) => !toDec(b[k]).isZero());
  if (residual) {
    const others = SALES_BUCKETS.filter((k) => k !== residual).reduce((a, k) => a.plus(out[k]), new Dec(0));
    out[residual] = toDec(out.amountDue).minus(others).minus(out.vatAmount).plus(out.statutoryDiscount).toString();
  }
  return out;
}

/** What is left of a bucket set after what was already taken (the final share takes the exact rest). */
const rest = (b: Buckets, taken: Buckets): Buckets => Object.fromEntries(MONEY_FIELDS.map((k) => [k, toDec(b[k]).minus(taken[k]).toString()])) as Buckets;

/** A line ready to be recorded: from the tax path (retail) or a share of a bill line (restaurant check). */
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
  /** Index (in `lines`) of the item a priced modifier belongs to. */
  parentIndex: number | null;
  allocation?: { billLineId: string; share: Fraction };
}

interface RecordCharge extends Buckets {
  kind: string;
  orderBillChargeId: string | null;
  base: string;
  rate: string;
  vatTreatment: string;
  snapshot: unknown;
}

/** Everything priced and taxed; recording adds tenders, numbers, stock, books, audit and outbox. */
interface PricedSale {
  legalEntityId: string;
  currency: string;
  taxProfileId: string;
  taxSnapshot: unknown;
  requiresProfessionalReview: boolean;
  /** Header: Σ lines + Σ charges. */
  totals: Buckets;
  lines: RecordLine[];
  beneficiaries: { ref: string; schemeCode: string; schemeVersion: number; name: string; idNumber: string; tin: string | null }[];
  charges: RecordCharge[];
  orderBillId: string | null;
  /** A sale rung up offline and recorded at sync (ADR-0015 §5). */
  offline?: { terminalId: string; reference: string; flags: OfflineFlag[]; completedAt: Date };
}

/** What a terminal's offline sale needs besides the envelope: who sent it and what it had been told. */
export interface OfflineContext {
  terminalId: string;
  registerId: string;
  snapshotAsOf: Date;
  windowHours: number;
  /** The quarantined delivery being retried, if any (it becomes RECORDED with the sale). */
  quarantinedId?: string;
  payload: unknown;
  payloadHash: string;
}


/** A retail cart from the tax path, ready to record (counter checkout and offline sales). */
function pricedFromCart(cart: CartComputation, input: Pick<CreateSaleInput, 'lines' | 'beneficiaries'>): PricedSale {
  return {
    legalEntityId: cart.legalEntityId,
    currency: cart.currency,
    taxProfileId: cart.taxProfile.id,
    taxSnapshot: cart.taxProfile,
    requiresProfessionalReview: cart.requiresProfessionalReview,
    totals: pick(cart.totals),
    lines: cart.lines.map((l, i) => {
      const statutory = input.lines[i]!.statutory;
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
        parentIndex: null,
      };
    }),
    beneficiaries: input.beneficiaries.map((b) => {
      const scheme = cart.lines.find((_, i) => input.lines[i]!.statutory?.beneficiary === b.ref)!.snapshot.scheme!;
      return { ref: b.ref, schemeCode: scheme.code, schemeVersion: scheme.version, name: b.name, idNumber: b.idNumber, tin: b.tin ?? null };
    }),
    charges: [],
    orderBillId: null,
  };
}

@Injectable()
export class SalesService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    sales_register_client_tx_unique: ['DUPLICATE_TRANSACTION', 'This register already recorded a sale with this transaction id'],
    terminal_transactions_txn_unique: ['DUPLICATE_TRANSACTION', 'This terminal already delivered this transaction'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
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
      const cart = await this.tax.computeCart(db, auth, {
        branchId: session.branchId,
        lines: input.lines.map(({ statutory, ...l }) => ({
          ...l,
          ...(statutory && { statutory: { scheme: statutory.scheme, ...(statutory.share && { share: statutory.share }) } }),
        })),
      });
      const priced = pricedFromCart(cart, input);
      const sale = await this.record(db, auth, session, input, priced);
      return this.view(db, sale);
    });
  }

  /**
   * A restaurant check (ADR-0014 §8): pays shares of a frozen bill's lines. Each sale line is the
   * bill line's buckets × the share (rounded per bucket); the allocation that completes a bill line
   * takes the exact remainder, so the checks of a bill always add up to it, centavo for centavo. The
   * service charge follows the check's share of the bill's base, the last check taking the rest.
   * Recorded exactly like any sale (tenders, stock, consumption, books); the bill row lock and a DB
   * guard stop a line being paid twice. Paying the last share settles the bill and its order.
   */
  createFromBill(auth: AuthContext, billId: string, input: CreateCheckInput) {
    return this.mutate(auth, async (db) => {
      const session = await this.checkoutSession(db, auth, input.cashierSessionId, input.clientTransactionId);
      const [bill] = await db.select().from(orderBills).where(eq(orderBills.id, billId)).for('update');
      if (!bill) throw notFound('Bill');
      if (bill.branchId !== session.branchId) throw unprocessable('WRONG_BRANCH', 'Pay a bill at the branch that served it');
      if (bill.status !== 'ACTIVE') throw new AppError('BILL_NOT_ACTIVE', `This bill is ${bill.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: bill.status });

      const { recordLines, recordCharges, settles, beneficiaries } = await this.priceCheck(db, bill, input.allocations);
      const used = new Set(recordLines.flatMap((l) => (l.beneficiaryRef ? [l.beneficiaryRef] : [])));
      const sale = await this.record(db, auth, session, input, {
        legalEntityId: bill.legalEntityId,
        currency: bill.currency,
        taxProfileId: bill.taxProfileId,
        taxSnapshot: bill.taxSnapshot,
        requiresProfessionalReview: bill.requiresProfessionalReview,
        totals: sumBuckets([...recordLines, ...recordCharges]),
        lines: recordLines,
        beneficiaries: beneficiaries.filter((b) => used.has(b.id)).map((b) => ({ ref: b.id, schemeCode: b.schemeCode, schemeVersion: b.schemeVersion, name: b.name, idNumber: b.idNumber, tin: b.tin })),
        charges: recordCharges,
        orderBillId: bill.id,
      });

      if (settles) {
        await db.update(orderBills).set({ status: 'SETTLED', settledAt: sql`now()` }).where(eq(orderBills.id, bill.id));
        await db.update(restaurantOrders).set({ status: 'SETTLED', closedBy: auth.userId, closedAt: sql`now()` }).where(eq(restaurantOrders.id, bill.orderId));
        await this.audit(db, auth, 'order.settled', 'restaurant_order', bill.orderId, { orderBillId: bill.id, billNumber: bill.billNumber });
      }
      return { ...(await this.view(db, sale)), billSettled: settles };
    });
  }

  /**
   * What a check with these allocations would pay, priced exactly as `createFromBill` would price it
   * now, without recording anything. The till shows it before taking money; the check itself still
   * sends `expectedAmountDue`, so a check recorded in between is caught as TOTAL_CHANGED.
   */
  previewCheck(auth: AuthContext, billId: string, input: PreviewCheckInput) {
    return this.read(auth, async (db) => {
      const [bill] = await db.select().from(orderBills).where(eq(orderBills.id, billId));
      if (!bill) throw notFound('Bill');
      const { scope } = await branchScope(db, bill.branchId);
      if (!this.can(auth, 'restaurant.orders', scope)) this.assertCan(auth, 'sales.create', scope);
      if (bill.status !== 'ACTIVE') throw new AppError('BILL_NOT_ACTIVE', `This bill is ${bill.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: bill.status });
      const { recordLines, recordCharges, settles, lines } = await this.priceCheck(db, bill, input.allocations);
      const totals = sumBuckets([...recordLines, ...recordCharges]);
      return {
        billId: bill.id,
        settles,
        ...Object.fromEntries(MONEY_FIELDS.map((k) => [k, fixed(totals[k])])),
        lines: recordLines.map((l) => {
          const billLine = lines.find((x) => x.id === l.allocation!.billLineId)!;
          return { billLineId: billLine.id, parentBillLineId: billLine.parentLineId, name: l.name, quantity: toDec(l.quantity).toString(), amountDue: fixed(l.amountDue) };
        }),
        charges: recordCharges.map((c) => ({ kind: c.kind, amountDue: fixed(c.amountDue) })),
      };
    });
  }

  /**
   * An offline cash sale delivered by its terminal (ADR-0015 §5), recorded as the shift's cashier
   * (`auth`). Re-priced as of the terminal's snapshot, so the server reproduces the total the terminal
   * charged or refuses (TOTAL_MISMATCH); flagged, never refused, when prices moved meanwhile, the
   * snapshot had expired or the device clock was off. The delivery row (RECORDED) commits with the sale.
   * Any refusal leaves nothing; the caller quarantines the envelope.
   */
  recordOffline(auth: AuthContext, env: OfflineSale, ctx: OfflineContext) {
    return this.mutate(auth, async (db) => {
      const session = await this.checkoutSession(db, auth, env.cashierSessionId, env.terminalTxnId);
      if (session.registerId !== ctx.registerId) {
        throw new AppError('WRONG_REGISTER', 'This shift is on another register than the terminal', HttpStatus.CONFLICT);
      }
      const input = { lines: env.lines, beneficiaries: [] };
      const cartAt = (at: Date) => this.tax.computeCart(db, auth, { branchId: session.branchId, lines: env.lines }, at);
      const cart = await cartAt(ctx.snapshotAsOf);

      const flags: OfflineFlag[] = [];
      const now = await dbNow(db);
      const occurred = new Date(env.occurredAt);
      const completedAt = new Date(Math.min(Math.max(occurred.getTime(), session.openedAt.getTime()), now.getTime()));
      // Clamped always; flagged when the device clock was off by more than ordinary drift.
      if (Math.abs(completedAt.getTime() - occurred.getTime()) > CLOCK_TOLERANCE_MS) flags.push('CLOCK_ADJUSTED');
      // Prices or the tax profile that were in force when the sale happened, if the terminal could not know them.
      const then = await cartAt(completedAt).catch(() => null);
      const sameAsThen = then && then.taxProfile.id === cart.taxProfile.id && then.lines.every((l, i) => l.priceId === cart.lines[i]!.priceId);
      if (!sameAsThen) flags.push('PRICE_CHANGED');
      if (completedAt.getTime() > ctx.snapshotAsOf.getTime() + ctx.windowHours * 3_600_000) flags.push('SNAPSHOT_EXPIRED');

      const priced = pricedFromCart(cart, input);
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
      const [reg] = await db.select({ code: registers.code }).from(registers).where(eq(registers.id, session.registerId));
      return { saleId: sale.id, saleNumber: sale.saleNumber, reference: `${reg!.code}-${String(sale.saleNumber).padStart(6, '0')}`, flags };
    });
  }

  /** The calendar date of an instant in the branch's timezone (DB arithmetic). */
  private async localDate(db: Database, branchId: string, at: Date) {
    const { rows } = await db.execute<{ d: string }>(sql`
      SELECT (${at.toISOString()}::timestamptz AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id = ${branchId}`);
    return rows[0]!.d;
  }

  /** A check's lines and charges for these allocations (ADR-0014 §8); shared by the check and its preview. */
  private async priceCheck(db: Database, bill: typeof orderBills.$inferSelect, allocations: CreateCheckInput['allocations']) {
    const billId = bill.id;
    const [lines, charges, beneficiaries, prior] = await Promise.all([
      db.select().from(orderBillLines).where(eq(orderBillLines.orderBillId, billId)).orderBy(orderBillLines.lineNo),
      db.select().from(orderBillCharges).where(eq(orderBillCharges.orderBillId, billId)),
      db.select().from(orderBillBeneficiaries).where(eq(orderBillBeneficiaries.orderBillId, billId)),
      db.select({ a: orderBillAllocations, l: saleLines }).from(orderBillAllocations)
        .innerJoin(saleLines, eq(saleLines.id, orderBillAllocations.saleLineId))
        .where(eq(orderBillAllocations.orderBillId, billId)),
    ]);
    const paid = new Map<string, { share: Fraction; quantity: Dec; buckets: Buckets[] }>();
    for (const p of prior) {
      const acc = paid.get(p.a.billLineId) ?? { share: ZERO_FRACTION, quantity: new Dec(0), buckets: [] };
      acc.share = addFraction(acc.share, frac(p.a.shareNum, p.a.shareDen));
      acc.quantity = acc.quantity.plus(p.l.quantity);
      acc.buckets.push(pick(p.l));
      paid.set(p.a.billLineId, acc);
    }
    const remaining = (lineId: string) => subFraction(ONE_FRACTION, paid.get(lineId)?.share ?? ZERO_FRACTION);

    // What this check pays, per top-level line; modifiers follow their item's share.
    const top = lines.filter((l) => !l.parentLineId);
    const wanted = new Map<string, Fraction>();
    if (!allocations) {
      for (const l of top) if (remaining(l.id).n > 0n) wanted.set(l.id, remaining(l.id));
    } else {
      for (const [i, a] of allocations.entries()) {
        const line = lines.find((l) => l.id === a.billLineId);
        if (!line) throw new AppError('NOT_FOUND', 'Bill line not found', HttpStatus.NOT_FOUND, { path: ['allocations', i, 'billLineId'] });
        if (line.parentLineId) throw unprocessable('PAY_WHOLE_ITEMS', 'Pay an item with its choices; choices follow their item', { path: ['allocations', i, 'billLineId'] });
        if (wanted.has(line.id)) throw unprocessable('DUPLICATE_ALLOCATION', 'Each bill line once per check', { path: ['allocations', i, 'billLineId'] });
        const share = a.quantity ? ratioOf(a.quantity, line.quantity) : a.share ? frac(a.share.num, a.share.den) : remaining(line.id);
        if (share.n <= 0n || compareFraction(share, remaining(line.id)) > 0) {
          throw unprocessable('ALLOCATION_EXCEEDS_LINE', 'More than what is left to pay on this line', { path: ['allocations', i], billLineId: line.id, remaining: `${remaining(line.id).n}/${remaining(line.id).d}` });
        }
        wanted.set(line.id, share);
      }
    }
    if (!wanted.size) throw unprocessable('NOTHING_TO_PAY', 'Everything on this bill is already paid');

    const rounding = ((bill.taxSnapshot as { roundingMode?: RoundingMode }).roundingMode ?? 'HALF_UP') as RoundingMode;
    const r2 = (d: Dec) => roundTo(d, 2, rounding);
    const recordLines: RecordLine[] = [];
    const indexOf = new Map<string, number>();
    for (const line of lines) {
      const share = wanted.get(line.parentLineId ?? line.id);
      if (!share) continue;
      const before = paid.get(line.id) ?? { share: ZERO_FRACTION, quantity: new Dec(0), buckets: [] };
      const last = compareFraction(addFraction(before.share, share), ONE_FRACTION) === 0;
      const amounts = last ? rest(pick(line), sumBuckets([ZERO_BUCKETS, ...before.buckets])) : prorate(pick(line), fractionDec(share), r2);
      const quantity = last ? toDec(line.quantity).minus(before.quantity) : roundTo(toDec(line.quantity).times(fractionDec(share)), 4, 'HALF_UP');
      if (quantity.lte(0)) throw unprocessable('SHARE_TOO_SMALL', 'This share is too small to record', { billLineId: line.id });
      const beneficiary = beneficiaries.find((b) => b.id === line.beneficiaryId);
      indexOf.set(line.id, recordLines.length);
      recordLines.push({
        ...amounts,
        clientLineId: `bill-${bill.billNumber}-${line.lineNo}`,
        variantId: line.variantId,
        sku: line.sku,
        name: line.name,
        taxCategoryCode: line.taxCategoryCode,
        vatTreatment: line.vatTreatment,
        quantity: quantity.toString(),
        unitPrice: line.unitPrice,
        priceIncludesTax: line.priceIncludesTax,
        priceId: line.priceId,
        priceListId: line.priceListId,
        trackInventory: line.trackInventory,
        beneficiaryRef: beneficiary?.id ?? null,
        schemeShare: line.schemeShare,
        snapshot: line.taxSnapshot,
        parentIndex: line.parentLineId ? indexOf.get(line.parentLineId)! : null,
        allocation: { billLineId: line.id, share },
      });
    }

    // Charges follow the check's share of what the items cost (an even split pays half the service
    // charge); the check that completes the bill takes the exact rest.
    const settles = top.every((l) => compareFraction(addFraction(paid.get(l.id)?.share ?? ZERO_FRACTION, wanted.get(l.id) ?? ZERO_FRACTION), ONE_FRACTION) === 0);
    const billItemsDue = lines.reduce((a, l) => a.plus(l.amountDue), new Dec(0));
    const checkItemsDue = recordLines.reduce((a, l) => a.plus(l.amountDue), new Dec(0));
    const ratio = billItemsDue.isZero() ? new Dec(0) : checkItemsDue.dividedBy(billItemsDue);
    const recordCharges: RecordCharge[] = [];
    for (const c of charges) {
      const before = await db.select().from(saleCharges).where(eq(saleCharges.orderBillChargeId, c.id));
      const amounts = settles ? rest(pick(c), sumBuckets([ZERO_BUCKETS, ...before.map(pick)])) : prorate(pick(c), ratio, r2);
      // A charge is priced ex VAT: its gross is its sales, whatever rounding gave the parts.
      amounts.gross = exVat(amounts).toString();
      if (toDec(amounts.amountDue).isZero()) continue;
      // The base follows the same rule, so Σ checks' bases = the bill's base (DOLE report).
      const base = settles ? before.reduce((a, b) => a.minus(b.base), toDec(c.base)) : r2(toDec(c.base).times(ratio));
      recordCharges.push({ ...amounts, kind: c.kind, orderBillChargeId: c.id, base: base.toString(), rate: c.rate, vatTreatment: c.vatTreatment, snapshot: c.taxSnapshot });
    }
    return { recordLines, recordCharges, settles, beneficiaries, lines };
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
   * first, cash covers the rest), number, sale + beneficiaries + lines + charges + tenders, cash
   * movement, stock (SALE for tracked items, CONSUMPTION for recipes), bill allocations, one journal
   * entry, audit and outbox.
   */
  private async record(
    db: Database,
    auth: AuthContext,
    session: Awaited<ReturnType<typeof loadSession>>['session'],
    input: { clientTransactionId: string; tenders: TendersInput; expectedAmountDue?: string | undefined },
    priced: PricedSale,
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
    }
    const electronic = intents.reduce((a, p) => a.plus(p.amount), new Dec(0));
    if (electronic.gt(due)) throw unprocessable('OVERPAYMENT', 'Card/QR payments exceed the total; cancel one and take the exact amount', { amountDue: due.toFixed(2) });

    // Cash covers the rest; only the last cash tender may give change.
    let remaining = due.minus(electronic);
    const cashTenders = input.tenders.flatMap((t, i) => (t.method === 'CASH' ? [{ t, i }] : []));
    const cash = cashTenders.map(({ t, i }) => {
      if (remaining.isZero() && !due.isZero()) throw unprocessable('UNNECESSARY_TENDER', 'The sale is already paid', { tender: i });
      const tendered = toDec(t.tendered);
      const applied = Dec.min(tendered, remaining);
      remaining = remaining.minus(applied);
      return { tendered, applied, change: tendered.minus(applied) };
    });
    if (remaining.gt(0)) throw unprocessable('INSUFFICIENT_TENDER', 'The tendered amount does not cover the total', { amountDue: due.toFixed(2) });
    if (cash.slice(0, -1).some((t) => t.change.gt(0))) throw unprocessable('UNNECESSARY_TENDER', 'Only the last tender may give change');
    const cashApplied = cash.reduce((a, t) => a.plus(t.applied), new Dec(0));
    const tendered = cash.reduce((a, t) => a.plus(t.tendered), electronic);
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
        orderBillId: priced.orderBillId,
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

    // Items first, then the priced modifiers that point at them.
    const lineIds: string[] = [];
    const lineRow = (l: RecordLine, i: number) =>
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
        parentLineId: l.parentIndex === null ? null : lineIds[l.parentIndex]!,
      }) as typeof saleLines.$inferInsert;
    for (const pass of [false, true]) {
      const batch = priced.lines.map((l, i) => ({ l, i })).filter(({ l }) => (l.parentIndex !== null) === pass);
      if (!batch.length) continue;
      const rows = await db.insert(saleLines).values(batch.map(({ l, i }) => lineRow(l, i))).returning({ id: saleLines.id, lineNo: saleLines.lineNo });
      for (const r of rows) lineIds[r.lineNo - 1] = r.id;
    }

    if (priced.charges.length) {
      await db.insert(saleCharges).values(
        priced.charges.map((c) => ({ tenantId, saleId: sale!.id, kind: c.kind, orderBillChargeId: c.orderBillChargeId, base: c.base, rate: c.rate, vatTreatment: c.vatTreatment, ...pick(c), taxSnapshot: c.snapshot })),
      );
    }
    const allocations = priced.lines.flatMap((l, i) =>
      l.allocation ? [{ tenantId, orderBillId: priced.orderBillId!, billLineId: l.allocation.billLineId, saleId: sale!.id, saleLineId: lineIds[i]!, shareNum: Number(l.allocation.share.n), shareDen: Number(l.allocation.share.d) }] : [],
    );
    if (allocations.length) await db.insert(orderBillAllocations).values(allocations);

    await db.insert(saleTenders).values([
      ...intents.map((p) => ({ tenantId, saleId: sale!.id, method: p.method, paymentIntentId: p.id, amount: p.amount, tendered: p.amount, change: '0' })),
      ...cash.map((t) => ({ tenantId, saleId: sale!.id, method: 'CASH', amount: t.applied.toString(), tendered: t.tendered.toString(), change: t.change.toString() })),
    ]);
    for (const p of intents) {
      await db.update(paymentIntents).set({ saleId: sale!.id }).where(eq(paymentIntents.id, p.id));
      await db.insert(paymentEvents).values({ tenantId, paymentIntentId: p.id, type: 'CONSUMED', detail: { saleId: sale!.id }, createdBy: auth.userId });
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
    // Items made from a recipe consume their ingredients with the sale (ADR-0014 §4).
    const consumed = await planConsumption(
      db,
      priced.lines.flatMap((l, i) => (l.trackInventory ? [] : [{ saleLineId: lineIds[i]!, variantId: l.variantId, quantity: l.quantity }])),
    );
    for (const c of consumed) {
      stock.push({ tenantId, branchId: session.branchId, ...c, type: 'CONSUMPTION', saleId: sale!.id, createdBy: auth.userId });
    }
    // Sorted by variant: concurrent sales lock balance rows in the same order (ADR-0012 §7).
    const moved = stock.length
      ? await db.insert(stockMovements).values(stock.sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))).returning({ value: stockMovements.value })
      : [];

    // Books (ADR-0013): money in, revenue (items) and service charge payable (charges), output VAT,
    // COGS at the ledger's cost — same transaction.
    const serviceCharge = priced.charges.reduce((a, c) => a.plus(exVat(c)), new Dec(0));
    await post(db, {
      tenantId,
      legalEntityId: priced.legalEntityId,
      branchId: session.branchId,
      sourceType: 'SALE',
      sourceId: sale!.id,
      memo: priced.offline ? `Sale #${saleNumber} (offline ${priced.offline.reference})` : `Sale #${saleNumber}`,
      // An offline sale is booked on the day it happened, in the branch's calendar.
      ...(priced.offline && { entryDate: await this.localDate(db, session.branchId, priced.offline.completedAt) }),
      lines: salePosting({
        salesExVat: exVat(priced.totals).minus(serviceCharge),
        serviceCharge,
        vatAmount: priced.totals.vatAmount,
        statutoryDiscount: priced.totals.statutoryDiscount,
        cash: cashApplied,
        electronic,
        cogs: moved.reduce((a, m) => a.minus(m.value), new Dec(0)),
      }, session.branchId),
      createdBy: auth.userId,
    });

    await this.audit(db, auth, 'sale.completed', 'sale', sale!.id, {
      saleNumber, amountDue: due.toFixed(2), registerId: session.registerId,
      ...(priced.orderBillId && { orderBillId: priced.orderBillId }),
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
      const [[entity], [branch], [register], [cashier], lines, tenders, beneficiaries, charges] = await Promise.all([
        db.select().from(legalEntities).where(eq(legalEntities.id, sale.legalEntityId)),
        db.select().from(branches).where(eq(branches.id, sale.branchId)),
        db.select().from(registers).where(eq(registers.id, sale.registerId)),
        db.select({ displayName: users.displayName }).from(users).where(eq(users.id, sale.cashierUserId)),
        db.select().from(saleLines).where(eq(saleLines.saleId, id)).orderBy(saleLines.lineNo),
        db.select().from(saleTenders).where(eq(saleTenders.saleId, id)).orderBy(saleTenders.createdAt, saleTenders.id),
        db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, id)),
        db.select().from(saleCharges).where(eq(saleCharges.saleId, id)),
      ]);
      const snapshot = sale.taxSnapshot as { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
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
        })),
        tenders: tenders.map((t) => ({ method: t.method, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change) })),
        beneficiaries,
        charges: charges.map((c) => ({ kind: c.kind, rate: toDec(c.rate).toString(), gross: c.gross, amountDue: c.amountDue, vatTreatment: c.vatTreatment })),
      });
    });
  }

  list(auth: AuthContext, q: SaleListQuery) {
    return this.read(auth, async (db) => {
      const rows = await db
        .select()
        .from(sales)
        .where(
          and(
            q.cashierSessionId ? eq(sales.cashierSessionId, q.cashierSessionId) : undefined,
            q.registerId ? eq(sales.registerId, q.registerId) : undefined,
            q.cursor ? sql`${sales.id} < ${q.cursor}` : undefined,
          ),
        )
        .orderBy(desc(sales.id))
        .limit(q.limit + 1);
      const visible = rows.filter((s) => this.canRead(auth, s));
      const page = visible.slice(0, q.limit);
      return {
        data: page.map((s) => this.summary(s)),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
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
    const [lines, tenders, beneficiaries, charges] = await Promise.all([
      db.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(saleLines.lineNo),
      db.select().from(saleTenders).where(eq(saleTenders.saleId, s.id)),
      db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, s.id)),
      db.select().from(saleCharges).where(eq(saleCharges.saleId, s.id)),
    ]);
    return {
      ...this.summary(s),
      lines: lines.map((l) => {
        const back = returned.find((r) => r.sale_line_id === l.id)?.quantity ?? '0';
        const out: Record<string, unknown> = { ...l, quantity: toDec(l.quantity).toString(), unitPrice: toDec(l.unitPrice).toString(), returnedQuantity: toDec(back).toString() };
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
