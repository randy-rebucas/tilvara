import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  branches,
  desc,
  eq,
  inArray,
  inventorySettings,
  isNull,
  itemLocations,
  or,
  productVariants,
  products,
  reorderPoints,
  sql,
  stockCountLines,
  stockCounts,
  stockCountSheetLines,
  stockCountSheets,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  BranchQuery,
  CancelCountSheetInput,
  CountSheetLinesInput,
  CountSheetListQuery,
  CreateCountSheetInput,
  CreateStockCountInput,
  CreateStockTransferInput,
  InventorySettingsInput,
  ReceiveStockTransferInput,
  SetItemLocationsInput,
  SetReorderPointsInput,
  StockTransferListQuery,
} from '@1pos/validation';
import { hasPermission } from '../auth/authorization.js';
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

const MAX_SHEET_LINES = 5000;
const sheetClosed = (status: string) =>
  new AppError('COUNT_SHEET_CLOSED', `This count sheet is ${status.toLowerCase()}`, HttpStatus.CONFLICT, { status });

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
      return this.postCount(db, auth, branch, input.lines.map((l) => ({ ...l, expectedQuantity: null })), input.notes ?? null);
    });
  }

  /**
   * One stock count document, its lines, the COUNT movements and the entry. The ledger trigger turns
   * each line into counted − on hand (or counted − expected for a line frozen on a count sheet), under
   * the balance lock; equal → no movement.
   */
  private async postCount(
    db: Database,
    auth: AuthContext,
    branch: { id: string; legalEntityId: string },
    input: { variantId: string; countedQuantity: string; expectedQuantity: string | null }[],
    notes: string | null,
  ) {
    const tenantId = tenantOf(auth).tenantId;
    const countNumber = await nextNumber(db, tenantId, branch.id, 'COUNT');
    const [doc] = await db.insert(stockCounts).values({ tenantId, branchId: branch.id, countNumber, notes, countedBy: auth.userId }).returning();
    const lines = await db
      .insert(stockCountLines)
      .values(input.map((l) => ({ tenantId, stockCountId: doc!.id, variantId: l.variantId, countedQuantity: l.countedQuantity, expectedQuantity: l.expectedQuantity })))
      .returning();
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
    const { rows } = await db.execute<{ id: string; variant_id: string; sku: string; name: string; counted: string; expected: string | null; variance: string | null; unit_cost: string | null; value: string | null }>(sql`
      SELECT l.id, l.variant_id, v.sku, p.name, l.counted_quantity::text AS counted, l.expected_quantity::text AS expected,
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
          /** On hand when the count was posted, or when its count sheet was frozen. */
          systemQuantity: toDec(r.counted).minus(variance).toString(),
          /** From a count sheet: the variance is against this frozen quantity. */
          frozen: r.expected !== null,
          varianceQuantity: variance.toString(),
          varianceValue: toDec(r.value ?? '0').toFixed(2),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- count sheets (blind counts)

  /** Opens a sheet and freezes on hand for its items, in one statement (one consistent snapshot). */
  openCountSheet(auth: AuthContext, input: CreateCountSheetInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'inventory.adjust', scope);
      if (branch.archivedAt) throw archived('Branch');
      let ids: string[];
      if (input.variantIds) {
        ids = [...new Set(input.variantIds)];
        await assertVariants(db, ids);
        await assertStocked(db, ids);
      } else {
        const { rows } = await db.execute<{ variant_id: string }>(sql`
          SELECT b.variant_id FROM stock_balances b
            JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
           WHERE b.branch_id = ${branch.id} AND p.track_inventory AND (b.quantity <> 0 OR v.archived_at IS NULL)
           ORDER BY b.variant_id LIMIT ${MAX_SHEET_LINES + 1}`);
        if (rows.length > MAX_SHEET_LINES) throw unprocessable('COUNT_SHEET_TOO_LARGE', `A sheet holds at most ${MAX_SHEET_LINES} items; count this branch by list`);
        ids = rows.map((r) => r.variant_id);
      }
      if (ids.length === 0) throw unprocessable('NOTHING_TO_COUNT', 'This branch has no stock to count yet');
      const tenantId = tenantOf(auth).tenantId;
      const [sheet] = await db
        .insert(stockCountSheets)
        .values({ tenantId, branchId: branch.id, blind: input.blind, notes: input.notes ?? null, createdBy: auth.userId })
        .returning();
      await this.freezeLines(db, tenantId, sheet!.id, branch.id, ids);
      await this.audit(db, auth, 'stock.count_sheet_opened', 'stock_count_sheet', sheet!.id, { items: ids.length, blind: input.blind });
      return this.sheetView(db, auth, sheet!, scope);
    });
  }

  private async freezeLines(db: Database, tenantId: string, sheetId: string, branchId: string, ids: string[]) {
    await db.execute(sql`
      INSERT INTO stock_count_sheet_lines (tenant_id, sheet_id, variant_id, expected_quantity)
      SELECT ${tenantId}, ${sheetId}, x.id, coalesce(b.quantity, 0)
        FROM unnest(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS x(id)
        LEFT JOIN stock_balances b ON b.tenant_id = ${tenantId} AND b.branch_id = ${branchId} AND b.variant_id = x.id`);
  }

  listCountSheets(auth: AuthContext, q: CountSheetListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCanSeeSheets(auth, scope);
      const { rows } = await db.execute<{ id: string; status: string; blind: boolean; notes: string | null; frozen_at: string; closed_at: string | null; stock_count_id: string | null; lines: number; counted: number }>(sql`
        SELECT s.id, s.status, s.blind, s.notes, s.frozen_at, s.closed_at, s.stock_count_id,
               count(l.id)::int AS lines, count(l.counted_quantity)::int AS counted
          FROM stock_count_sheets s LEFT JOIN stock_count_sheet_lines l ON l.tenant_id = s.tenant_id AND l.sheet_id = s.id
         WHERE s.branch_id = ${q.branchId} ${q.status ? sql`AND s.status = ${q.status}` : sql``}
         GROUP BY s.id ORDER BY s.frozen_at DESC LIMIT 200`);
      return {
        data: rows.map((r) => ({
          id: r.id, status: r.status, blind: r.blind, notes: r.notes, frozenAt: new Date(r.frozen_at).toISOString(),
          closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, stockCountId: r.stock_count_id, lines: r.lines, counted: r.counted,
        })),
      };
    });
  }

  getCountSheet(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const sheet = await this.sheetOrThrow(db, id);
      const { scope } = await branchScope(db, sheet.branchId);
      this.assertCanSeeSheets(auth, scope);
      return this.sheetView(db, auth, sheet, scope);
    });
  }

  /** Counts entered on an open sheet (blind for those who may only count). An item not on it is added, frozen at on hand now. */
  countSheetLines(auth: AuthContext, id: string, input: CountSheetLinesInput) {
    return this.mutate(auth, async (db) => {
      const sheet = await this.sheetOrThrow(db, id);
      const { scope } = await branchScope(db, sheet.branchId);
      if (!this.can(auth, 'inventory.count', scope)) this.assertCan(auth, 'inventory.adjust', scope);
      if (sheet.status !== 'OPEN') throw sheetClosed(sheet.status);
      const tenantId = tenantOf(auth).tenantId;
      const existing = await db.select({ variantId: stockCountSheetLines.variantId }).from(stockCountSheetLines).where(eq(stockCountSheetLines.sheetId, id));
      const added = input.lines.filter((l) => !existing.some((e) => e.variantId === l.variantId));
      if (added.some((l) => l.countedQuantity === null)) throw unprocessable('NOT_ON_SHEET', 'Only items on the sheet can be cleared');
      if (added.length) {
        await assertVariants(db, added.map((l) => l.variantId));
        await assertStocked(db, added.map((l) => l.variantId));
        await this.freezeLines(db, tenantId, id, sheet.branchId, added.map((l) => l.variantId));
      }
      for (const l of [...input.lines].sort(byVariant)) {
        await db
          .update(stockCountSheetLines)
          .set(
            l.countedQuantity === null
              ? { countedQuantity: null, countedBy: null, countedAt: null }
              : { countedQuantity: l.countedQuantity, countedBy: auth.userId, countedAt: sql`now()` },
          )
          .where(and(eq(stockCountSheetLines.sheetId, id), eq(stockCountSheetLines.variantId, l.variantId)));
      }
      await this.audit(db, auth, 'stock.count_sheet_counted', 'stock_count_sheet', id, { lines: input.lines.length, added: added.length });
      return this.sheetView(db, auth, sheet, scope);
    });
  }

  /**
   * Posts the counted lines as one stock count: variance = counted − frozen, so what sold or arrived
   * while people counted stays on the books. Lines left uncounted are not posted (and say so).
   */
  postCountSheet(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const [sheet] = await db.select().from(stockCountSheets).where(eq(stockCountSheets.id, id)).for('update');
      if (!sheet) throw notFound('Count sheet');
      const { branch, scope } = await branchScope(db, sheet.branchId);
      this.assertCan(auth, 'inventory.adjust', scope);
      if (sheet.status !== 'OPEN') throw sheetClosed(sheet.status);
      if (branch.archivedAt) throw archived('Branch');
      const lines = await db.select().from(stockCountSheetLines).where(eq(stockCountSheetLines.sheetId, id));
      const counted = lines.filter((l) => l.countedQuantity !== null);
      if (counted.length === 0) throw unprocessable('NOTHING_COUNTED', 'Enter at least one count before posting');
      const count = await this.postCount(
        db,
        auth,
        branch,
        counted.map((l) => ({ variantId: l.variantId, countedQuantity: l.countedQuantity!, expectedQuantity: l.expectedQuantity })),
        sheet.notes,
      );
      const [posted] = await db
        .update(stockCountSheets)
        .set({ status: 'POSTED', stockCountId: count.id, closedBy: auth.userId, closedAt: sql`now()` })
        .where(eq(stockCountSheets.id, id))
        .returning();
      await this.audit(db, auth, 'stock.count_sheet_posted', 'stock_count_sheet', id, { stockCountId: count.id, posted: counted.length, uncounted: lines.length - counted.length });
      return { sheet: await this.sheetView(db, auth, posted!, scope), count, uncounted: lines.length - counted.length };
    });
  }

  cancelCountSheet(auth: AuthContext, id: string, input: CancelCountSheetInput) {
    return this.mutate(auth, async (db) => {
      const [sheet] = await db.select().from(stockCountSheets).where(eq(stockCountSheets.id, id)).for('update');
      if (!sheet) throw notFound('Count sheet');
      const { scope } = await branchScope(db, sheet.branchId);
      this.assertCan(auth, 'inventory.adjust', scope);
      if (sheet.status !== 'OPEN') throw sheetClosed(sheet.status);
      const [cancelled] = await db
        .update(stockCountSheets)
        .set({ status: 'CANCELLED', closedBy: auth.userId, closedAt: sql`now()`, cancelReason: input.reason })
        .where(eq(stockCountSheets.id, id))
        .returning();
      await this.audit(db, auth, 'stock.count_sheet_cancelled', 'stock_count_sheet', id, { reason: input.reason });
      return this.sheetView(db, auth, cancelled!, scope);
    });
  }

  private assertCanSeeSheets(auth: AuthContext, scope: { branchId: string; legalEntityId: string }) {
    if (!this.can(auth, 'inventory.count', scope)) this.assertCan(auth, 'inventory.read', scope);
  }

  private async sheetOrThrow(db: Database, id: string) {
    const [sheet] = await db.select().from(stockCountSheets).where(eq(stockCountSheets.id, id));
    if (!sheet) throw notFound('Count sheet');
    return sheet;
  }

  /**
   * Frozen quantities, and what moved since the freeze, are shown to those who may adjust stock, and
   * to everyone once the sheet is closed or when it is not blind; someone who may only count sees
   * just what was counted.
   */
  private async sheetView(db: Database, auth: AuthContext, sheet: typeof stockCountSheets.$inferSelect, scope: { branchId: string; legalEntityId: string }) {
    const reveal = !sheet.blind || sheet.status !== 'OPEN' || this.can(auth, 'inventory.adjust', scope);
    const { rows } = await db.execute<{ id: string; variant_id: string; sku: string; name: string; expected: string; counted: string | null; counted_by: string | null; counted_at: string | null; moved: string; location: string | null }>(sql`
      SELECT l.id, l.variant_id, v.sku, p.name, il.location, l.expected_quantity::text AS expected, l.counted_quantity::text AS counted,
             u.display_name AS counted_by, l.counted_at,
             coalesce((SELECT sum(m.quantity) FROM stock_movements m
                        WHERE m.tenant_id = l.tenant_id AND m.branch_id = ${sheet.branchId} AND m.variant_id = l.variant_id
                          AND m.created_at > ${sheet.frozenAt} ${sheet.closedAt ? sql`AND m.created_at < ${sheet.closedAt}` : sql``}), 0)::text AS moved
        FROM stock_count_sheet_lines l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN users u ON u.id = l.counted_by
        LEFT JOIN item_locations il ON il.branch_id = ${sheet.branchId} AND il.variant_id = l.variant_id
       WHERE l.sheet_id = ${sheet.id}
       ORDER BY il.location NULLS LAST, v.sku`);
    return {
      id: sheet.id,
      branchId: sheet.branchId,
      status: sheet.status,
      blind: sheet.blind,
      notes: sheet.notes,
      frozenAt: sheet.frozenAt.toISOString(),
      closedAt: sheet.closedAt?.toISOString() ?? null,
      cancelReason: sheet.cancelReason,
      stockCountId: sheet.stockCountId,
      expectedShown: reveal,
      lines: rows.map((r) => ({
        id: r.id,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        // Counted shelf by shelf (ADR-0021 §5).
        location: r.location,
        countedQuantity: r.counted === null ? null : toDec(r.counted).toString(),
        countedBy: r.counted_by,
        countedAt: r.counted_at ? new Date(r.counted_at).toISOString() : null,
        ...(reveal && {
          expectedQuantity: toDec(r.expected).toString(),
          varianceQuantity: r.counted === null ? null : toDec(r.counted).minus(r.expected).toString(),
          /** Net stock moved since the freeze (sales, receipts…): kept on the books when the sheet posts. */
          movedSinceFreeze: toDec(r.moved).toString(),
        }),
      })),
    };
  }

  // ---------------------------------------------------------------- settings

  getSettings(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, branchId);
      if (!this.can(auth, 'inventory.read', scope)) this.assertCan(auth, 'org.read', scope);
      return this.settingsView(db, branchId);
    });
  }

  /** The owner's call (org.manage): BLOCK makes tills refuse sales. */
  setSettings(auth: AuthContext, branchId: string, input: InventorySettingsInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, branchId);
      this.assertCan(auth, 'org.manage', scope);
      await db
        .insert(inventorySettings)
        .values({ tenantId: tenantOf(auth).tenantId, branchId: branch.id, ...input, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: [inventorySettings.tenantId, inventorySettings.branchId], set: { ...input, updatedBy: auth.userId, updatedAt: sql`now()` } });
      await this.audit(db, auth, 'inventory.settings_updated', 'branch', branch.id, { ...input });
      return this.settingsView(db, branch.id);
    });
  }

  private async settingsView(db: Database, branchId: string) {
    const [row] = await db.select().from(inventorySettings).where(eq(inventorySettings.branchId, branchId));
    return {
      branchId,
      negativeStockPolicy: row?.negativeStockPolicy ?? 'ALLOW',
      lowStockAlerts: row?.lowStockAlerts ?? true,
      expiryAlertDays: row?.expiryAlertDays ?? 30,
      updatedAt: row?.updatedAt.toISOString() ?? null,
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

  // ---------------------------------------------------------------- shelf locations (ADR-0021 §5)
  /** Where items sit in the branch, by location then SKU. */
  listItemLocations(auth: AuthContext, q: BranchQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      return { data: await this.locationRows(db, q.branchId) };
    });
  }

  /** Set or clear (`location: null`) items' shelf locations; needs `inventory.adjust` or `inventory.count` at the branch. */
  setItemLocations(auth: AuthContext, input: SetItemLocationsInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      if (!this.can(auth, 'inventory.count', scope)) this.assertCan(auth, 'inventory.adjust', scope);
      await assertVariants(db, input.items.map((i) => i.variantId));
      const tenantId = tenantOf(auth).tenantId;
      const remove = input.items.filter((i) => !i.location).map((i) => i.variantId);
      if (remove.length) await db.delete(itemLocations).where(and(eq(itemLocations.branchId, branch.id), inArray(itemLocations.variantId, remove)));
      for (const i of input.items.filter((x) => x.location)) {
        await db
          .insert(itemLocations)
          .values({ tenantId, branchId: branch.id, variantId: i.variantId, location: i.location!, updatedBy: auth.userId })
          .onConflictDoUpdate({
            target: [itemLocations.tenantId, itemLocations.branchId, itemLocations.variantId],
            set: { location: i.location!, updatedBy: auth.userId, updatedAt: sql`now()` },
          });
      }
      await this.audit(db, auth, 'stock.locations_set', 'branch', branch.id, { items: input.items.length, removed: remove.length });
      return { data: await this.locationRows(db, branch.id) };
    });
  }

  private async locationRows(db: Database, branchId: string) {
    const { rows } = await db.execute<{ variant_id: string; sku: string; name: string; location: string; updated_at: string }>(sql`
      SELECT l.variant_id, v.sku, CASE WHEN v.name IS NULL THEN p.name ELSE p.name || ' — ' || v.name END AS name, l.location, l.updated_at
        FROM item_locations l
        JOIN product_variants v ON v.id = l.variant_id
        JOIN products p ON p.id = v.product_id
       WHERE l.branch_id = ${branchId}
       ORDER BY l.location, v.sku`);
    return rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, name: r.name, location: r.location, updatedAt: new Date(r.updated_at).toISOString() }));
  }

  /**
   * Stock of every branch the person may read inventory at, item by item (ADR-0021 §5): items with a
   * balance at one of those branches, active ones first by SKU. At most 2,000 items.
   */
  stockByBranch(auth: AuthContext) {
    return this.read(auth, async (db) => {
      const all = await db.select({ id: branches.id, code: branches.code, name: branches.name, legalEntityId: branches.legalEntityId }).from(branches).where(isNull(branches.archivedAt));
      const mine = all
        .filter((b) => hasPermission(tenantOf(auth).grants, 'inventory.read', { branchId: b.id, legalEntityId: b.legalEntityId }))
        .sort((x, y) => (x.code < y.code ? -1 : 1));
      if (!mine.length) throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['inventory.read'] });
      const ids = mine.map((b) => b.id);
      const { rows } = await db.execute<{ variant_id: string; sku: string; name: string; branch_id: string; quantity: string; reserved: string }>(sql`
        WITH items AS (
          SELECT DISTINCT b.variant_id FROM stock_balances b
           WHERE b.branch_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           LIMIT 2000)
        SELECT v.id AS variant_id, v.sku, CASE WHEN v.name IS NULL THEN p.name ELSE p.name || ' — ' || v.name END AS name,
               b.branch_id, b.quantity::text AS quantity,
               coalesce((SELECT sum(r.quantity) FROM stock_reservations r
                          WHERE r.branch_id = b.branch_id AND r.variant_id = b.variant_id AND r.status = 'ACTIVE'
                            AND (r.expires_at IS NULL OR r.expires_at > now())), 0)::text AS reserved
          FROM items i
          JOIN product_variants v ON v.id = i.variant_id
          JOIN products p ON p.id = v.product_id
          JOIN stock_balances b ON b.variant_id = i.variant_id AND b.branch_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         ORDER BY (v.archived_at IS NOT NULL), v.sku`);
      const byItem = new Map<string, { variantId: string; sku: string; name: string; total: Dec; branches: Record<string, { quantity: string; available: string }> }>();
      for (const r of rows) {
        const item = byItem.get(r.variant_id) ?? { variantId: r.variant_id, sku: r.sku, name: r.name, total: new Dec(0), branches: {} };
        item.branches[r.branch_id] = { quantity: toDec(r.quantity).toString(), available: toDec(r.quantity).minus(r.reserved).toString() };
        item.total = item.total.plus(r.quantity);
        byItem.set(r.variant_id, item);
      }
      return {
        branches: mine.map(({ legalEntityId: _e, ...b }) => b),
        data: [...byItem.values()].map((i) => ({ ...i, total: i.total.toString() })),
      };
    });
  }

  /** Every configured reorder point at the branch (low or not), with stock and what is on order. */
  listReorderPoints(auth: AuthContext, q: BranchQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'inventory.read', scope);
      return this.lowStockRows(db, q.branchId, false);
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
