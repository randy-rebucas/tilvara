import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  cashMovements,
  eq,
  inArray,
  productVariants,
  products,
  saleLines,
  saleReturnLines,
  saleReturns,
  sales,
  sql,
  stockMovements,
  type Database,
} from '@1pos/database';
import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';
import type { CreateSaleReturnInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { nextNumber } from '../common/sequence.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';
import { expectedCash, loadSession } from './cash.service.js';
import { saleReturnPosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';

const BUCKETS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales',
] as const;
type Bucket = (typeof BUCKETS)[number];
type Amounts = Record<Bucket | 'amountDue', Dec>;

const zero = (): Amounts => Object.fromEntries([...BUCKETS, 'amountDue'].map((k) => [k, new Dec(0)])) as Amounts;
const out = (a: Amounts) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.toFixed(4)])) as Record<keyof Amounts, string>;

/**
 * Voids and returns (ADR-0011). Append-only documents against the original sale lines, refunded
 * in cash from an open drawer, with stock restored only for RESTOCK lines. Serialized per sale.
 */
@Injectable()
export class ReturnsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  create(auth: AuthContext, saleId: string, input: CreateSaleReturnInput) {
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
      if (!sale) throw notFound('Sale');
      const saleScope = { legalEntityId: sale.legalEntityId, branchId: sale.branchId, registerId: sale.registerId };
      this.assertCan(auth, input.kind === 'VOID' ? 'sales.void' : 'sales.refund', saleScope);
      // One return at a time per sale, so "remaining quantity" cannot be raced.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${saleId}, 0))`);

