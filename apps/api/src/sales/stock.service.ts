import { Inject, Injectable } from '@nestjs/common';
import { reservedAt } from '../inventory/reservations.service.js';
import { and, branches, eq, inArray, productVariants, sql, stockAdjustments, stockBalances, stockLots, stockMovements, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { stockChangePosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
import type { StockAdjustmentInput, StockQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { HttpStatus } from '@nestjs/common';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

/** Inventory ledger (append-only) and its trigger-maintained balances. Negative stock is allowed and visible. */
@Injectable()
export class StockService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  adjust(auth: AuthContext, input: StockAdjustmentInput) {
    return this.mutate(auth, async (db) => {
      const branch = await this.branch(db, input.branchId);
      this.assertCan(auth, 'inventory.adjust', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      if (branch.archivedAt) throw archived('Branch');
      const ids = [...new Set(input.items.map((i) => i.variantId))];
      const found = await db
        .select({ id: productVariants.id, referenceCost: productVariants.referenceCost })
        .from(productVariants)
        .where(inArray(productVariants.id, ids));
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new AppError('NOT_FOUND', 'Variant not found', HttpStatus.NOT_FOUND, { variantIds: missing });
      const tenantId = tenantOf(auth).tenantId;
      // A lot named for a removal must be one this business can see (the trigger checks item and branch).
      const lotIds = [...new Set(input.items.flatMap((i) => (i.lotId ? [i.lotId] : [])))];
      if (lotIds.length) {
        const seen = await db.select({ id: stockLots.id }).from(stockLots).where(inArray(stockLots.id, lotIds));
        const unknown = lotIds.filter((id) => !seen.some((l) => l.id === id));
        if (unknown.length) throw new AppError('NOT_FOUND', 'Lot not found', HttpStatus.NOT_FOUND, { lotIds: unknown });
      }
      const balances = await db
        .select({ variantId: stockBalances.variantId, avgCost: stockBalances.avgCost })
        .from(stockBalances)
        .where(and(eq(stockBalances.branchId, branch.id), inArray(stockBalances.variantId, ids)));
      // Stock coming in needs a cost (ADR-0012): given, else the last average, else the reference
      // cost, else 0 — the same rule the ledger trigger applies to count surpluses. Removals leave
      // at the average (set by the trigger).
      const inboundCost = (variantId: string, given?: string) => {
        if (given !== undefined) return given;
        const b = balances.find((x) => x.variantId === variantId);
        if (b && toDec(b.avgCost).gt(0)) return b.avgCost;
        return found.find((f) => f.id === variantId)!.referenceCost ?? '0';
      };
      // The document: every movement and the journal entry point to it.
      const [doc] = await db.insert(stockAdjustments).values({ tenantId, branchId: branch.id, kind: input.kind, reason: input.reason, createdBy: auth.userId }).returning();
      const rows = await db
        .insert(stockMovements)
        .values(
          // Sorted by variant: concurrent documents lock balance rows in the same order.
          [...input.items]
            .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))
            .map((i) => ({
              tenantId,
              branchId: branch.id,
              variantId: i.variantId,
              quantity: i.quantity,
              ...(toDec(i.quantity).gt(0) && { unitCost: inboundCost(i.variantId, i.unitCost) }),
              // Expiry lots (ADR-0020 §3): a date coming in; the lot taken first going out (the trigger checks it).
              ...(i.expiresOn && { expiresOn: i.expiresOn, lotCode: i.lotCode ?? null }),
              ...(i.lotId && { lotId: i.lotId }),
              type: input.kind,
              reason: input.reason,
              stockAdjustmentId: doc!.id,
              createdBy: auth.userId,
            })),
        )
        .returning({ id: stockMovements.id, value: stockMovements.value });
      // Books: inventory against adjustments or waste (ADR-0013).
      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: doc!.id,
        memo: `${input.kind === 'WASTE' ? 'Waste' : 'Adjustment'}: ${input.reason}`,
        lines: stockChangePosting(input.kind, rows.reduce((a, r) => a.plus(r.value), new Dec(0)), branch.id),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, input.kind === 'WASTE' ? 'stock.wasted' : 'stock.adjusted', 'branch', branch.id, { count: rows.length, reason: input.reason });
      return { id: doc!.id, movements: rows.length, balances: await this.balanceRows(db, branch.id, ids) };
    });
  }

  getAdjustment(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [doc] = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, id));
      if (!doc) throw notFound('Stock adjustment');
      const branch = await this.branch(db, doc.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const { rows } = await db.execute<{ id: string; variant_id: string; sku: string; name: string; quantity: string; unit_cost: string; value: string }>(sql`
        SELECT m.id, m.variant_id, v.sku, p.name, m.quantity::text, m.unit_cost::text, m.value::text
          FROM stock_movements m
          JOIN product_variants v ON v.tenant_id = m.tenant_id AND v.id = m.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
         WHERE m.stock_adjustment_id = ${doc.id} ORDER BY v.sku`);
      return {
        ...doc,
        value: rows.reduce((a, r) => a.plus(r.value), new Dec(0)).toFixed(2),
        lines: rows.map((r) => ({ movementId: r.id, variantId: r.variant_id, sku: r.sku, name: r.name, quantity: toDec(r.quantity).toString(), unitCost: toDec(r.unit_cost).toFixed(4), value: toDec(r.value).toFixed(2) })),
      };
    });
  }

  listAdjustments(auth: AuthContext, q: StockQuery) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, q.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const rows = await db.select().from(stockAdjustments).where(eq(stockAdjustments.branchId, branch.id)).orderBy(sql`${stockAdjustments.createdAt} DESC`).limit(200);
      return { data: rows };
    });
  }

  balances(auth: AuthContext, q: StockQuery) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, q.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      return { data: await this.balanceRows(db, branch.id, q.variantId ? [q.variantId] : undefined) };
    });
  }

  movements(auth: AuthContext, q: StockQuery) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, q.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const rows = await db
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.branchId, branch.id), q.variantId ? eq(stockMovements.variantId, q.variantId) : undefined))
        .orderBy(sql`${stockMovements.createdAt} DESC, ${stockMovements.id} DESC`)
        .limit(500);
      return { data: rows.map((r) => ({ ...r, quantity: toDec(r.quantity).toString(), unitCost: toDec(r.unitCost).toFixed(4), value: toDec(r.value).toFixed(2) })) };
    });
  }

  private async balanceRows(db: Database, branchId: string, variantIds?: string[]) {
    const { rows } = await db.execute<{ variant_id: string; sku: string; quantity: string; value: string; avg_cost: string; updated_at: string; location: string | null }>(sql`
      SELECT b.variant_id, v.sku, b.quantity::text AS quantity, b.value::text AS value, b.avg_cost::text AS avg_cost, b.updated_at, il.location
        FROM stock_balances b JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
        LEFT JOIN item_locations il ON il.branch_id = b.branch_id AND il.variant_id = b.variant_id
       WHERE b.branch_id = ${branchId}
         ${variantIds ? sql`AND b.variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
       ORDER BY v.sku`);
    const reserved = await reservedAt(db, branchId, variantIds);
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      quantity: toDec(r.quantity).toString(),
      // Session 20: set aside for customers; what is left to sell.
      reserved: (reserved.get(r.variant_id) ?? toDec('0')).toString(),
      available: toDec(r.quantity).minus(reserved.get(r.variant_id) ?? 0).toString(),
      avgCost: toDec(r.avg_cost).toFixed(4),
      value: toDec(r.value).toFixed(2),
      updatedAt: new Date(r.updated_at).toISOString(),
      // Its shelf in the branch (ADR-0021 §5).
      location: r.location,
    }));
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }
}
