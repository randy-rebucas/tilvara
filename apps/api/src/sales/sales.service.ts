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
  saleTips,
  saleTipShares,
  serviceStaff,
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
  kitchenTickets,
  users,
  paymentEvents,
  paymentIntents,
  promotions,
  rooms,
  stays,
  sql,
  stockMovements,
  terminalTransactions,
  type Database,
  inSequence,
  jobOrderDeposits,
  jobOrderLines,
  jobOrders,
  jobOrderTrips,
  laundryMachines,
  machineRuns,
  productVariants,
} from '@1pos/database';
import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';
import type { OfflineFlag, OfflineSale } from '@1pos/sync-protocol';
import type { ClaimJobOrderInput, CreateCheckInput, CreateExchangeInput, CreateSaleInput, LinePrescriptionInput, PermissionCode, PreviewCheckInput, SaleListQuery, SalePrescriptionInput, TendersInput, TipInput } from '@1pos/validation';
import { dbNow } from '../common/clock.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { voidedChecks } from '../restaurant/bills.service.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLaundry, hasFeature, readOnlyReason } from '../billing/entitlements.js';
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
import { planConsumption } from '../restaurant/consumption.js';
import { versionMenuItems } from '../restaurant/choices.js';
import { expandCounterLines, recordCounterOrder, type CounterLineInput, type CounterPlan } from '../restaurant/counter.js';
import { loadSettings } from '../restaurant/floor.service.js';
import { MenusService } from '../restaurant/menus.service.js';
import { assertStockAvailable } from './stock-policy.js';
import { openPacksForSale } from '../inventory/packs.service.js';
import { assertNotExpired, expiredDraws, expiredStockRule } from '../pharmacy/drugs.js';
import { bookletOf, planDispensing, recordDispensing } from '../pharmacy/dispensing.js';
import { addFraction, compareFraction, frac, fractionDec, ONE_FRACTION, ratioOf, subFraction, ZERO_FRACTION, type Fraction } from '../common/fraction.js';
import { PricingService } from '../catalog/pricing.service.js';
import { assertStaffDoServices, commissionRates } from '../salon/staff.service.js';
import { completeAppointment } from '../salon/appointments.service.js';
import { EMPTY_PLAN, planPackages, recordPackages, splitByWeight } from '../salon/packages.js';
import { insertEntry, planRoomCharge, stayGuestName, surnameOf } from '../lodging/folio.js';
import { downPaymentRefundedPosting } from '@1pos/accounting';
import { branchLaundrySettings, depositsHeld, isOpen, jobEnded, jobNumber, jobScope, liveTrip, loadJob, lockJobDeposits, lockMachine, priceJob, recordStatus, storageDays, type PricedJobLine } from '../laundry/job.js';

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
  /** An approved price change (session 20). */
  priceOverrideId?: string | null;
  /** The promotion that priced it (ADR-0021). */
  promotionId?: string | null;
  allocation?: { billLineId: string; share: Fraction };
  /** A check's share of a bill line: what earlier checks already sold of that line (recipe consumption rounds on the running total). */
  soldBefore?: string;
  /** A check's share of a bill line one of whose checks was voided: how much of the line was consumed so far (voided checks included). */
  consumedBefore?: string;
  /** Counter lines (ADR-0022): STANDARD, SERVICE or PACKAGE; a check's lines leave it out (never a package). */
  productType?: string;
  /** A session of this customer package (priced at zero). */
  packageId?: string | null;
  /** Who performed or sold it. */
  staffId?: string | null;
  /** A self-service cycle's washer or dryer (ADR-0024 §7); counter sales only. */
  machineId?: string | null;
  /** The prescription item a medicine fills (ADR-0025 §6). */
  prescription?: LinePrescriptionInput | undefined;
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
  beneficiaries: { ref: string; schemeCode: string; schemeVersion: number; name: string; idNumber: string; tin: string | null; purchaseBooklet?: boolean | undefined }[];
  charges: RecordCharge[];
  orderBillId: string | null;
  /** A sale rung up offline and recorded at sync (ADR-0015 §5). */
  offline?: { terminalId: string; reference: string; flags: OfflineFlag[]; completedAt: Date };
  /** The customer it was rung up for (ADR-0018); needed to pay with store credit. */
  customerId?: string | null;
  /**
   * A counter sale: refused when the branch's negative-stock policy is BLOCK and a tracked item would
   * go below zero. Checks (food already served) and offline sales (already handed over) are never
   * refused for stock; the costing trigger flags them instead.
   */
  enforceStock?: boolean;
  /** Counter service (session 25): the menu items the kitchen gets once this sale is paid. */
  counter?: CounterPlan | null;
  /** The appointment this sale rings up (ADR-0022 §4). */
  appointmentId?: string | null;
  /** A laundry claim (ADR-0024 §5): its job order and the down payment that pays first. */
  jobOrder?: { id: string; downPayment: Dec } | null;
  /** Prescriptions recorded with the sale and a pharmacist's approval (ADR-0025 §6). */
  prescriptions?: SalePrescriptionInput[];
  dispenseApprovalId?: string | undefined;
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


/** What a priced line was asked with: its SC/PWD beneficiary, if any, and a self-service cycle's machine. */
type LineAsked = { variantId: string; statutory?: { beneficiary?: string } | undefined; machineId?: string | undefined; prescription?: LinePrescriptionInput | undefined };

/**
 * A retail cart from the tax path, ready to record (counter checkout and offline sales). `lines` are
 * the lines the cart was computed from (with counter choices expanded, `parentIndex` says which item a
 * priced choice belongs to).
 */
