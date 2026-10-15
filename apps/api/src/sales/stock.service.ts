import { Inject, Injectable } from '@nestjs/common';
import { and, branches, eq, inArray, productVariants, sql, stockMovements, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
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
      const found = await db.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, ids));
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new AppError('NOT_FOUND', 'Variant not found', HttpStatus.NOT_FOUND, { variantIds: missing });
      const tenantId = tenantOf(auth).tenantId;
      const rows = await db
        .insert(stockMovements)
        .values(input.items.map((i) => ({ tenantId, branchId: branch.id, variantId: i.variantId, quantity: i.quantity, type: 'ADJUSTMENT', reason: input.reason, createdBy: auth.userId })))
        .returning({ id: stockMovements.id });
      await this.audit(db, auth, 'stock.adjusted', 'branch', branch.id, { count: rows.length, reason: input.reason });
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
      return { data: rows.map((r) => ({ ...r, quantity: toDec(r.quantity).toString() })) };
    });
  }

  private async balanceRows(db: Database, branchId: string, variantIds?: string[]) {
    const { rows } = await db.execute<{ variant_id: string; sku: string; quantity: string; updated_at: string }>(sql`
      SELECT b.variant_id, v.sku, b.quantity::text AS quantity, b.updated_at
        FROM stock_balances b JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
       WHERE b.branch_id = ${branchId}
         ${variantIds ? sql`AND b.variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
       ORDER BY v.sku`);
    return rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, quantity: toDec(r.quantity).toString(), updatedAt: new Date(r.updated_at).toISOString() }));
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }
}
