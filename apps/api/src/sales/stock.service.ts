import { Inject, Injectable } from '@nestjs/common';
import { and, branches, eq, inArray, productVariants, sql, stockBalances, stockMovements, type Database } from '@1pos/database';
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
              type: input.kind,
              reason: input.reason,
              createdBy: auth.userId,
            })),
        )
        .returning({ id: stockMovements.id, value: stockMovements.value });
      // Books: inventory against adjustments or waste (ADR-0013). The first movement identifies the document.
      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: rows[0]!.id,
        memo: `${input.kind === 'WASTE' ? 'Waste' : 'Adjustment'}: ${input.reason}`,
        lines: stockChangePosting(input.kind, rows.reduce((a, r) => a.plus(r.value), new Dec(0)), branch.id),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, input.kind === 'WASTE' ? 'stock.wasted' : 'stock.adjusted', 'branch', branch.id, { count: rows.length, reason: input.reason });
      return { movements: rows.length, balances: await this.balanceRows(db, branch.id, ids) };
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
    const { rows } = await db.execute<{ variant_id: string; sku: string; quantity: string; value: string; avg_cost: string; updated_at: string }>(sql`
      SELECT b.variant_id, v.sku, b.quantity::text AS quantity, b.value::text AS value, b.avg_cost::text AS avg_cost, b.updated_at
        FROM stock_balances b JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
       WHERE b.branch_id = ${branchId}
         ${variantIds ? sql`AND b.variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
       ORDER BY v.sku`);
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      quantity: toDec(r.quantity).toString(),
      avgCost: toDec(r.avg_cost).toFixed(4),
      value: toDec(r.value).toFixed(2),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }
}