function pricedFromCart(cart: CartComputation, lines: LineAsked[], beneficiaries: CreateSaleInput['beneficiaries'], parentIndex: (number | null)[] = []): PricedSale {
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
        parentIndex: parentIndex[i] ?? null,
        priceOverrideId: l.priceOverrideId,
        promotionId: l.promotionId,
        productType: l.productType,
        packageId: l.packageId,
        staffId: l.staffId,
        machineId: lines[i]!.machineId ?? null,
        prescription: lines[i]!.prescription,
      };
    }),
    beneficiaries: beneficiaries.map((b) => {
      const scheme = cart.lines.find((_, i) => lines[i]!.statutory?.beneficiary === b.ref)!.snapshot.scheme!;
      return { ref: b.ref, schemeCode: scheme.code, schemeVersion: scheme.version, name: b.name, idNumber: b.idNumber, tin: b.tin ?? null, purchaseBooklet: b.purchaseBooklet };
    }),
    charges: [],
    orderBillId: null,
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
    prescriptions_yellow_form_once: ['YELLOW_FORM_USED', 'This yellow prescription form number is already on another prescription'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
    @Inject(MenusService) private readonly menus: MenusService,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {
    super(tenantDb);
  }

  /**
   * Counter service (ADR-0014 amendment, session 25): the takeaway menu a counter sale's choices come
   * from, when the branch has it on and the business may serve food; else null (a sale with choices is
   * then refused, an ordinary one is not affected). A plan downgrade turns the kitchen off, never the till.
   */
  private async counterMenu(db: Database, branchId: string, pickupName: string | null) {
    const settings = await loadSettings(db, branchId);
    if (!settings?.counterService || !(await hasFeature(db, 'restaurant'))) return null;
    const served = await this.menus.served(db, branchId, 'TAKEAWAY');
    if (!served.menu) return null;
    return { menuVersionId: served.menu.menuVersionId, items: served.menu.sections.flatMap((s) => s.items), pickupName, offline: false };
  }

  /** A counter cart priced on the tax path: choices expanded into lines, SC/PWD as asked. */
  private async priceCounterCart(db: Database, auth: AuthContext, branchId: string, sale: Pick<CreateSaleInput, 'lines' | 'beneficiaries' | 'pickupName'>) {
    const expanded = expandCounterLines(sale.lines, await this.counterMenu(db, branchId, sale.pickupName ?? null));
    const cart = await this.tax.computeCart(db, auth, {
      branchId,
      lines: expanded.lines.map(({ statutory, ...l }) => ({
        ...l,
        ...(statutory && { statutory: { scheme: statutory.scheme, ...(statutory.share && { share: statutory.share }) } }),
      })),
    }, undefined, { promotions: true });
    return { ...pricedFromCart(cart, expanded.lines, sale.beneficiaries, expanded.parentIndex), counter: expanded.plan };
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
      const priced = {
        ...(await this.priceCounterCart(db, auth, session.branchId, input)), enforceStock: true, customerId, appointmentId: input.appointmentId ?? null,
        prescriptions: input.prescriptions, dispenseApprovalId: input.dispenseApprovalId,
      };
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
      const priced = {
        ...(await this.priceCounterCart(db, auth, session.branchId, input.sale)), enforceStock: true, customerId,
        prescriptions: input.sale.prescriptions, dispenseApprovalId: input.sale.dispenseApprovalId,
      };
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
      // A check may name its customer (ADR-0018): purchase history, and store credit can pay it.
      const customerId = input.customerId ? (await activeCustomer(db, input.customerId)).id : null;
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
        customerId,
      });

      if (settles) {
        await db.update(orderBills).set({ status: 'SETTLED', settledAt: sql`now()` }).where(eq(orderBills.id, bill.id));
        // An order left SETTLED when a voided check reopened its bill (its table was taken) stays so.
        await db.update(restaurantOrders).set({ status: 'SETTLED', closedBy: auth.userId, closedAt: sql`now()` }).where(and(eq(restaurantOrders.id, bill.orderId), eq(restaurantOrders.status, 'BILLED')));
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
   * A laundry claim (ADR-0024 §5): the job order's frozen lines (plus a storage fee for the days it
   * waited beyond the branch's free days) recorded as a sale through `record()`. The down payment pays
   * first (a JOB_DEPOSIT tender, APPLIED in the same transaction); anything held beyond the total goes
   * back in cash from this drawer. Released with the claim code, a manager's override, or by the rider
   * at the door (the delivery trip is done with it). The job becomes CLAIMED with the sale.
   */
  createFromJobOrder(auth: AuthContext, jobOrderId: string, input: ClaimJobOrderInput) {
    return this.mutate(auth, async (db) => {
      const session = await this.checkoutSession(db, auth, input.cashierSessionId, input.clientTransactionId);
      const job = await loadJob(db, jobOrderId, true);
      const scope = jobScope(job);
      const delivery = input.releasedVia === 'DELIVERY';
      if (!this.can(auth, 'laundry.manage', scope) && !(delivery && this.can(auth, 'laundry.deliver', scope))) this.assertCan(auth, 'laundry.manage', scope);
      await assertLaundry(db);
      if (job.branchId !== session.branchId) throw unprocessable('WRONG_BRANCH', 'Release a job order at the branch that took it in');
      if (!isOpen(job.status)) throw jobEnded(job);
      if (!job.pricedAt || !job.taxProfileId) throw unprocessable('JOB_NOT_PRICED', 'Weigh and price the job order before releasing it');
      const trip = delivery ? await liveTrip(db, job.id, 'DELIVERY') : undefined;
      if (delivery) {
        if (!trip) throw new AppError('NO_DELIVERY_TRIP', 'This job order has no delivery on its way', HttpStatus.CONFLICT);
        if (job.status !== 'READY' && job.status !== 'OUT_FOR_DELIVERY') throw new AppError('JOB_NOT_READY', 'Only finished laundry goes out for delivery', HttpStatus.CONFLICT, { status: job.status });
      } else if (input.claimCode !== undefined) {
        if (input.claimCode !== job.claimCode) throw unprocessable('CLAIM_CODE_MISMATCH', 'This claim code is not this job order\'s');
      } else this.assertCan(auth, 'laundry.release_override', scope);

      // The days it waited beyond the free days: one storage-fee line, priced now on the same profile
      // as the frozen lines (re-pricing the whole job only if the tax profile changed meanwhile).
      const settings = await branchLaundrySettings(db, job.branchId);
      const days = await storageDays(db, job, settings);
      let lines: PricedJobLine[] = (await db.select().from(jobOrderLines).where(eq(jobOrderLines.jobOrderId, job.id)).orderBy(jobOrderLines.lineNo)) as unknown as PricedJobLine[];
      let header = { taxProfileId: job.taxProfileId, taxSnapshot: job.taxSnapshot, requiresProfessionalReview: job.requiresProfessionalReview, currency: job.currency };
      if (days > 0) {
        const extra = [{ variantId: settings.storageFeeVariantId!, quantity: String(days) }];
        const fee = await priceJob(this.tax, db, auth, job, [], settings, extra, { auto: false });
        if (fee && fee.taxProfileId === job.taxProfileId) lines = [...lines, ...fee.lines];
        else {
          const again = await priceJob(this.tax, db, auth, job, lines.map((l) => ({ variantId: l.variantId, quantity: toDec(l.measuredQuantity).toString(), ...(l.customerPackageId && { packageId: l.customerPackageId }) })), settings, extra);
          lines = again!.lines;
          header = { taxProfileId: again!.taxProfileId, taxSnapshot: again!.taxSnapshot, requiresProfessionalReview: again!.requiresProfessionalReview, currency: again!.currency };
        }
      }
      const recordLines: RecordLine[] = lines.map((l, i) => ({
        ...pick(l),
        clientLineId: `job-${job.number}-${i + 1}`,
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        taxCategoryCode: l.taxCategoryCode,
        vatTreatment: l.vatTreatment,
        quantity: toDec(l.quantity).toString(),
        unitPrice: toDec(l.unitPrice).toString(),
        priceIncludesTax: l.priceIncludesTax,
        priceId: l.priceId,
        priceListId: l.priceListId,
        trackInventory: l.trackInventory,
        beneficiaryRef: null,
        schemeShare: null,
        snapshot: l.taxSnapshot,
        parentIndex: null,
        promotionId: l.promotionId,
        productType: l.productType,
        packageId: l.customerPackageId,
      }));
      const totals = sumBuckets(recordLines);
      await lockJobDeposits(db, job.id);
      const held = await depositsHeld(db, job.id);
      const applied = Dec.min(held, toDec(totals.amountDue));
      const sale = await this.record(db, auth, session, input, {
        legalEntityId: job.legalEntityId,
        currency: header.currency,
        taxProfileId: header.taxProfileId!,
        taxSnapshot: header.taxSnapshot,
        requiresProfessionalReview: header.requiresProfessionalReview,
        totals,
        lines: recordLines,
        beneficiaries: [],
        charges: [],
        orderBillId: null,
        customerId: job.customerId,
        // The work is done and the laundry handed over: stock is flagged, never a reason to refuse.
        enforceStock: false,
        jobOrder: { id: job.id, downPayment: applied },
      });

      // Held beyond what the claim cost (lines reduced after the down payment): back in cash, now.
      const excess = held.minus(applied);
      if (excess.gt(0)) {
        const drawer = toDec(await expectedCash(db, session.id));
        if (drawer.lt(excess)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer to give back the rest of the down payment', { available: drawer.toFixed(2) });
        const [row] = await db.insert(jobOrderDeposits).values({
          tenantId: job.tenantId, jobOrderId: job.id, legalEntityId: job.legalEntityId, branchId: job.branchId, kind: 'REFUNDED', amount: excess.negated().toString(),
          method: 'CASH', cashierSessionId: session.id, reason: `Rest of the down payment at claim, sale #${sale.saleNumber}`, createdBy: auth.userId,
        }).returning();
        await db.insert(cashMovements).values({ tenantId: job.tenantId, cashierSessionId: session.id, type: 'JOB_DEPOSIT_REFUND', amount: excess.negated().toString(), jobOrderDepositId: row!.id, reason: 'Rest of the down payment', createdBy: auth.userId });
        await post(db, {
          tenantId: job.tenantId, legalEntityId: job.legalEntityId, branchId: job.branchId, sourceType: 'JOB_ORDER_DEPOSIT', sourceId: row!.id, memo: `Rest of the down payment given back at claim, sale #${sale.saleNumber}`,
          lines: downPaymentRefundedPosting(excess, 'CASH', job.branchId), createdBy: auth.userId,
        });
      }

      await db.update(jobOrders).set({ status: 'CLAIMED', saleId: sale.id, claimedAt: sql`now()`, claimedBy: auth.userId, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
      await recordStatus(db, job, job.status, 'CLAIMED', auth.userId, delivery ? 'Delivered' : null);
      if (trip) await db.update(jobOrderTrips).set({ status: 'DONE', doneAt: sql`now()`, doneBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrderTrips.id, trip.id));
      await this.audit(db, auth, 'job_order.claimed', 'job_order', job.id, {
        saleId: sale.id, saleNumber: sale.saleNumber, reference: jobNumber(job.number), downPaymentApplied: applied.toFixed(2),
        ...(excess.gt(0) && { downPaymentReturned: excess.toFixed(2) }),
        ...(days > 0 && { storageDays: days }),
        ...(delivery && { releasedVia: 'DELIVERY', tripId: trip!.id }),
        ...(!delivery && input.claimCode === undefined && { override: true, overrideReason: input.overrideReason ?? null }),
      });
      await emitEvent(db, { tenantId: job.tenantId, topic: 'job_order.claimed', payload: { jobOrderId: job.id, saleId: sale.id, branchId: job.branchId }, correlationId: auth.correlationId });
      return { ...(await this.view(db, sale)), jobOrder: { id: job.id, reference: jobNumber(job.number), status: 'CLAIMED', downPaymentApplied: applied.toFixed(2), downPaymentReturned: excess.toFixed(2), storageDays: days } };
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
      // Counter service offline: choices are checked against the menu version the till sold from (lenient:
      // the food was handed over), and its tickets were printed by the till itself.
      const menu = env.menuVersionId
        ? { menuVersionId: env.menuVersionId, items: await versionMenuItems(db, env.menuVersionId), pickupName: env.pickupName ?? null, offline: true }
        : null;
      const expanded = expandCounterLines<CounterLineInput>(env.lines, menu);
      const cartAt = (at: Date, knownAt?: Date) =>
        this.tax.computeCart(db, auth, { branchId: session.branchId, lines: expanded.lines }, at, { promotions: true, ...(knownAt && { knownAt }) });
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

      const priced = { ...pricedFromCart(cart, expanded.lines, [], expanded.parentIndex), counter: expanded.plan, prescriptions: env.prescriptions ?? [] };
      priced.offline = { terminalId: ctx.terminalId, reference: env.localReference, flags, completedAt };
      // The number the till printed for the kitchen and the customer (its device number) stays the call number.
      if (priced.counter) priced.counter = { ...priced.counter, tillCallNumber: env.deviceSeq };
      let sale: SaleRow;
      try {
        sale = await this.record(db, auth, session, { clientTransactionId: env.terminalTxnId, tenders: env.tenders, expectedAmountDue: env.amountDue, ...(env.tip && { tip: env.tip }) }, priced);
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

  /** A check's lines and charges for these allocations (ADR-0014 §8); shared by the check and its preview. */
  private async priceCheck(db: Database, bill: typeof orderBills.$inferSelect, allocations: CreateCheckInput['allocations']) {
    const billId = bill.id;
    const [lines, charges, beneficiaries, prior] = await inSequence(
      () => db.select().from(orderBillLines).where(eq(orderBillLines.orderBillId, billId)).orderBy(orderBillLines.lineNo),
      () => db.select().from(orderBillCharges).where(eq(orderBillCharges.orderBillId, billId)),
      () => db.select().from(orderBillBeneficiaries).where(eq(orderBillBeneficiaries.orderBillId, billId)),
      () => db.select({ a: orderBillAllocations, l: saleLines }).from(orderBillAllocations)
        .innerJoin(saleLines, eq(saleLines.id, orderBillAllocations.saleLineId))
        .where(eq(orderBillAllocations.orderBillId, billId)),
    );
    // A voided check paid nothing (audit 2026-10-21): its share is owed again. Its food was still made,
    // and recipe-made lines are never restocked, so `consumed` counts it: paying the share again does
    // not consume the ingredients twice.
    const voided = await voidedChecks(db, billId);
    const consumedBefore = new Map<string, Dec>();
    for (const p of prior) consumedBefore.set(p.a.billLineId, (consumedBefore.get(p.a.billLineId) ?? new Dec(0)).plus(p.l.quantity));
    const paid = new Map<string, { share: Fraction; quantity: Dec; buckets: Buckets[] }>();
    for (const p of prior) {
      if (voided.has(p.a.saleId)) continue;
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
        soldBefore: before.quantity.toString(),
        ...(consumedBefore.has(line.id) && !consumedBefore.get(line.id)!.equals(before.quantity) && { consumedBefore: consumedBefore.get(line.id)!.toString() }),
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
      const before = (await db.select().from(saleCharges).where(eq(saleCharges.orderBillChargeId, c.id))).filter((x) => !voided.has(x.saleId));
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
    input: { clientTransactionId: string; tenders: TendersInput; expectedAmountDue?: string | undefined; tip?: TipInput | undefined },
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
      if (p.purpose !== 'SALE') throw unprocessable('TIP_PAYMENT_AS_TENDER', 'This payment was taken for the tip, not the sale', { paymentIntentId: pid });
    }
    const electronic = intents.reduce((a, p) => a.plus(p.amount), new Dec(0));
    // A laundry claim's down payment pays first (ADR-0024 §5); only the claim path sets it, never a client.
    const downPayment = priced.jobOrder?.downPayment ?? new Dec(0);
    if (electronic.gt(due.minus(downPayment))) throw unprocessable('OVERPAYMENT', 'Card/QR payments exceed the total; cancel one and take the exact amount', { amountDue: due.minus(downPayment).toFixed(2) });

    // Store credit (ADR-0018) next: the customer's balance with this legal entity, never more than is left to pay.
    const creditTender = input.tenders.find((t): t is Extract<TendersInput[number], { method: 'STORE_CREDIT' }> => t.method === 'STORE_CREDIT');
    const storeCredit = creditTender ? toDec(creditTender.amount) : new Dec(0);
    if (creditTender) {
      if (!priced.customerId) throw unprocessable('STORE_CREDIT_NEEDS_CUSTOMER', 'Store credit needs the customer on the sale');
      if (storeCredit.gt(due.minus(downPayment).minus(electronic))) throw unprocessable('OVERPAYMENT', 'Store credit is more than what is left to pay', { amountDue: due.minus(downPayment).minus(electronic).toFixed(2) });
      // One redemption per customer at a time (the insert trigger takes the same lock and re-checks).
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${priced.customerId}:${priced.legalEntityId}`}, 0))`);
      const balance = await creditBalance(db, priced.customerId, priced.legalEntityId);
      if (balance.lt(storeCredit)) throw new AppError('INSUFFICIENT_STORE_CREDIT', 'The customer has less store credit than that', HttpStatus.CONFLICT, { balance: balance.toFixed(2) });
    }

    // Charge to room (ADR-0023 §5.1) next: an in-house guest of this legal entity; all that is left by default.
    const roomTender = input.tenders.find((t): t is Extract<TendersInput[number], { method: 'ROOM_CHARGE' }> => t.method === 'ROOM_CHARGE');
    let roomCharge = new Dec(0);
    let room: Awaited<ReturnType<typeof planRoomCharge>> | null = null;
    if (roomTender) {
      if (priced.offline) throw unprocessable('ROOM_CHARGE_OFFLINE', 'A charge to a room needs the server; the offline till cannot take it');
      const left = due.minus(downPayment).minus(electronic).minus(storeCredit);
      roomCharge = roomTender.amount ? toDec(roomTender.amount) : left;
      if (roomCharge.lte(0)) throw unprocessable('UNNECESSARY_TENDER', 'The sale is already paid');
      if (roomCharge.gt(left)) throw unprocessable('OVERPAYMENT', 'The room charge is more than what is left to pay', { amountDue: left.toFixed(2) });
      room = await planRoomCharge(db, { stayId: roomTender.stayId, legalEntityId: priced.legalEntityId, amount: roomCharge });
    }

    // A tip (session 25): its own card/QR payment of this checkout, or cash on top of what is due. Never
    // part of the amount due or the tenders: the sale, its receipt and the Z reading see none of it.
    const tip = input.tip ? toDec(input.tip.amount) : new Dec(0);
    let tipIntent: (typeof paymentIntents.$inferSelect) | null = null;
    if (input.tip?.paymentIntentId) {
      if (intentIds.includes(input.tip.paymentIntentId)) throw unprocessable('DUPLICATE_TENDER', 'A payment can be tendered once');
      [tipIntent = null] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.tip.paymentIntentId)).for('update');
      const p = tipIntent;
      if (!p) throw new AppError('NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND, { paymentIntentId: input.tip.paymentIntentId });
      if (p.saleId) throw new AppError('PAYMENT_CONSUMED', 'This payment already paid for another sale', HttpStatus.CONFLICT, { paymentIntentId: p.id });
      if (p.status !== 'SUCCEEDED') throw new AppError('PAYMENT_NOT_SUCCEEDED', `This payment is ${p.status.toLowerCase()}`, HttpStatus.CONFLICT, { paymentIntentId: p.id, status: p.status });
      if (p.cashierSessionId !== session.id || p.clientTransactionId !== input.clientTransactionId || p.currency !== priced.currency) {
        throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken for a different checkout', { paymentIntentId: p.id });
      }
      if (p.purpose !== 'TIP') throw unprocessable('TIP_MISMATCH', 'This payment was taken for the sale, not the tip', { paymentIntentId: p.id });
      if (!toDec(p.amount).equals(tip)) throw unprocessable('TIP_MISMATCH', 'The tip payment is not the tip amount', { tip: tip.toFixed(2), paid: toDec(p.amount).toFixed(2) });
    }
    const cashTip = input.tip && !tipIntent ? tip : new Dec(0);

    // Cash covers the rest (and a cash tip); only the last cash tender may give change.
    let remaining = due.minus(downPayment).minus(electronic).minus(storeCredit).minus(roomCharge).plus(cashTip);
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
    if (remaining.gt(0)) throw unprocessable('INSUFFICIENT_TENDER', 'The tendered amount does not cover the total', { amountDue: due.toFixed(2), ...(cashTip.gt(0) && { tip: cashTip.toFixed(2) }) });
    if (cash.slice(0, -1).some((t) => t.change.gt(0))) throw unprocessable('UNNECESSARY_TENDER', 'Only the last tender may give change');
    // The cash tip comes out of the last cash tender: what stays on the tender is what the sale got.
    if (cashTip.gt(0)) {
      const last = cash.at(-1);
      if (!last || last.exchangeReturnId || last.applied.lt(cashTip)) throw unprocessable('TIP_NEEDS_CASH', 'A cash tip is paid with the last cash tendered', { tip: cashTip.toFixed(2) });
      last.applied = last.applied.minus(cashTip);
      last.tendered = last.tendered.minus(cashTip);
    }
    const cashApplied = cash.reduce((a, t) => a.plus(t.applied), new Dec(0));
    const tendered = cash.reduce((a, t) => a.plus(t.tendered), electronic.plus(storeCredit).plus(roomCharge).plus(downPayment));
    const change = tendered.minus(due);

    // Staff on the lines (ADR-0022 §5): of this branch; their commission rate at the sale goes on the line.
    const rates = await this.staffRates(db, session.branchId, priced);
    // Service packages sold and sessions used (ADR-0022 §6), checked and locked before anything is written.
    const today = await this.localDate(db, session.branchId, priced.offline?.completedAt ?? (await dbNow(db)));
    const packages = priced.lines.some((l) => l.productType === 'PACKAGE' || l.packageId)
      ? await planPackages(
          db,
          { customerId: priced.customerId ?? null, legalEntityId: priced.legalEntityId, localDate: today, prices: (ids) => this.pricing.effectivePrices(db, session.branchId, ids) },
          priced.lines.map((l) => ({
            productType: l.productType ?? 'STANDARD', variantId: l.variantId, quantity: l.quantity, exVat: exVat(l), packageId: l.packageId ?? null,
            hasStatutory: l.beneficiaryRef !== null, name: l.name,
          })),
        )
      : EMPTY_PLAN;
    const packageValue = new Map(packages.redeemed.map((r) => [r.index, r.value]));
    // Self-service cycles (ADR-0024 §7): each named machine checked before anything is written.
    const cycles = await this.planCycles(db, session.branchId, priced);
    // Medicines (ADR-0025 §6, §8): the prescriptions filled, who dispenses, SC/PWD purchase booklets.
    const dispenseCtx = {
      tenantId, legalEntityId: priced.legalEntityId, branchId: session.branchId, userId: auth.userId, membershipId: tenantOf(auth).membershipId, offline: Boolean(priced.offline),
      can: (perm: PermissionCode) => this.can(auth, perm, { legalEntityId: priced.legalEntityId, branchId: session.branchId, registerId: session.registerId }),
    };
    const dispensing = await planDispensing(db, dispenseCtx, priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, name: l.name, prescription: l.prescription })), {
      prescriptions: priced.prescriptions ?? [], dispenseApprovalId: priced.dispenseApprovalId,
    });
    if (dispensing.review && priced.offline && !priced.offline.flags.includes('PRESCRIPTION_REVIEW')) priced.offline.flags.push('PRESCRIPTION_REVIEW');
    const booklets = await bookletOf(db, priced.beneficiaries, priced.lines, dispensing.drugs);

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
        customerId: priced.customerId ?? null,
        jobOrderId: priced.jobOrder?.id ?? null,
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
        .values({ tenantId, saleId: sale!.id, schemeCode: b.schemeCode, schemeVersion: b.schemeVersion, name: b.name, idNumber: b.idNumber, tin: b.tin, purchaseBooklet: booklets.get(b.ref) ?? null })
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
        priceOverrideId: l.priceOverrideId ?? null,
        promotionId: l.promotionId ?? null,
        serviceStaffId: l.staffId ?? null,
        commissionRate: l.staffId ? rates.get(`${l.staffId}:${l.variantId}`)! : null,
        customerPackageId: l.packageId ?? null,
        packageValue: packageValue.get(i)?.toString() ?? null,
        machineId: l.machineId ?? null,
        drugClass: dispensing.drugs.get(l.variantId)?.drugClass ?? null,
        drugLabel: dispensing.drugs.get(l.variantId)?.label ?? null,
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
    if (packages !== EMPTY_PLAN) {
      await recordPackages(db, {
        tenantId, legalEntityId: priced.legalEntityId, branchId: session.branchId, customerId: priced.customerId!, saleId: sale!.id, userId: auth.userId, localDate: today,
      }, packages, lineIds);
    }
    const dispensed = dispensing.fills.length || dispensing.newPrescriptions.length || dispensing.approvalId
      ? await recordDispensing(db, dispenseCtx, dispensing, sale!.id, lineIds)
      : null;
    const appointment = priced.appointmentId
      ? await completeAppointment(db, { appointmentId: priced.appointmentId, branchId: session.branchId, saleId: sale!.id, userId: auth.userId, customerId: priced.customerId ?? null })
      : null;

    const tenderRows = [
      ...intents.map((p) => ({ tenantId, saleId: sale!.id, method: p.method, paymentIntentId: p.id, amount: p.amount, tendered: p.amount, change: '0' })),
      ...(creditTender ? [{ tenantId, saleId: sale!.id, method: 'STORE_CREDIT', amount: storeCredit.toString(), tendered: storeCredit.toString(), change: '0' }] : []),
      ...(downPayment.gt(0) ? [{ tenantId, saleId: sale!.id, method: 'JOB_DEPOSIT', jobOrderId: priced.jobOrder!.id, amount: downPayment.toString(), tendered: downPayment.toString(), change: '0' }] : []),
      ...(room ? [{ tenantId, saleId: sale!.id, method: 'ROOM_CHARGE', stayId: room.stay.id, amount: roomCharge.toString(), tendered: roomCharge.toString(), change: '0' }] : []),
      ...cash.map((t) => ({ tenantId, saleId: sale!.id, method: 'CASH', amount: t.applied.toString(), tendered: t.tendered.toString(), change: t.change.toString(), exchangeReturnId: t.exchangeReturnId })),
    ];
    // A laundry claim paid in full by package sessions has nothing to tender (ADR-0024 §10).
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
    if (downPayment.gt(0)) {
      await db.insert(jobOrderDeposits).values({
        tenantId, jobOrderId: priced.jobOrder!.id, legalEntityId: priced.legalEntityId, branchId: session.branchId, kind: 'APPLIED',
        amount: downPayment.negated().toString(), saleId: sale!.id, createdBy: auth.userId,
      });
    }
    for (const c of cycles) {
      await db.insert(machineRuns).values({
        tenantId, branchId: session.branchId, machineId: c.machineId, source: 'SELF_SERVICE', saleId: sale!.id, saleLineId: lineIds[c.index]!,
        startedAt: c.startsAt, plannedMinutes: c.minutes, endsAt: new Date(c.startsAt.getTime() + c.minutes * 60_000), createdBy: auth.userId,
      });
    }
    if (room) {
      await insertEntry(db, {
        tenantId, folioId: room.folio.id, stayId: room.stay.id, kind: 'CHARGE', amount: roomCharge.toString(), saleId: sale!.id,
        description: `Sale #${saleNumber}`, createdBy: auth.userId,
      }, auth.correlationId);
    }
    // Net cash into the drawer = the cash part of the sale (tendered minus change).
    if (cash.length) {
      await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'SALE', amount: cashApplied.toString(), saleId: sale!.id, createdBy: auth.userId });
    }
    if (input.tip) {
      const [tipRow] = await db.insert(saleTips).values({ tenantId, saleId: sale!.id, method: tipIntent?.method ?? 'CASH', paymentIntentId: tipIntent?.id ?? null, amount: tip.toString() }).returning({ id: saleTips.id });
      await this.tipShares(db, tenantId, session.branchId, tipRow!.id, tip, input.tip.shares, priced.lines);
      if (tipIntent) {
        await db.update(paymentIntents).set({ saleId: sale!.id }).where(eq(paymentIntents.id, tipIntent.id));
        await db.insert(paymentEvents).values({ tenantId, paymentIntentId: tipIntent.id, type: 'CONSUMED', detail: { saleId: sale!.id, tip: true }, createdBy: auth.userId });
      } else {
        await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'TIP', amount: cashTip.toString(), saleId: sale!.id, createdBy: auth.userId });
      }
    }

    const stock: (typeof stockMovements.$inferInsert & { variantId: string })[] = priced.lines.flatMap((l, i) =>
      l.trackInventory
        ? [{ tenantId, branchId: session.branchId, variantId: l.variantId, quantity: toDec(l.quantity).negated().toString(), type: 'SALE', saleId: sale!.id, saleLineId: lineIds[i]!, createdBy: auth.userId }]
        : [],
    );
    // Items made from a recipe consume their ingredients with the sale (ADR-0014 §4).
    const consumed = await planConsumption(
      db,
      priced.lines.flatMap((l, i) => (l.trackInventory ? [] : [{ saleLineId: lineIds[i]!, variantId: l.variantId, quantity: l.quantity, ...(l.soldBefore && { soldBefore: l.soldBefore }), ...(l.consumedBefore && { consumedBefore: l.consumedBefore }) }])),
    );
    for (const c of consumed) {
      stock.push({ tenantId, branchId: session.branchId, ...c, type: 'CONSUMPTION', saleId: sale!.id, createdBy: auth.userId });
    }
    // Tingi (ADR-0020): pieces this sale needs and does not have come out of packs it opens itself.
    const entryDate = priced.offline ? await this.localDate(db, session.branchId, priced.offline.completedAt) : undefined;
    // Only a sale that moves stock asks the branch's expired-stock rule (ADR-0025 §4).
    const expiredRule = stock.length ? await expiredStockRule(db, session.branchId) : 'ALLOW';
    const opened = await openPacksForSale(
      db,
      { tenantId, branchId: session.branchId, legalEntityId: priced.legalEntityId, userId: auth.userId, saleId: sale!.id, saleNumber: String(saleNumber), ...(entryDate && { entryDate }) },
      stock.map((m) => ({ variantId: m.variantId, quantity: toDec(m.quantity).negated().toString() })),
      { sellableOnly: !priced.offline && expiredRule === 'BLOCK' },
    );
    // Expired or held lots are not sold where the branch blocks them (ADR-0025 §4); offline sales are flagged instead.
    if (!priced.offline && expiredRule === 'BLOCK') {
      await assertNotExpired(db, session.branchId, priced.lines.flatMap((l) => (l.trackInventory ? [{ variantId: l.variantId, quantity: l.quantity, name: l.name }] : [])));
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
      ...(entryDate && { entryDate }),
      lines: salePosting({
        salesExVat: exVat(priced.totals).minus(serviceCharge),
        serviceCharge,
        vatAmount: priced.totals.vatAmount,
        statutoryDiscount: priced.totals.statutoryDiscount,
        cash: cashApplied,
        electronic,
        storeCredit,
        roomCharge,
        downPayment,
        cogs: moved.reduce((a, m) => a.minus(m.value), new Dec(0)),
        ...(input.tip && { tip: { amount: tip, electronic: tipIntent !== null } }),
        packagesSold: packages.deferred,
        packageSessions: packages.recognized,
      }, session.branchId),
      createdBy: auth.userId,
    });

    // Counter service: the kitchen's copy of what was just paid for (tickets, call number).
    const counterOrder = priced.counter
      ? await recordCounterOrder(db, { tenantId, branchId: session.branchId, saleId: sale!.id, userId: auth.userId }, priced.counter)
      : null;

    await this.audit(db, auth, 'sale.completed', 'sale', sale!.id, {
      saleNumber, amountDue: due.toFixed(2), registerId: session.registerId,
      ...(input.tip && { tip: tip.toFixed(2) }),
      ...(counterOrder && { counterOrderId: counterOrder.id, counterOrderNumber: counterOrder.orderNumber }),
      ...(priced.customerId && { customerId: priced.customerId }),
      ...(creditTender && { storeCredit: storeCredit.toFixed(2) }),
      ...(room && { roomCharge: roomCharge.toFixed(2), stayId: room.stay.id, folioId: room.folio.id }),
      ...(priced.orderBillId && { orderBillId: priced.orderBillId }),
      ...(opened.length > 0 && { packOpenings: opened.map((o) => o.id) }),
      ...(appointment && { appointmentId: appointment.id }),
      ...(priced.jobOrder && { jobOrderId: priced.jobOrder.id, downPayment: downPayment.toFixed(2) }),
      ...(cycles.length > 0 && { machineRuns: cycles.length }),
      ...(dispensed && { prescriptionsRecorded: dispensed.prescriptions, prescriptionFills: dispensed.fills, dispensedBy: dispensing.dispensedBy, ...(dispensing.approvalId && { dispenseApprovalId: dispensing.approvalId }) }),
      ...(dispensing.review && { prescriptionReview: true }),
      ...(expiredOut.length > 0 && { expiredStockLots: expiredOut.length }),
      ...(packages.sold.length > 0 && { packagesSold: packages.sold.reduce((a, p) => a + p.units.length, 0) }),
      ...(packages.redeemed.length > 0 && { packageSessions: packages.redeemed.reduce((a, r) => a + r.sessions, 0) }),
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

  /**
   * Self-service cycles (ADR-0024 §7): a line naming a washer or dryer is a cycle item of that kind, in
   * whole cycles, on a machine of the sale's branch that is in service. Each run starts when the
   * machine's current run ends (a dryer's "+10 min" queues behind itself), else now; one machine at a
   * time (lock), the exclusion constraint as the backstop. Online only.
   */
  private async planCycles(db: Database, branchId: string, priced: PricedSale) {
    const named = priced.lines.flatMap((l, i) => (l.machineId ? [{ machineId: l.machineId, variantId: l.variantId, quantity: l.quantity, i }] : []));
    if (!named.length) return [];
    if (priced.offline) throw unprocessable('MACHINE_OFFLINE', 'A machine is started from the till online only');
    const out: { index: number; machineId: string; minutes: number; startsAt: Date }[] = [];
    for (const n of named) {
      const [m] = await db.select().from(laundryMachines).where(eq(laundryMachines.id, n.machineId));
      if (!m) throw new AppError('NOT_FOUND', 'Machine not found', HttpStatus.NOT_FOUND, { line: n.i, machineId: n.machineId });
      if (m.branchId !== branchId) throw unprocessable('WRONG_BRANCH', 'This machine is at another branch', { line: n.i });
      if (m.archivedAt) throw unprocessable('MACHINE_ARCHIVED', `${m.label} is no longer in use`, { line: n.i });
      if (m.outOfOrderReason) throw new AppError('MACHINE_OUT_OF_ORDER', `${m.label} is out of order`, HttpStatus.CONFLICT, { line: n.i });
      const [v] = await db.select({ kind: productVariants.machineKind, minutes: productVariants.machineMinutes }).from(productVariants).where(eq(productVariants.id, n.variantId));
      if (!v?.kind || !v.minutes) throw unprocessable('NOT_A_CYCLE', 'Only a washer or dryer cycle runs on a machine', { line: n.i });
      if (v.kind !== m.kind) throw unprocessable('MACHINE_KIND_MISMATCH', `This is a ${v.kind.toLowerCase()} cycle; ${m.label} is a ${m.kind.toLowerCase()}`, { line: n.i });
      if (!toDec(n.quantity).isInteger()) throw unprocessable('QUANTITY_NOT_ALLOWED', 'Machine cycles are whole cycles', { line: n.i });
      await lockMachine(db, m.id);
      const minutes = v.minutes * toDec(n.quantity).toNumber();
      if (minutes > 240) throw unprocessable('CYCLE_TOO_LONG', 'At most 4 hours on one machine per line', { line: n.i });
      const queued = out.filter((o) => o.machineId === m.id).map((o) => new Date(o.startsAt.getTime() + o.minutes * 60_000));
      const { rows } = await db.execute<{ at: string }>(sql`
        SELECT greatest(now(), coalesce((SELECT max(coalesce(stopped_at, ends_at)) FROM machine_runs WHERE machine_id = ${m.id} AND coalesce(stopped_at, ends_at) > now()), now()))::text AS at`);
      const startsAt = new Date(Math.max(new Date(rows[0]!.at).getTime(), ...queued.map((d) => d.getTime())));
      out.push({ index: n.i, machineId: m.id, minutes, startsAt });
    }
    return out;
  }

  /**
   * The staff named on a sale's lines (ADR-0022 §5): each a staff member of the sale's branch, active
   * (an offline sale may name one archived since: they did the work). Answers each (staff, item)'s rate.
   */
  private async staffRates(db: Database, branchId: string, priced: PricedSale) {
    const named = priced.lines.flatMap((l, i) => (l.staffId ? [{ staffId: l.staffId, variantId: l.variantId, i }] : []));
    if (!named.length) return new Map<string, string>();
    const ids = [...new Set(named.map((n) => n.staffId))];
    const staff = await db.select().from(serviceStaff).where(inArray(serviceStaff.id, ids));
    for (const n of named) {
      const s = staff.find((x) => x.id === n.staffId);
      if (!s) throw new AppError('NOT_FOUND', 'Staff member not found', HttpStatus.NOT_FOUND, { line: n.i, staffId: n.staffId });
      if (s.branchId !== branchId) throw unprocessable('WRONG_BRANCH', 'This staff member works at another branch', { line: n.i });
      if (s.archivedAt && !priced.offline) throw unprocessable('STAFF_ARCHIVED', `${s.displayName} no longer works here`, { line: n.i });
    }
    // The booking's rule at the till (audit 2026-10-21): a service line names someone who does that
    // service (no list = every service). Online only, like the archived check: offline, the work is done.
    if (!priced.offline) await assertStaffDoServices(db, named, staff);
    return commissionRates(db, named);
  }

  /**
   * A tip's split among staff (ADR-0022 §7): as given (staff of this branch, adding up to the tip), or
   * equally among the distinct staff on the lines in line order, the first ones taking the leftover
   * centavos. A sale without staff keeps an unassigned tip.
   */
  private async tipShares(db: Database, tenantId: string, branchId: string, saleTipId: string, tip: Dec, given: TipInput['shares'], lines: RecordLine[]) {
    let shares: { staffId: string; amount: Dec }[];
    if (given?.length) {
      const total = given.reduce((a, g) => a.plus(g.amount), new Dec(0));
      if (!total.equals(tip)) throw unprocessable('TIP_SHARES_MISMATCH', 'The tip shares do not add up to the tip', { tip: tip.toFixed(2), shares: total.toFixed(2) });
      const staff = await db.select({ id: serviceStaff.id, branchId: serviceStaff.branchId }).from(serviceStaff).where(inArray(serviceStaff.id, given.map((g) => g.staffId)));
      for (const g of given) {
        const s = staff.find((x) => x.id === g.staffId);
        if (!s) throw new AppError('NOT_FOUND', 'Staff member not found', HttpStatus.NOT_FOUND, { staffId: g.staffId });
        if (s.branchId !== branchId) throw unprocessable('WRONG_BRANCH', 'This staff member works at another branch', { staffId: g.staffId });
      }
      shares = given.map((g) => ({ staffId: g.staffId, amount: toDec(g.amount) }));
    } else {
      const staffIds = [...new Set(lines.flatMap((l) => (l.staffId ? [l.staffId] : [])))];
      if (!staffIds.length) return;
      const parts = splitByWeight(tip, staffIds.map(() => new Dec(1)));
      shares = staffIds.map((staffId, i) => ({ staffId, amount: parts[i]! }));
    }
    const kept = shares.filter((x) => x.amount.gt(0));
    if (kept.length) await db.insert(saleTipShares).values(kept.map((x) => ({ tenantId, saleTipId, staffId: x.staffId, amount: x.amount.toString() })));
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
      const { tip, counterOrder } = await this.extras(db, id);
      const roomTender = tenders.find((t) => t.method === 'ROOM_CHARGE' && t.stayId);
      const [roomStay] = roomTender ? await db.select().from(stays).where(eq(stays.id, roomTender.stayId!)) : [];
      const [roomRow] = roomStay ? await db.select({ number: rooms.number }).from(rooms).where(eq(rooms.id, roomStay.roomId)) : [];
      const exchangeIds = tenders.flatMap((t) => (t.exchangeReturnId ? [t.exchangeReturnId] : []));
      const exchanged = exchangeIds.length ? await db.select({ id: saleReturns.id, returnNumber: saleReturns.returnNumber }).from(saleReturns).where(inArray(saleReturns.id, exchangeIds)) : [];
      const snapshot = sale.taxSnapshot as { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
      const promos = await promotionNames(db, lines);
      const staffIds = [...new Set(lines.flatMap((l) => (l.serviceStaffId ? [l.serviceStaffId] : [])))];
      const staffNames = staffIds.length ? await db.select({ id: serviceStaff.id, name: serviceStaff.displayName }).from(serviceStaff).where(inArray(serviceStaff.id, staffIds)) : [];
      const firstName = (id: string | null) => (id ? (staffNames.find((x) => x.id === id)?.name.trim().split(/\s+/)[0] ?? null) : null);
      // The lots each medicine line was drawn from (ADR-0025 §5).
      const { rows: lotRows } = lines.some((l) => l.drugClass)
        ? await db.execute<{ sale_line_id: string; lot_code: string | null; expires_on: string }>(sql`
            SELECT m.sale_line_id, l.lot_code, l.expires_on::text FROM stock_movements m
              JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id
              JOIN stock_lots l ON l.tenant_id = lm.tenant_id AND l.id = lm.lot_id
             WHERE m.sale_id = ${id} AND m.type = 'SALE' GROUP BY 1, 2, 3 ORDER BY 3, 2`)
        : { rows: [] };
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
          staff: firstName(l.serviceStaffId),
          packageSession: l.customerPackageId !== null,
          drugLabel: l.drugLabel,
          lots: lotRows.filter((r) => r.sale_line_id === l.id).map((r) => ({ lotCode: r.lot_code, expiresOn: r.expires_on })),
        })),
        tenders: tenders.map((t) => ({
          method: t.method, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change),
          exchangeReturnNumber: t.exchangeReturnId ? (exchanged.find((r) => r.id === t.exchangeReturnId)?.returnNumber ?? null) : null,
        })),
        beneficiaries,
        charges: charges.map((c) => ({ kind: c.kind, rate: toDec(c.rate).toString(), gross: c.gross, amountDue: c.amountDue, vatTreatment: c.vatTreatment })),
        customer: customer ?? null,
        tip,
        counterOrder: counterOrder ? { orderNumber: counterOrder.callNumber, pickupName: counterOrder.pickupName } : null,
        roomCharge: roomStay && roomRow ? { roomNumber: roomRow.number, guestSurname: surnameOf(await stayGuestName(db, roomStay)), amount: roomTender!.amount } : null,
      });
    });
  }

  /** A sale's tip and, for counter service, the kitchen order it sent (call number, pickup name, tickets). */
  private async extras(db: Database, saleId: string) {
    const [[tipRow], [order]] = await inSequence(
      () => db.select().from(saleTips).where(eq(saleTips.saleId, saleId)),
      () => db.select({ id: restaurantOrders.id, orderNumber: restaurantOrders.orderNumber, tillCallNumber: restaurantOrders.tillCallNumber, pickupName: restaurantOrders.customerName }).from(restaurantOrders).where(eq(restaurantOrders.saleId, saleId)),
    );
    const tickets = order
      ? await db.select({ id: kitchenTickets.id, ticketNumber: kitchenTickets.ticketNumber, stationId: kitchenTickets.stationId }).from(kitchenTickets).where(eq(kitchenTickets.orderId, order.id))
      : [];
    return {
      tip: tipRow ? { method: tipRow.method, amount: fixed(tipRow.amount) } : null,
      // `callNumber`: what the customer's receipt says (an offline till's own number, else the order number).
      counterOrder: order ? { ...order, callNumber: order.tillCallNumber ?? order.orderNumber, tickets } : null,
    };
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
    const [lines, tenders, beneficiaries, charges] = await inSequence(
      () => db.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(saleLines.lineNo),
      () => db.select().from(saleTenders).where(eq(saleTenders.saleId, s.id)).orderBy(saleTenders.createdAt, saleTenders.id),
      () => db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, s.id)),
      () => db.select().from(saleCharges).where(eq(saleCharges.saleId, s.id)),
    );
    const promos = await promotionNames(db, lines);
    return {
      ...this.summary(s),
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
      ...(await this.extras(db, s.id)),
    };
  }
}
