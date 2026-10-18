import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  asc,
  eq,
  inArray,
  orderBillAllocations,
  orderBillBeneficiaries,
  orderBillCharges,
  orderBillLines,
  orderBills,
  orderItems,
  restaurantOrders,
  saleLines,
  sales,
  sql,
  type Database,
  inSequence,
} from '@1pos/database';
import { roundTo, toDec, type RoundingMode } from '@1pos/money';
import { serviceCharge, TaxError } from '@1pos/tax';
import type { CreateBillInput, PermissionCode, VoidBillInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { addFraction, frac, ZERO_FRACTION, type Fraction } from '../common/fraction.js';
import { nextNumber } from '../common/sequence.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { engineProfile } from '../tax/tax-profiles.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { loadSettings } from './floor.service.js';

type Bill = typeof orderBills.$inferSelect;
const MONEY_FIELDS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue',
] as const;
const m2 = (v: string) => toDec(v).toFixed(2);
const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(code, message, HttpStatus.CONFLICT, details);

/**
 * Bills (ADR-0014 §8): the order's live items priced and taxed once through the tax path
 * (`TaxService.computeCart`) — SC/PWD per item, an order-level discount, and the service charge as
 * a separate charge line — and frozen. Checks then pay shares of it (SalesService.createFromBill).
 * While billed, the order takes no new items and no voids; the bill can be reopened only before
 * any check is paid.
 */
