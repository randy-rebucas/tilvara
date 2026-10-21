import { Inject, Injectable } from '@nestjs/common';
import { branches, eq, productVariants, sql, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { ExpiringQuery, LotQuery } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type LotRow = {
  id: string;
  variant_id: string;
  sku: string;
  name: string;
  expires_on: string;
  lot_code: string | null;
  quantity: string;
  avg_cost: string | null;
  days_left: number;
  held: boolean;
};

const view = (r: LotRow) => ({
  lotId: r.id,
  variantId: r.variant_id,
  sku: r.sku,
  name: r.name,
  expiresOn: r.expires_on,
  lotCode: r.lot_code,
  quantity: toDec(r.quantity).toString(),
  /** At the item's average cost (lots carry quantities only, ADR-0020 §3). */
  value: toDec(r.quantity).times(r.avg_cost ?? '0').toFixed(2),
  /** In the branch's calendar; negative once expired. */
  daysLeft: r.days_left,
  /** Its batch is on hold (a recall, ADR-0025 §5). */
  held: r.held,
});

/**
 * Expiry lots (ADR-0020 §3), read-only: the trigger keeps them from the stock movements. Expired stock
 * is written off with a WASTE adjustment that names the lot (`lotId`).
 */
@Injectable()
export class LotsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /** Expired and soon-to-expire lots at a branch, soonest first. */
  expiring(auth: AuthContext, q: ExpiringQuery) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, q.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const { rows: [s] } = await db.execute<{ days: number }>(sql`SELECT expiry_alert_days AS days FROM inventory_settings WHERE branch_id = ${branch.id}`);
      const withinDays = q.withinDays ?? (s?.days || 30);
      // Held lots (a recall, ADR-0025 §5) are listed whatever their date, so they can be written off here.
      const rows = await this.lots(db, branch.id, branch.timezone, sql`AND (l.expires_on <= (now() AT TIME ZONE ${branch.timezone})::date + ${withinDays}::int
        OR (l.lot_code IS NOT NULL AND EXISTS (SELECT 1 FROM lot_holds h WHERE h.variant_id = l.variant_id AND h.released_at IS NULL
              AND upper(btrim(h.lot_code)) = upper(btrim(l.lot_code)) AND (h.branch_id IS NULL OR h.branch_id = l.branch_id))))`);
      const data = rows.map(view);
      return {
        withinDays,
        data,
        expired: { lots: data.filter((d) => d.daysLeft < 0).length, value: data.filter((d) => d.daysLeft < 0).reduce((a, d) => a.plus(d.value), toDec('0')).toFixed(2) },
      };
    });
  }

  /** One item's lots at a branch, and how much of its stock on hand has no date. */
  forItem(auth: AuthContext, q: LotQuery) {
    return this.read(auth, async (db) => {
      const branch = await this.branch(db, q.branchId);
      this.assertCan(auth, 'inventory.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const [item] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, q.variantId));
      if (!item) throw notFound('Item');
      const data = (await this.lots(db, branch.id, branch.timezone, sql`AND l.variant_id = ${q.variantId}`)).map(view);
      const { rows: [b] } = await db.execute<{ quantity: string }>(sql`SELECT quantity::text FROM stock_balances WHERE branch_id = ${branch.id} AND variant_id = ${q.variantId}`);
      const onHand = toDec(b?.quantity ?? '0');
      const dated = data.reduce((a, d) => a.plus(d.quantity), toDec('0'));
      return { data, onHand: onHand.toString(), undated: (onHand.gt(dated) ? onHand.minus(dated) : toDec('0')).toString() };
    });
  }

  private async lots(db: Database, branchId: string, timezone: string, filter: ReturnType<typeof sql>) {
    const { rows } = await db.execute<LotRow>(sql`
      SELECT l.id, l.variant_id, v.sku, concat_ws(' ', p.name, v.name) AS name, l.expires_on::text, l.lot_code, l.quantity::text,
             b.avg_cost::text, (l.expires_on - (now() AT TIME ZONE ${timezone})::date)::int AS days_left,
             (l.lot_code IS NOT NULL AND EXISTS (SELECT 1 FROM lot_holds h WHERE h.variant_id = l.variant_id AND h.released_at IS NULL
                AND upper(btrim(h.lot_code)) = upper(btrim(l.lot_code)) AND (h.branch_id IS NULL OR h.branch_id = l.branch_id))) AS held
        FROM stock_lots l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        LEFT JOIN stock_balances b ON b.tenant_id = l.tenant_id AND b.branch_id = l.branch_id AND b.variant_id = l.variant_id
       WHERE l.branch_id = ${branchId} AND l.quantity > 0 ${filter}
       ORDER BY l.expires_on, p.name, l.lot_code NULLS FIRST
       LIMIT 1000`);
    return rows;
  }

  private async branch(db: Database, id: string) {
    const [row] = await db.select().from(branches).where(eq(branches.id, id));
    if (!row) throw notFound('Branch');
    return row;
  }
}