      const { session, scope } = await loadSession(db, input.cashierSessionId, true);
      if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'The refund drawer session is not open', HttpStatus.CONFLICT);
      if (session.branchId !== sale.branchId) throw unprocessable('WRONG_BRANCH', 'Returns are processed at the branch that made the sale');
      if (session.openedBy !== auth.userId && !this.can(auth, 'cash.reconcile', scope)) {
        throw new AppError('NOT_SESSION_OWNER', 'Refund from your own drawer', HttpStatus.FORBIDDEN);
      }

      const lines = await db
        .select({ line: saleLines, trackInventory: products.trackInventory })
        .from(saleLines)
        .innerJoin(productVariants, eq(productVariants.id, saleLines.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(saleLines.saleId, saleId))
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
      const consumedRows = await db
        .selectDistinct({ saleLineId: stockMovements.saleLineId })
        .from(stockMovements)
        .where(and(eq(stockMovements.saleId, saleId), eq(stockMovements.type, 'CONSUMPTION')));
      const consumed = new Set(consumedRows.map((r) => r.saleLineId));

      let requested: { saleLineId: string; quantity: string; disposition: 'RESTOCK' | 'DAMAGED' }[];
      if (input.kind === 'VOID') {
        if (prior.length) throw new AppError('ALREADY_RETURNED', 'Part of this sale was already returned; use a return instead', HttpStatus.CONFLICT);
        if (sale.cashierSessionId !== session.id) {
          throw unprocessable('VOID_OUTSIDE_SESSION', 'A sale can only be voided in the session that made it; use a return');
        }
        requested = lines.map((l) => ({ saleLineId: l.line.id, quantity: l.line.quantity, disposition: consumed.has(l.line.id) ? 'DAMAGED' : 'RESTOCK' }));
      } else {
        requested = input.lines!;
        const cooked = requested.find((r) => r.disposition === 'RESTOCK' && consumed.has(r.saleLineId));
        if (cooked) {
          throw unprocessable('NOT_RESTOCKABLE', 'This item was made from ingredients and cannot go back into stock; return it as damaged', { saleLineId: cooked.saleLineId });
        }
      }

      const rounding = ((sale.taxSnapshot as { roundingMode?: RoundingMode }).roundingMode ?? 'HALF_UP') as RoundingMode;
      const r2 = (d: Dec) => roundTo(d, 2, rounding);
      const totals = zero();
      const planned = requested.map((req) => {
        const found = lines.find((l) => l.line.id === req.saleLineId);
        if (!found) throw new AppError('NOT_FOUND', 'Sale line not found', HttpStatus.NOT_FOUND, { saleLineId: req.saleLineId });
        const sold = toDec(found.line.quantity);
        const before = priorBy.get(found.line.id) ?? { quantity: new Dec(0), amounts: zero() };
        const remaining = sold.minus(before.quantity);
        const q = toDec(req.quantity);
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
        amounts.amountDue = amounts.vatableSales.plus(amounts.vatAmount).plus(amounts.vatExemptSales).plus(amounts.zeroRatedSales).plus(amounts.percentageTaxSales).minus(amounts.statutoryDiscount);
        for (const k of [...BUCKETS, 'amountDue'] as const) totals[k] = totals[k].plus(amounts[k]);
        return { req, line: found.line, trackInventory: found.trackInventory, quantity: q, amounts };
      });

      const refund = totals.amountDue;
      if (input.expectedRefund !== undefined && !toDec(input.expectedRefund).equals(refund.toDecimalPlaces(2))) {
        throw new AppError('REFUND_CHANGED', 'The refund amount differs from what was shown', HttpStatus.CONFLICT, { refund: refund.toFixed(2) });
      }
      const drawer = toDec(await expectedCash(db, session.id));
      if (drawer.lt(refund)) throw unprocessable('INSUFFICIENT_DRAWER_CASH', 'Not enough cash in this drawer for the refund', { available: drawer.toFixed(2) });

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
          refundMethod: 'CASH',
        })
        .returning();
      const inserted = await db
        .insert(saleReturnLines)
        .values(planned.map((p) => ({ tenantId, saleReturnId: doc!.id, saleLineId: p.line.id, quantity: p.quantity.toString(), disposition: p.req.disposition, ...out(p.amounts) })))
        .returning({ id: saleReturnLines.id, saleLineId: saleReturnLines.saleLineId });

      // Sorted by variant (lock order, ADR-0012 §7); the ledger trigger costs them at the sale's cost.
      const restock = planned
        .filter((p) => p.req.disposition === 'RESTOCK' && p.trackInventory)
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
      await post(db, {
        tenantId,
        legalEntityId: sale.legalEntityId,
        branchId: sale.branchId,
        sourceType: 'SALE_RETURN',
        sourceId: doc!.id,
        memo: `${input.kind === 'VOID' ? 'Void' : 'Return'} #${returnNumber} of sale #${sale.saleNumber}`,
        lines: saleReturnPosting({
          salesExVat: totals.vatableSales.plus(totals.vatExemptSales).plus(totals.zeroRatedSales).plus(totals.percentageTaxSales),
          vatAmount: totals.vatAmount,
          statutoryDiscount: totals.statutoryDiscount,
          refund,
          restocked: restockedValue,
        }, sale.branchId),
        createdBy: auth.userId,
      });
      if (refund.gt(0)) {
        await db.insert(cashMovements).values({
          tenantId,
          cashierSessionId: session.id,
          type: 'REFUND',
          amount: refund.negated().toString(),
          saleId,
          saleReturnId: doc!.id,
          reason: `${input.kind === 'VOID' ? 'Void' : 'Return'} #${returnNumber}`,
          createdBy: auth.userId,
        });
      }
      await this.audit(db, auth, input.kind === 'VOID' ? 'sale.voided' : 'sale.returned', 'sale', saleId, {
        saleReturnId: doc!.id,
        returnNumber,
        refund: refund.toFixed(2),
        reason: input.reason,
      });
      await emitEvent(db, {
        tenantId,
        topic: input.kind === 'VOID' ? 'sale.voided' : 'sale.returned',
        payload: { saleId, saleReturnId: doc!.id, returnNumber },
        correlationId: auth.correlationId,
      });
      return this.view(db, doc!);
    });
  }

  list(auth: AuthContext, saleId: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
      if (!sale) throw notFound('Sale');
      const scope = { legalEntityId: sale.legalEntityId, branchId: sale.branchId, registerId: sale.registerId };
      if (sale.cashierUserId !== auth.userId) this.assertCan(auth, 'sales.read', scope);
      const docs = await db.select().from(saleReturns).where(eq(saleReturns.saleId, saleId)).orderBy(saleReturns.createdAt, saleReturns.id);
      return { data: await Promise.all(docs.map((d) => this.view(db, d))) };
    });
  }

  private async view(db: Database, d: typeof saleReturns.$inferSelect) {
    const lines = await db.select().from(saleReturnLines).where(eq(saleReturnLines.saleReturnId, d.id));
    const money = (v: string) => toDec(v).toFixed(2);
    const fmt = <T extends Record<string, unknown>>(r: T) => {
      const o: Record<string, unknown> = { ...r };
      for (const k of [...BUCKETS, 'amountDue']) if (typeof o[k] === 'string') o[k] = money(o[k] as string);
      return o;
    };
    return { ...fmt(d), lines: lines.map((l) => ({ ...fmt(l), quantity: toDec(l.quantity).toString() })) };
  }
}