@Injectable()
export class BillsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    order_bills_one_active: ['BILL_EXISTS', 'This order already has an active bill'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {
    super(tenantDb);
  }

  create(auth: AuthContext, orderId: string, input: CreateBillInput) {
    return this.mutate(auth, async (db) => {
      const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, orderId)).for('update');
      if (!order) throw notFound('Order');
      const { scope } = await branchScope(db, order.branchId);
      this.assertCan(auth, 'restaurant.orders', scope);
      await assertFeature(db, 'restaurant');
      if (order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN', `This order is ${order.status.toLowerCase()}`, { status: order.status });
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.createdAt), asc(orderItems.id));
      if (items.some((i) => i.kind === 'ITEM' && i.status === 'PENDING')) {
        throw conflict('ORDER_HAS_PENDING_ITEMS', 'Send or remove the items not yet sent to the kitchen before billing');
      }
      const live = items.filter((i) => i.kind === 'ITEM' && i.status !== 'VOIDED');
      if (!live.length) throw unprocessable('NOTHING_TO_BILL', 'This order has nothing to bill');
      for (const [i, s] of input.statutory.entries()) {
        if (!live.some((l) => l.id === s.orderItemId)) throw new AppError('NOT_FOUND', 'Item not found on this order', HttpStatus.NOT_FOUND, { path: ['statutory', i, 'orderItemId'] });
      }

      // One cart line per live item, then its priced modifiers (same SC/PWD assignment as the item).
      const plan: { item: typeof live[number]; parentNo: number | null; statutory?: { scheme: string; share?: string }; beneficiary?: string }[] = [];
      for (const it of live) {
        const assigned = input.statutory.find((s) => s.orderItemId === it.id);
        const b = assigned ? input.beneficiaries.find((x) => x.ref === assigned.beneficiary)! : undefined;
        const statutory = b ? { scheme: b.scheme, ...(assigned!.share && { share: assigned!.share }) } : undefined;
        const parentNo = plan.length + 1;
        plan.push({ item: it, parentNo: null, ...(statutory && { statutory, beneficiary: b!.ref }) });
        for (const child of items.filter((c) => c.parentItemId === it.id && c.variantId && c.status !== 'VOIDED')) {
          plan.push({ item: child, parentNo, ...(statutory && { statutory, beneficiary: b!.ref }) });
        }
      }
      const cartLines = (discounts?: Map<number, string>) =>
        plan.map((p, i) => ({
          id: String(i + 1),
          variantId: p.item.variantId!,
          quantity: toDec(p.item.quantity).toString(),
          ...(discounts?.get(i) && { discount: discounts.get(i)! }),
          ...(p.statutory && { statutory: p.statutory }),
        }));
      let cart = await this.tax.computeCart(db, auth, { branchId: order.branchId, lines: cartLines() });
      if (input.discountRate) {
        // An order-level discount, spread line by line on the price basis; statutory lines keep theirs only (no stacking).
        const mode = cart.taxProfile.roundingMode as RoundingMode;
        const discounts = new Map(cart.lines.flatMap((l, i) => (plan[i]!.statutory ? [] : [[i, roundTo(toDec(l.gross).times(input.discountRate!), 2, mode).toString()] as const])));
        cart = await this.tax.computeCart(db, auth, { branchId: order.branchId, lines: cartLines(discounts) });
      }

      const settings = await loadSettings(db, order.branchId);
      const applies = settings && toDec(settings.serviceChargeRate).gt(0) && (order.orderType === 'DINE_IN' ? settings.serviceChargeDineIn : settings.serviceChargeTakeaway);
      let charge: ReturnType<typeof serviceCharge> = null;
      try {
        charge = applies
          ? serviceCharge({ currency: cart.currency, profile: engineProfile(cart.taxProfile) }, cart.lines, { rate: settings.serviceChargeRate, vatTreatment: settings.serviceChargeVatTreatment as 'VATABLE' | 'VAT_EXEMPT' })
          : null;
      } catch (e) {
        if (e instanceof TaxError) throw unprocessable(e.code, e.message);
        throw e;
      }
      const totals = Object.fromEntries(MONEY_FIELDS.map((k) => [k, toDec(cart.totals[k]).plus(charge ? charge[k] : '0').toString()])) as Record<(typeof MONEY_FIELDS)[number], string>;
      if (input.expectedAmountDue !== undefined && !toDec(input.expectedAmountDue).equals(totals.amountDue)) {
        throw conflict('TOTAL_CHANGED', 'Prices or taxes changed since the bill was shown; review the new total', { amountDue: m2(totals.amountDue) });
      }

      const tenantId = tenantOf(auth).tenantId;
      const billNumber = await nextNumber(db, tenantId, order.branchId, 'ORDER_BILL');
      const [bill] = await db
        .insert(orderBills)
        .values({
          tenantId,
          branchId: order.branchId,
          orderId,
          legalEntityId: cart.legalEntityId,
          billNumber,
          currency: cart.currency,
          taxProfileId: cart.taxProfile.id,
          taxSnapshot: cart.taxProfile,
          discountRate: input.discountRate ?? null,
          // Statutory discounts meeting a service charge: the interaction is unverified (compliance Q7/Q15).
          requiresProfessionalReview: cart.requiresProfessionalReview || (charge !== null && input.statutory.length > 0),
          ...totals,
          createdBy: auth.userId,
        })
        .returning();
      const beneficiaryIds = new Map<string, string>();
      for (const b of input.beneficiaries) {
        const scheme = cart.lines.find((_, i) => plan[i]!.beneficiary === b.ref)!.snapshot.scheme!;
        const [row] = await db
          .insert(orderBillBeneficiaries)
          .values({ tenantId, orderBillId: bill!.id, schemeCode: scheme.code, schemeVersion: scheme.version, name: b.name, idNumber: b.idNumber, tin: b.tin ?? null })
          .returning({ id: orderBillBeneficiaries.id });
        beneficiaryIds.set(b.ref, row!.id);
      }
      const lineIds = new Map<number, string>();
      for (const pass of [false, true]) {
        const batch = cart.lines.map((l, i) => ({ l, i, p: plan[i]! })).filter(({ p }) => (p.parentNo !== null) === pass);
        if (!batch.length) continue;
        const rows = await db
          .insert(orderBillLines)
          .values(
            batch.map(({ l, i, p }) => ({
              tenantId,
              orderBillId: bill!.id,
              lineNo: i + 1,
              parentLineId: p.parentNo === null ? null : lineIds.get(p.parentNo)!,
              orderItemId: p.item.id,
              variantId: l.variantId,
              sku: l.sku,
              name: p.item.name,
              taxCategoryCode: l.taxCategoryCode,
              vatTreatment: l.vatTreatment,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              priceIncludesTax: l.priceIncludesTax,
              priceId: l.priceId,
              priceListId: l.priceListId,
              trackInventory: l.trackInventory,
              ...Object.fromEntries(MONEY_FIELDS.map((k) => [k, l[k]])),
              beneficiaryId: p.beneficiary ? beneficiaryIds.get(p.beneficiary)! : null,
              schemeShare: p.statutory ? (l.snapshot.scheme?.share ?? '1') : null,
              taxSnapshot: l.snapshot,
            }) as typeof orderBillLines.$inferInsert),
          )
          .returning({ id: orderBillLines.id, lineNo: orderBillLines.lineNo });
        for (const r of rows) lineIds.set(r.lineNo, r.id);
      }
      if (charge) {
        await db.insert(orderBillCharges).values({
          tenantId,
          orderBillId: bill!.id,
          kind: 'SERVICE_CHARGE',
          base: charge.base,
          rate: charge.rate,
          vatTreatment: settings!.serviceChargeVatTreatment,
          ...Object.fromEntries(MONEY_FIELDS.map((k) => [k, charge![k]])),
          taxSnapshot: charge.snapshot,
        } as typeof orderBillCharges.$inferInsert);
      }
      await db.update(restaurantOrders).set({ status: 'BILLED' }).where(eq(restaurantOrders.id, orderId));
      await this.audit(db, auth, 'order.billed', 'restaurant_order', orderId, { orderBillId: bill!.id, billNumber, amountDue: m2(totals.amountDue), discountRate: input.discountRate ?? null });
      return this.view(db, bill!);
    });
  }

  get(auth: AuthContext, billId: string) {
    return this.read(auth, async (db) => {
      const [bill] = await db.select().from(orderBills).where(eq(orderBills.id, billId));
      if (!bill) throw notFound('Bill');
      const { scope } = await branchScope(db, bill.branchId);
      const perms: PermissionCode[] = ['restaurant.orders', 'restaurant.manage', 'sales.read'];
      if (!perms.some((p) => this.can(auth, p, scope))) this.assertCan(auth, perms[0]!, scope);
      return this.view(db, bill);
    });
  }

  /** Reopen: the bill is voided and the order takes items again — only while no check is paid. */
  voidBill(auth: AuthContext, billId: string, input: VoidBillInput) {
    return this.mutate(auth, async (db) => {
      // Lock order: bill, then order (as checks do).
      const [bill] = await db.select().from(orderBills).where(eq(orderBills.id, billId)).for('update');
      if (!bill) throw notFound('Bill');
      this.assertCan(auth, 'restaurant.orders', (await branchScope(db, bill.branchId)).scope);
      await assertFeature(db, 'restaurant');
      await db.select({ id: restaurantOrders.id }).from(restaurantOrders).where(eq(restaurantOrders.id, bill.orderId)).for('update');
      if (bill.status !== 'ACTIVE') throw conflict('BILL_NOT_ACTIVE', `This bill is ${bill.status.toLowerCase()}`, { status: bill.status });
      const [paid] = await db.select({ id: orderBillAllocations.id }).from(orderBillAllocations).where(eq(orderBillAllocations.orderBillId, billId)).limit(1);
      if (paid) throw conflict('BILL_HAS_CHECKS', 'Part of this bill is already paid; it can no longer be reopened');
      const [row] = await db.update(orderBills).set({ status: 'VOIDED', voidedBy: auth.userId, voidedAt: sql`now()`, voidReason: input.reason }).where(eq(orderBills.id, billId)).returning();
      await db.update(restaurantOrders).set({ status: 'OPEN' }).where(eq(restaurantOrders.id, bill.orderId));
      await this.audit(db, auth, 'order.bill_voided', 'restaurant_order', bill.orderId, { orderBillId: billId, billNumber: bill.billNumber, reason: input.reason });
      return this.view(db, row!);
    });
  }

  async view(db: Database, b: Bill) {
    const [lines, charges, beneficiaries, allocations, checks] = await inSequence(
      () => db.select().from(orderBillLines).where(eq(orderBillLines.orderBillId, b.id)).orderBy(asc(orderBillLines.lineNo)),
      () => db.select().from(orderBillCharges).where(eq(orderBillCharges.orderBillId, b.id)),
      () => db.select().from(orderBillBeneficiaries).where(eq(orderBillBeneficiaries.orderBillId, b.id)),
      () => db.select({ a: orderBillAllocations, quantity: saleLines.quantity }).from(orderBillAllocations)
        .innerJoin(saleLines, eq(saleLines.id, orderBillAllocations.saleLineId))
        .where(eq(orderBillAllocations.orderBillId, b.id)),
      () => db.select({ id: sales.id, saleNumber: sales.saleNumber, registerId: sales.registerId, amountDue: sales.amountDue, completedAt: sales.completedAt })
        .from(sales).where(eq(sales.orderBillId, b.id)).orderBy(asc(sales.completedAt)),
    );
    const money = <T extends Record<string, unknown>>(row: T) => {
      const out: Record<string, unknown> = { ...row };
      for (const k of MONEY_FIELDS) if (typeof out[k] === 'string') out[k] = m2(out[k] as string);
      return out;
    };
    const paidShare = (lineId: string) =>
      allocations.filter((a) => a.a.billLineId === lineId).reduce<Fraction>((acc, a) => addFraction(acc, frac(a.a.shareNum, a.a.shareDen)), ZERO_FRACTION);
    const paidAmount = checks.reduce((a, c) => a.plus(c.amountDue), toDec('0'));
    // The seat each line was ordered for, so the till can split a check by seat.
    const seats = lines.length
      ? await db.select({ id: orderItems.id, seat: orderItems.seat }).from(orderItems).where(inArray(orderItems.id, lines.map((l) => l.orderItemId)))
      : [];
    return {
      ...money(b),
      discountRate: b.discountRate === null ? null : toDec(b.discountRate).toString(),
      lines: lines.map((l) => {
        const share = paidShare(l.id);
        const paidQty = allocations.filter((a) => a.a.billLineId === l.id).reduce((acc, a) => acc.plus(a.quantity), toDec('0'));
        return {
          ...money(l),
          quantity: toDec(l.quantity).toString(),
          unitPrice: toDec(l.unitPrice).toString(),
          paidShare: `${share.n}/${share.d}`,
          paidQuantity: paidQty.toString(),
          fullyPaid: share.n === share.d,
          seat: seats.find((s) => s.id === l.orderItemId)?.seat ?? null,
        };
      }),
      charges: charges.map((c) => ({ ...money(c), base: m2(c.base), rate: toDec(c.rate).toString() })),
      beneficiaries,
      checks: checks.map((c) => ({ ...c, amountDue: m2(c.amountDue) })),
      amountPaid: paidAmount.toFixed(2),
      amountRemaining: toDec(b.amountDue).minus(paidAmount).toFixed(2),
    };
  }
}
