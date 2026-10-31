import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  goodsReceiptLines,
  goodsReceipts,
  inArray,
  mapInSequence,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  sql,
  stockBalances,
  stockLots,
  stockMovements,
  supplierReturnLines,
  supplierReturns,
  suppliers,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { CreateGoodsReceiptInput, CreateSupplierReturnInput, GoodsReceiptListQuery, SupplierReturnListQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { nextNumber } from '../common/sequence.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';
import { assertVariants, branchScope } from './purchase-orders.service.js';
import { goodsReceiptPosting, supplierReturnPosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
import { activeSupplier } from './suppliers.service.js';

const byVariant = <T extends { variantId: string }>(a: T, b: T) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);

/** Variant → tracks inventory (services and non-stock items are received/returned without stock movements). */
async function tracking(db: Database, variantIds: string[]) {
  const rows = await db
    .select({ id: productVariants.id, track: products.trackInventory })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, [...new Set(variantIds)]));
  return new Map(rows.map((r) => [r.id, r.track]));
}

/**
 * Goods receipts and supplier returns (SPEC §6.6): append-only documents that move stock at
 * cost (ADR-0012). Receiving against an order locks the order, never exceeds what was ordered
 * (API + DB trigger) and moves the order to PARTIALLY_RECEIVED / RECEIVED.
 */
