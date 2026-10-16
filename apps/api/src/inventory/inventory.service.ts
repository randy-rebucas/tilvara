import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  or,
  productVariants,
  products,
  reorderPoints,
  sql,
  stockCountLines,
  stockCounts,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { BranchQuery, CreateStockCountInput, CreateStockTransferInput, ReceiveStockTransferInput, SetReorderPointsInput, StockTransferListQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { nextNumber } from '../common/sequence.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { assertVariants, branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { stockChangePosting, transferDispatchPosting, transferReceiptPosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';

const byVariant = <T extends { variantId: string }>(a: T, b: T) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);

/** Only stock-tracked items can be transferred or counted. */
async function assertStocked(db: Database, variantIds: string[]) {
  const rows = await db
    .select({ id: productVariants.id, track: products.trackInventory })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  const untracked = rows.filter((r) => !r.track).map((r) => r.id);
  if (untracked.length) throw unprocessable('NOT_STOCKED', 'These items do not track stock', { variantIds: untracked });
}

/**
 * Transfers between branches, stock counts, and reorder points (SPEC §6.5). Every quantity
 * change is a ledger movement with its source document; costs come from the ledger (ADR-0012).
 */
@Injectable()
export class InventoryService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- transfers

  dispatch(auth: AuthContext, input: CreateStockTransferInput) {
    return this.mutate(auth, async (db) => {
      const from = await branchScope(db, input.fromBranchId);
      this.assertCan(auth, 'inventory.transfer', from.scope);
      const to = await branchScope(db, input.toBranchId);
      if (from.branch.archivedAt) throw archived('Branch');
      if (to.branch.archivedAt) throw archived('Destination branch');
      // Between taxpayers it is a sale, not a transfer: each entity keeps its own books (ADR-0013).
      if (from.branch.legalEntityId !== to.branch.legalEntityId) {
        throw unprocessable('CROSS_ENTITY_TRANSFER', 'Both branches must belong to the same legal entity');
      }
      const ids = input.lines.map((l) => l.variantId);
      await assertVariants(db, ids);
      await assertStocked(db, ids);
      const tenantId = tenantOf(auth).tenantId;
      const transferNumber = await nextNumber(db, tenantId, from.branch.id, 'TRANSFER');
      const [transfer] = await db
        .insert(stockTransfers)
        .values({ tenantId, fromBranchId: from.branch.id, toBranchId: to.branch.id, transferNumber, notes: input.notes ?? null, dispatchedBy: auth.userId })
        .returning();
      const lines = await db
        .insert(stockTransferLines)
        .values(input.lines.map((l) => ({ tenantId, stockTransferId: transfer!.id, variantId: l.variantId, quantity: l.quantity })))
        .returning();
      const out = await db
        .insert(stockMovements)
        .values(
          lines
            .map((l) => ({ tenantId, branchId: from.branch.id, variantId: l.variantId, quantity: toDec(l.quantity).negated().toString(), type: 'TRANSFER_OUT', stockTransferLineId: l.id, createdBy: auth.userId }))
            .sort(byVariant),
        )
        .returning({ value: stockMovements.value });
      await post(db, {
        tenantId,
        legalEntityId: from.branch.legalEntityId,
        branchId: from.branch.id,
        sourceType: 'TRANSFER_DISPATCH',
        sourceId: transfer!.id,
        memo: `Transfer #${transferNumber} dispatched`,
        lines: transferDispatchPosting(out.reduce((a, m) => a.minus(m.value), new Dec(0)), from.branch.id),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'stock.transfer_dispatched', 'stock_transfer', transfer!.id, { transferNumber, toBranchId: to.branch.id });
      await emitEvent(db, { tenantId, topic: 'stock.transfer_dispatched', payload: { stockTransferId: transfer!.id, fromBranchId: from.branch.id, toBranchId: to.branch.id }, correlationId: auth.correlationId });
      return this.transferView(db, transfer!);
    });
  }

  receiveTransfer(auth: AuthContext, id: string, input: ReceiveStockTransferInput) {
    return this.mutate(auth, async (db) => {
      const [transfer] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for('update');
      if (!transfer) throw notFound('Transfer');
      const to = await branchScope(db, transfer.toBranchId);
      // Received by the destination branch.
      this.assertCan(auth, 'inventory.transfer', to.scope);
      if (transfer.status !== 'DISPATCHED') throw new AppError('ALREADY_RECEIVED', 'This transfer was already received', HttpStatus.CONFLICT);
      const lines = await db.select().from(stockTransferLines).where(eq(stockTransferLines.stockTransferId, id));
      for (const given of input.lines) {
        if (!lines.some((l) => l.id === given.transferLineId)) throw new AppError('NOT_FOUND', 'Transfer line not found', HttpStatus.NOT_FOUND, { transferLineId: given.transferLineId });
      }
      const tenantId = tenantOf(auth).tenantId;
      const received = lines.map((l) => {
        const given = input.lines.find((g) => g.transferLineId === l.id);
        const qty = toDec(given?.receivedQuantity ?? l.quantity);
        if (qty.gt(l.quantity)) throw unprocessable('OVER_RECEIPT', 'More than was sent', { transferLineId: l.id, sent: toDec(l.quantity).toString() });
        if (qty.lt(l.quantity) && !given?.discrepancyReason) {
          throw unprocessable('DISCREPANCY_REASON_REQUIRED', 'Say why less arrived than was sent', { transferLineId: l.id });
        }
        return { line: l, qty, reason: qty.lt(l.quantity) ? given!.discrepancyReason! : null };
      });
      for (const r of received) {
        await db.update(stockTransferLines).set({ receivedQuantity: r.qty.toString(), discrepancyReason: r.reason }).where(eq(stockTransferLines.id, r.line.id));
      }
      const moves = received
        .filter((r) => r.qty.gt(0))
        .map((r) => ({ tenantId, branchId: transfer.toBranchId, variantId: r.line.variantId, quantity: r.qty.toString(), type: 'TRANSFER_IN', stockTransferLineId: r.line.id, createdBy: auth.userId }))
        .sort(byVariant);
      const arrived = moves.length
        ? await db.insert(stockMovements).values(moves).returning({ value: stockMovements.value, lineId: stockMovements.stockTransferLineId })
        : [];
      // Books: clear transit at what left the source; shortfall is a loss; any revaluation adjusts COGS.
      const { rows: outs } = await db.execute<{ line_id: string; value: string; unit_cost: string }>(sql`
        SELECT stock_transfer_line_id AS line_id, value::text, unit_cost::text FROM stock_movements
         WHERE type = 'TRANSFER_OUT' AND stock_transfer_line_id IN (SELECT id FROM stock_transfer_lines WHERE stock_transfer_id = ${id})`);
      await post(db, {
        tenantId,
        legalEntityId: to.branch.legalEntityId,
        branchId: transfer.toBranchId,
        sourceType: 'TRANSFER_RECEIPT',
        sourceId: id,
        memo: `Transfer #${transfer.transferNumber} received`,
        lines: transferReceiptPosting(
          received.map((r) => {
            const o = outs.find((x) => x.line_id === r.line.id)!;
            const sent = toDec(o.value).negated();
            return {
              sentValue: sent,
              arrivedAtCost: r.qty.equals(r.line.quantity) ? sent : r.qty.times(o.unit_cost).toDecimalPlaces(4),
              stockValue: arrived.find((m) => m.lineId === r.line.id)?.value ?? '0',
            };
          }),
          transfer.fromBranchId,
          transfer.toBranchId,
        ),
        createdBy: auth.userId,
      });
      const [updated] = await db
        .update(stockTransfers)
        .set({ status: 'RECEIVED', receivedBy: auth.userId, receivedAt: sql`now()`, receiveNotes: input.notes ?? null })
        .where(eq(stockTransfers.id, id))
        .returning();
      const short = received.filter((r) => r.reason).length;
      await this.audit(db, auth, 'stock.transfer_received', 'stock_transfer', id, { shortLines: short });
      await emitEvent(db, { tenantId, topic: 'stock.transfer_received', payload: { stockTransferId: id, shortLines: short }, correlationId: auth.correlationId });
      return this.transferView(db, updated!);
    });
  }

  getTransfer(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [transfer] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id));
      if (!transfer) throw notFound('Transfer');
      const from = await branchScope(db, transfer.fromBranchId);
      const to = await branchScope(db, transfer.toBranchId);
      if (!this.canSeeTransfer(auth, from.scope, to.scope)) this.assertCan(auth, 'inventory.read', to.scope);
      return this.transferView(db, transfer);
    });
  }

  listTransfers(auth: AuthContext, q: StockTransferListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      const side =
        q.direction === 'OUT' ? eq(stockTransfers.fromBranchId, q.branchId)
        : q.direction === 'IN' ? eq(stockTransfers.toBranchId, q.branchId)
        : or(eq(stockTransfers.fromBranchId, q.branchId), eq(stockTransfers.toBranchId, q.branchId));
      const rows = await db
        .select()
        .from(stockTransfers)
        .where(and(side, q.status ? eq(stockTransfers.status, q.status) : undefined))
        .orderBy(desc(stockTransfers.createdAt))
        .limit(200);
      return { data: rows };
    });
  }

  /** Either end of the transfer may see it. */
  private canSeeTransfer(auth: AuthContext, from: { branchId: string; legalEntityId: string }, to: { branchId: string; legalEntityId: string }) {
    return this.can(auth, 'inventory.read', from) || this.can(auth, 'inventory.read', to) || this.can(auth, 'inventory.transfer', to);
  }

  private async transferView(db: Database, t: typeof stockTransfers.$inferSelect) {
    const { rows } = await db.execute<{ id: string; variant_id: string; sku: string; name: string; quantity: string; received_quantity: string | null; discrepancy_reason: string | null; unit_cost: string | null; in_value: string | null }>(sql`
      SELECT l.id, l.variant_id, v.sku, p.name, l.quantity::text, l.received_quantity::text, l.discrepancy_reason,
             o.unit_cost::text AS unit_cost, i.value::text AS in_value
        FROM stock_transfer_lines l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_movements o ON o.tenant_id = l.tenant_id AND o.stock_transfer_line_id = l.id AND o.type = 'TRANSFER_OUT'
        LEFT JOIN stock_movements i ON i.tenant_id = l.tenant_id AND i.stock_transfer_line_id = l.id AND i.type = 'TRANSFER_IN'
       WHERE l.stock_transfer_id = ${t.id}
       ORDER BY v.sku`);
    let sent = new Dec(0);
    let arrived = new Dec(0);
    const lines = rows.map((r) => {
      const cost = toDec(r.unit_cost ?? '0');
      const qty = toDec(r.quantity);
      const got = r.received_quantity === null ? null : toDec(r.received_quantity);
      sent = sent.plus(qty.times(cost));
      if (got) arrived = arrived.plus(toDec(r.in_value ?? '0'));
      return {
        id: r.id,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        quantity: qty.toString(),
        receivedQuantity: got?.toString() ?? null,
        shortQuantity: got ? qty.minus(got).toString() : null,
        discrepancyReason: r.discrepancy_reason,
        unitCost: cost.toFixed(4),
      };
    });
    return {
      ...t,
      lines,
      sentValue: sent.toFixed(2),
      receivedValue: t.status === 'RECEIVED' ? arrived.toFixed(2) : null,
      /** Value that left the source but did not arrive (in transit, or lost if received short). */
      inTransitValue: t.status === 'RECEIVED' ? '0.00' : sent.toFixed(2),
      transitLossValue: t.status === 'RECEIVED' ? sent.minus(arrived).toFixed(2) : null,
    };
  }

  // ---------------------------------------------------------------- counts

  count(auth: AuthContext, input: CreateStockCountInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'inventory.adjust', scope);
      if (branch.archivedAt) throw archived('Branch');
      const ids = input.lines.map((l) => l.variantId);
      await assertVariants(db, ids);
      await assertStocked(db, ids);
      const tenantId = tenantOf(auth).tenantId;
      const countNumber = await nextNumber(db, tenantId, branch.id, 'COUNT');
      const [doc] = await db.insert(stockCounts).values({ tenantId, branchId: branch.id, countNumber, notes: input.notes ?? null, countedBy: auth.userId }).returning();
      const lines = await db
        .insert(stockCountLines)
        .values(input.lines.map((l) => ({ tenantId, stockCountId: doc!.id, variantId: l.variantId, countedQuantity: l.countedQuantity })))
        .returning();
      // The ledger trigger turns each line into counted − on hand, under the balance lock; equal → no movement.
      const moved = await db
        .insert(stockMovements)
        .values(lines.map((l) => ({ tenantId, branchId: branch.id, variantId: l.variantId, quantity: '0', type: 'COUNT', stockCountLineId: l.id, createdBy: auth.userId })).sort(byVariant))
        .returning({ value: stockMovements.value });
      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        sourceType: 'STOCK_COUNT',
        sourceId: doc!.id,
        memo: `Stock count #${countNumber}`,
        lines: stockChangePosting('COUNT', moved.reduce((a, m) => a.plus(m.value), new Dec(0)), branch.id),
        createdBy: auth.userId,
      });
      const view = await this.countView(db, doc!);
      await this.audit(db, auth, 'stock.counted', 'stock_count', doc!.id, { countNumber, lines: lines.length, varianceValue: view.varianceValue });
      await emitEvent(db, { tenantId, topic: 'stock.counted', payload: { stockCountId: doc!.id, branchId: branch.id }, correlationId: auth.correlationId });
      return view;
    });
  }

  getCount(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [doc] = await db.select().from(stockCounts).where(eq(stockCounts.id, id));
      if (!doc) throw notFound('Stock count');
      const { scope } = await branchScope(db, doc.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      return this.countView(db, doc);
    });
  }

  listCounts(auth: AuthContext, q: BranchQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      return { data: await db.select().from(stockCounts).where(eq(stockCounts.branchId, q.branchId)).orderBy(desc(stockCounts.createdAt)).limit(200) };
    });
  }

  private async countView(db: Database, c: typeof stockCounts.$inferSelect) {
    const { rows } = await db.execute<{ id: string; variant_id: string; sku: string; name: string; counted: string; variance: string | null; unit_cost: string | null; value: string | null }>(sql`
      SELECT l.id, l.variant_id, v.sku, p.name, l.counted_quantity::text AS counted,
             m.quantity::text AS variance, m.unit_cost::text AS unit_cost, m.value::text AS value
        FROM stock_count_lines l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_movements m ON m.tenant_id = l.tenant_id AND m.stock_count_line_id = l.id
       WHERE l.stock_count_id = ${c.id}
       ORDER BY v.sku`);
    const total = rows.reduce((a, r) => a.plus(r.value ?? '0'), new Dec(0));
    return {
      ...c,
      varianceValue: total.toFixed(2),
      lines: rows.map((r) => {
        const variance = toDec(r.variance ?? '0');
        return {
          id: r.id,
          variantId: r.variant_id,
          sku: r.sku,
          name: r.name,
          countedQuantity: toDec(r.counted).toString(),
          /** On hand when the count was posted. */
          systemQuantity: toDec(r.counted).minus(variance).toString(),
          varianceQuantity: variance.toString(),
          varianceValue: toDec(r.value ?? '0').toFixed(2),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- reorder points and low stock

  setReorderPoints(auth: AuthContext, input: SetReorderPointsInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'inventory.adjust', scope);
      await assertVariants(db, input.items.map((i) => i.variantId));
      const tenantId = tenantOf(auth).tenantId;
      const remove = input.items.filter((i) => i.reorderPoint === null).map((i) => i.variantId);
      if (remove.length) await db.delete(reorderPoints).where(and(eq(reorderPoints.branchId, branch.id), inArray(reorderPoints.variantId, remove)));
      for (const i of input.items.filter((x) => x.reorderPoint !== null)) {
        await db
          .insert(reorderPoints)
          .values({ tenantId, branchId: branch.id, variantId: i.variantId, reorderPoint: i.reorderPoint!, reorderQuantity: i.reorderQuantity ?? null, updatedBy: auth.userId })
          .onConflictDoUpdate({
            target: [reorderPoints.tenantId, reorderPoints.branchId, reorderPoints.variantId],
            set: { reorderPoint: i.reorderPoint!, reorderQuantity: i.reorderQuantity ?? null, updatedBy: auth.userId, updatedAt: sql`now()` },
          });
      }
      await this.audit(db, auth, 'stock.reorder_points_set', 'branch', branch.id, { items: input.items.length, removed: remove.length });
      return this.lowStockRows(db, branch.id, false);
    });
  }

  /** Items at or below their reorder point, with what is already on order and a suggested order. */
  lowStock(auth: AuthContext, q: BranchQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      return this.lowStockRows(db, q.branchId, true);
    });
  }

  private async lowStockRows(db: Database, branchId: string, onlyLow: boolean) {
    const { rows } = await db.execute<{ variant_id: string; sku: string; name: string; quantity: string; reorder_point: string; reorder_quantity: string | null; on_order: string; avg_cost: string }>(sql`
      WITH on_order AS (
        SELECT l.variant_id, sum(greatest(l.quantity - coalesce((SELECT sum(g.quantity) FROM goods_receipt_lines g WHERE g.tenant_id = l.tenant_id AND g.purchase_order_line_id = l.id), 0), 0)) AS qty
          FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.purchase_order_id
         WHERE o.branch_id = ${branchId} AND o.status IN ('APPROVED', 'PARTIALLY_RECEIVED')
         GROUP BY 1)
      SELECT r.variant_id, v.sku, p.name, coalesce(b.quantity, 0)::text AS quantity, r.reorder_point::text, r.reorder_quantity::text,
             coalesce(o.qty, 0)::text AS on_order, coalesce(b.avg_cost, 0)::text AS avg_cost
        FROM reorder_points r
        JOIN product_variants v ON v.tenant_id = r.tenant_id AND v.id = r.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_balances b ON b.tenant_id = r.tenant_id AND b.branch_id = r.branch_id AND b.variant_id = r.variant_id
        LEFT JOIN on_order o ON o.variant_id = r.variant_id
       WHERE r.branch_id = ${branchId} ${onlyLow ? sql`AND coalesce(b.quantity, 0) <= r.reorder_point` : sql``}
       ORDER BY (coalesce(b.quantity, 0) - r.reorder_point), v.sku`);
    return {
      data: rows.map((r) => {
        const quantity = toDec(r.quantity);
        const point = toDec(r.reorder_point);
        const onOrder = toDec(r.on_order);
        const covered = quantity.plus(onOrder).gt(point);
        const need = r.reorder_quantity ? toDec(r.reorder_quantity) : point.minus(quantity).minus(onOrder);
        return {
          variantId: r.variant_id,
          sku: r.sku,
          name: r.name,
          quantity: quantity.toString(),
          reorderPoint: point.toString(),
          reorderQuantity: r.reorder_quantity === null ? null : toDec(r.reorder_quantity).toString(),
          low: quantity.lte(point),
          onOrder: onOrder.toString(),
          suggestedOrder: covered ? '0' : Dec.max(need, 0).toString(),
          lastCost: toDec(r.avg_cost).toFixed(4),
        };
      }),
    };
  }
}