@Injectable()
export class ReceivingService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  receive(auth: AuthContext, input: CreateGoodsReceiptInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'inventory.adjust', scope);
      if (branch.archivedAt) throw archived('Branch');
      await activeSupplier(db, input.supplierId);
      await assertVariants(db, input.lines.map((l) => l.variantId));
      const tenantId = tenantOf(auth).tenantId;
      // An item that keeps expiry dates comes in with one (ADR-0020 §3).
      const dated = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(inArray(productVariants.id, [...new Set(input.lines.map((l) => l.variantId))]), eq(products.tracksExpiry, true)));
      input.lines.forEach((l, i) => {
        const item = dated.find((d) => d.id === l.variantId);
        if (!item || !toDec(l.quantity).gt(0)) return;
        if (!l.expiresOn) {
          const message = 'This item keeps expiry dates: enter the date on the pack';
          throw unprocessable('EXPIRY_DATE_REQUIRED', message, { line: i, issues: [{ path: `lines.${i}.expiresOn`, message }] });
        }
      });

      // Against an order: lock it, then check every line against what is still outstanding.
      const costs = new Map<number, string>();
      let orderLines: { id: string; variantId: string; quantity: string; unitCost: string; received: Dec }[] = [];
      if (input.purchaseOrderId) {
        const [order] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).for('update');
        if (!order) throw notFound('Purchase order');
        if (order.branchId !== branch.id || order.supplierId !== input.supplierId) {
          throw unprocessable('ORDER_MISMATCH', 'The purchase order is for another branch or supplier');
        }
        if (order.status !== 'APPROVED' && order.status !== 'PARTIALLY_RECEIVED') {
          throw new AppError('ORDER_NOT_OPEN', `A ${order.status.toLowerCase().replace('_', ' ')} purchase order cannot be received`, HttpStatus.CONFLICT, { status: order.status });
        }
        const lines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id));
        const { rows: got } = await db.execute<{ id: string; received: string }>(sql`
          SELECT purchase_order_line_id AS id, sum(quantity)::text AS received FROM goods_receipt_lines
           WHERE purchase_order_line_id IN (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${order.id}) GROUP BY 1`);
        orderLines = lines.map((l) => ({ ...l, received: toDec(got.find((g) => g.id === l.id)?.received ?? '0') }));
        input.lines.forEach((l, i) => {
          if (!l.purchaseOrderLineId) return;
          const ol = orderLines.find((x) => x.id === l.purchaseOrderLineId);
          if (!ol) throw new AppError('NOT_FOUND', 'Order line not found', HttpStatus.NOT_FOUND, { purchaseOrderLineId: l.purchaseOrderLineId });
          if (ol.variantId !== l.variantId) throw unprocessable('LINE_MISMATCH', 'The item differs from the order line', { line: i });
          const remaining = toDec(ol.quantity).minus(ol.received);
          if (toDec(l.quantity).gt(remaining)) {
            throw unprocessable('OVER_RECEIPT', 'More than what is still outstanding on the order line', { line: i, remaining: remaining.toString() });
          }
          costs.set(i, l.unitCost ?? ol.unitCost);
        });
      }

      const receiptNumber = await nextNumber(db, tenantId, branch.id, 'GOODS_RECEIPT');
      const [receipt] = await db
        .insert(goodsReceipts)
        .values({
          tenantId,
          branchId: branch.id,
          supplierId: input.supplierId,
          purchaseOrderId: input.purchaseOrderId ?? null,
          receiptNumber,
          supplierInvoiceRef: input.supplierInvoiceRef ?? null,
          supplierDeliveryRef: input.supplierDeliveryRef ?? null,
          notes: input.notes ?? null,
          receivedBy: auth.userId,
        })
        .returning();
      const inserted = await db
        .insert(goodsReceiptLines)
        .values(
          input.lines.map((l, i) => ({
            tenantId,
            goodsReceiptId: receipt!.id,
            purchaseOrderLineId: l.purchaseOrderLineId ?? null,
            variantId: l.variantId,
            quantity: l.quantity,
            rejectedQuantity: l.rejectedQuantity ?? '0',
            rejectionReason: l.rejectionReason ?? null,
            unitCost: costs.get(i) ?? l.unitCost!,
            expiresOn: l.expiresOn ?? null,
            lotCode: l.lotCode ?? null,
          })),
        )
        .returning();

      const track = await tracking(db, inserted.map((l) => l.variantId));
      const moves = inserted
        .filter((l) => toDec(l.quantity).gt(0) && track.get(l.variantId))
        .map((l) => ({ tenantId, branchId: branch.id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost, type: 'RECEIPT', goodsReceiptLineId: l.id, expiresOn: l.expiresOn, lotCode: l.lotCode, createdBy: auth.userId }))
        .sort(byVariant);
      // One statement per movement, in variant order (audit 2026-10-31 #21): the expiry-lot trigger runs after each
      // row and reads the item's balance, so an item on two dated lines must reach it one movement at a time.
      const moved = await mapInSequence(moves, async (m) => (await db.insert(stockMovements).values(m).returning({ value: stockMovements.value }))[0]!);

      // Books: inventory (ledger value) and the liability at cost; non-stock lines to purchases (ADR-0013).
      const atCost = (stocked: boolean) =>
        inserted.filter((l) => Boolean(track.get(l.variantId)) === stocked).reduce((a, l) => a.plus(toDec(l.quantity).times(l.unitCost).toDecimalPlaces(4)), new Dec(0));
      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        sourceType: 'GOODS_RECEIPT',
        sourceId: receipt!.id,
        memo: `Goods receipt #${receiptNumber}${input.supplierInvoiceRef ? ` (${input.supplierInvoiceRef})` : ''}`,
        lines: goodsReceiptPosting({ stockValue: moved.reduce((a, m) => a.plus(m.value), new Dec(0)), stockAtCost: atCost(true), nonStock: atCost(false) }, branch.id),
        createdBy: auth.userId,
      });

      if (input.purchaseOrderId) {
        const after = orderLines.map((ol) => {
          const now = inserted.filter((l) => l.purchaseOrderLineId === ol.id).reduce((a, l) => a.plus(l.quantity), new Dec(0));
          return ol.received.plus(now).gte(ol.quantity);
        });
        const status = after.every(Boolean) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
        await db.update(purchaseOrders).set({ status, updatedAt: sql`now()` }).where(eq(purchaseOrders.id, input.purchaseOrderId));
      }

      await this.audit(db, auth, 'goods.received', 'goods_receipt', receipt!.id, { receiptNumber, purchaseOrderId: input.purchaseOrderId ?? null, lines: inserted.length });
      await emitEvent(db, { tenantId, topic: 'goods.received', payload: { goodsReceiptId: receipt!.id, branchId: branch.id, supplierId: input.supplierId }, correlationId: auth.correlationId });
      return this.receiptView(db, receipt!);
    });
  }

  returnToSupplier(auth: AuthContext, input: CreateSupplierReturnInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'purchasing.manage', scope);
      if (branch.archivedAt) throw archived('Branch');
      await activeSupplier(db, input.supplierId);
      await assertVariants(db, input.lines.map((l) => l.variantId));
      const tenantId = tenantOf(auth).tenantId;
      // The return's credit comes off GRNI; only a receipt it is tied to clears that again (an invoice or
      // credit note counts the receipt's returns), so stocked goods go back against the receipt they came in on.
      if (!input.goodsReceiptId) {
        const tracked = await tracking(db, input.lines.map((l) => l.variantId));
        const stocked = input.lines.filter((l) => tracked.get(l.variantId)).map((l) => l.variantId);
        if (stocked.length) {
          throw unprocessable('GOODS_RECEIPT_REQUIRED', 'Return stocked items against the goods receipt they came in on', { variantIds: [...new Set(stocked)] });
        }
      }

      const credit = new Map<number, string>();
      if (input.goodsReceiptId) {
        const [receipt] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, input.goodsReceiptId));
        if (!receipt) throw notFound('Goods receipt');
        if (receipt.branchId !== branch.id || receipt.supplierId !== input.supplierId) {
          throw unprocessable('RECEIPT_MISMATCH', 'The goods receipt is for another branch or supplier');
        }
        // One return per receipt at a time, so "still returnable" cannot be raced.
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${receipt.id}, 0))`);
        const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, receipt.id));
        const { rows: back } = await db.execute<{ id: string; returned: string }>(sql`
          SELECT goods_receipt_line_id AS id, sum(quantity)::text AS returned FROM supplier_return_lines
           WHERE goods_receipt_line_id IN (SELECT id FROM goods_receipt_lines WHERE goods_receipt_id = ${receipt.id}) GROUP BY 1`);
        input.lines.forEach((l, i) => {
          if (!l.goodsReceiptLineId) return;
          const rl = lines.find((x) => x.id === l.goodsReceiptLineId);
          if (!rl) throw new AppError('NOT_FOUND', 'Receipt line not found', HttpStatus.NOT_FOUND, { goodsReceiptLineId: l.goodsReceiptLineId });
          if (rl.variantId !== l.variantId) throw unprocessable('LINE_MISMATCH', 'The item differs from the receipt line', { line: i });
          const left = toDec(rl.quantity).minus(back.find((b) => b.id === rl.id)?.returned ?? '0');
          if (toDec(l.quantity).gt(left)) throw unprocessable('RETURN_EXCEEDS_RECEIVED', 'More than what was received and not yet returned', { line: i, remaining: left.toString() });
          credit.set(i, l.creditUnitCost ?? rl.unitCost);
        });
      }
      // Lines not tied to a receipt are credited at the current average unless a credit is given.
      const balances = await db
        .select({ variantId: stockBalances.variantId, avgCost: stockBalances.avgCost })
        .from(stockBalances)
        .where(and(eq(stockBalances.branchId, branch.id), inArray(stockBalances.variantId, input.lines.map((l) => l.variantId))));

      const returnNumber = await nextNumber(db, tenantId, branch.id, 'SUPPLIER_RETURN');
      const [doc] = await db
        .insert(supplierReturns)
        .values({ tenantId, branchId: branch.id, supplierId: input.supplierId, goodsReceiptId: input.goodsReceiptId ?? null, returnNumber, reason: input.reason, createdBy: auth.userId })
        .returning();
      const inserted = await db
        .insert(supplierReturnLines)
        .values(
          input.lines.map((l, i) => ({
            tenantId,
            supplierReturnId: doc!.id,
            goodsReceiptLineId: l.goodsReceiptLineId ?? null,
            variantId: l.variantId,
            quantity: l.quantity,
            creditUnitCost: credit.get(i) ?? l.creditUnitCost ?? balances.find((b) => b.variantId === l.variantId)?.avgCost ?? '0',
          })),
        )
        .returning();
      const track = await tracking(db, inserted.map((l) => l.variantId));
      const lotOf = await this.returnLots(db, branch.id, input);
      // One statement per movement, in variant order: the lot trigger reads the item's balance after each row,
      // so an item on two lines must reach it one movement at a time (as stock adjustments do).
      const moves = inserted
        .map((l, i) => ({ l, lotId: lotOf.get(i) }))
        .filter(({ l }) => track.get(l.variantId))
        .map(({ l, lotId }) => ({
          tenantId, branchId: branch.id, variantId: l.variantId, quantity: toDec(l.quantity).negated().toString(), type: 'SUPPLIER_RETURN',
          supplierReturnLineId: l.id, ...(lotId && { lotId }), createdBy: auth.userId,
        }))
        .sort(byVariant);
      const moved = await mapInSequence(moves, async (m) => (await db.insert(stockMovements).values(m).returning({ value: stockMovements.value }))[0]!);

      const creditFor = (stocked: boolean) =>
        inserted.filter((l) => Boolean(track.get(l.variantId)) === stocked).reduce((a, l) => a.plus(toDec(l.quantity).times(l.creditUnitCost).toDecimalPlaces(4)), new Dec(0));
      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        sourceType: 'SUPPLIER_RETURN',
        sourceId: doc!.id,
        memo: `Supplier return #${returnNumber}: ${input.reason}`,
        lines: supplierReturnPosting({ stockValueOut: moved.reduce((a, m) => a.minus(m.value), new Dec(0)), stockCredit: creditFor(true), nonStockCredit: creditFor(false) }, branch.id),
        createdBy: auth.userId,
      });

      await this.audit(db, auth, 'supplier.returned', 'supplier_return', doc!.id, { returnNumber, reason: input.reason });
      await emitEvent(db, { tenantId, topic: 'supplier.returned', payload: { supplierReturnId: doc!.id, branchId: branch.id, supplierId: input.supplierId }, correlationId: auth.correlationId });
      return this.returnView(db, doc!);
    });
  }

  getReceipt(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [receipt] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, id));
      if (!receipt) throw notFound('Goods receipt');
      await this.assertCanSee(db, auth, receipt.branchId);
      return this.receiptView(db, receipt);
    });
  }

  listReceipts(auth: AuthContext, q: GoodsReceiptListQuery) {
    return this.read(auth, async (db) => {
      await this.assertCanSee(db, auth, q.branchId);
      const rows = await db
        .select({ receipt: goodsReceipts, supplierName: suppliers.name })
        .from(goodsReceipts)
        .innerJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
        .where(
          and(
            eq(goodsReceipts.branchId, q.branchId),
            q.supplierId ? eq(goodsReceipts.supplierId, q.supplierId) : undefined,
            q.purchaseOrderId ? eq(goodsReceipts.purchaseOrderId, q.purchaseOrderId) : undefined,
          ),
        )
        .orderBy(desc(goodsReceipts.createdAt))
        .limit(200);
      return { data: rows.map((r) => ({ ...r.receipt, supplierName: r.supplierName })) };
    });
  }

  getReturn(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [doc] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, id));
      if (!doc) throw notFound('Supplier return');
      await this.assertCanSee(db, auth, doc.branchId);
      return this.returnView(db, doc);
    });
  }

  listReturns(auth: AuthContext, q: SupplierReturnListQuery) {
    return this.read(auth, async (db) => {
      await this.assertCanSee(db, auth, q.branchId);
      const rows = await db
        .select()
        .from(supplierReturns)
        .where(and(eq(supplierReturns.branchId, q.branchId), q.supplierId ? eq(supplierReturns.supplierId, q.supplierId) : undefined))
        .orderBy(desc(supplierReturns.createdAt))
        .limit(200);
      return { data: rows };
    });
  }

  /**
   * Line index → the expiry lot it leaves from (ADR-0020): the lot named, else the lot its receipt line made
   * (a recalled or expired delivery goes back from its own batch). The lot trigger draws it; lots are never written here.
   */
  private async returnLots(db: Database, branchId: string, input: CreateSupplierReturnInput) {
    const out = new Map<number, string>();
    const named = [...new Set(input.lines.flatMap((l) => (l.lotId ? [l.lotId] : [])))];
    if (named.length) {
      const lots = await db.select({ id: stockLots.id, branchId: stockLots.branchId, variantId: stockLots.variantId }).from(stockLots).where(inArray(stockLots.id, named));
      input.lines.forEach((l, i) => {
        if (!l.lotId) return;
        const lot = lots.find((x) => x.id === l.lotId);
        if (!lot) throw new AppError('NOT_FOUND', 'Lot not found', HttpStatus.NOT_FOUND, { lotIds: [l.lotId] });
        if (lot.branchId !== branchId || lot.variantId !== l.variantId) {
          const message = 'This lot is not this item’s at this branch';
          throw unprocessable('LOT_MISMATCH', message, { line: i, issues: [{ path: `lines.${i}.lotId`, message }] });
        }
        out.set(i, l.lotId);
      });
    }
    const fromReceipt = input.lines.flatMap((l, i) => (!l.lotId && l.goodsReceiptLineId ? [{ i, lineId: l.goodsReceiptLineId }] : []));
    if (fromReceipt.length) {
      const { rows } = await db.execute<{ line_id: string; lot_id: string }>(sql`
        SELECT DISTINCT ON (m.goods_receipt_line_id) m.goods_receipt_line_id AS line_id, lm.lot_id
          FROM stock_movements m JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id
         WHERE m.type = 'RECEIPT' AND m.goods_receipt_line_id IN (${sql.join(fromReceipt.map((r) => sql`${r.lineId}::uuid`), sql`, `)})
         ORDER BY m.goods_receipt_line_id, lm.quantity DESC`);
      for (const r of fromReceipt) {
        const lot = rows.find((x) => x.line_id === r.lineId)?.lot_id;
        if (lot) out.set(r.i, lot);
      }
    }
    return out;
  }

  private async assertCanSee(db: Database, auth: AuthContext, branchId: string) {
    const { scope } = await branchScope(db, branchId);
    if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'inventory.read', scope);
  }

  private async receiptView(db: Database, r: typeof goodsReceipts.$inferSelect) {
    const lines = await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, r.id)).orderBy(goodsReceiptLines.createdAt, goodsReceiptLines.id);
    const value = lines.reduce((a, l) => a.plus(toDec(l.quantity).times(l.unitCost)), new Dec(0));
    // What already went back to the supplier, so a return form can offer only the rest.
    const { rows: back } = await db.execute<{ id: string; returned: string }>(sql`
      SELECT goods_receipt_line_id AS id, sum(quantity)::text AS returned FROM supplier_return_lines
       WHERE goods_receipt_line_id IN (SELECT id FROM goods_receipt_lines WHERE goods_receipt_id = ${r.id}) GROUP BY 1`);
    const returns = await db
      .select({ id: supplierReturns.id, returnNumber: supplierReturns.returnNumber, reason: supplierReturns.reason, createdAt: supplierReturns.createdAt })
      .from(supplierReturns)
      .where(eq(supplierReturns.goodsReceiptId, r.id))
      .orderBy(supplierReturns.createdAt);
    return {
      ...r,
      receivedValue: value.toFixed(2),
      returns,
      lines: lines.map((l) => ({
        ...l,
        quantity: toDec(l.quantity).toString(),
        rejectedQuantity: toDec(l.rejectedQuantity).toString(),
        returnedQuantity: toDec(back.find((b) => b.id === l.id)?.returned ?? '0').toString(),
        unitCost: toDec(l.unitCost).toFixed(4),
        lineValue: toDec(l.quantity).times(l.unitCost).toFixed(2),
      })),
    };
  }

  private async returnView(db: Database, d: typeof supplierReturns.$inferSelect) {
    const lines = await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.supplierReturnId, d.id)).orderBy(supplierReturnLines.createdAt, supplierReturnLines.id);
    const credit = lines.reduce((a, l) => a.plus(toDec(l.quantity).times(l.creditUnitCost)), new Dec(0));
    return {
      ...d,
      creditValue: credit.toFixed(2),
      lines: lines.map((l) => ({ ...l, quantity: toDec(l.quantity).toString(), creditUnitCost: toDec(l.creditUnitCost).toFixed(4), creditValue: toDec(l.quantity).times(l.creditUnitCost).toFixed(2) })),
    };
  }
}
