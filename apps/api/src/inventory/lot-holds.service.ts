import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, eq, lotHolds, productVariants, sql } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CreateLotHoldInput, LotHoldListQuery, LotTraceQuery, ReleaseLotHoldInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type HoldRow = typeof lotHolds.$inferSelect;

type TraceRow = {
  at: string;
  branch_id: string;
  branch: string;
  variant_id: string;
  sku: string;
  name: string;
  type: string;
  quantity: string;
  expires_on: string;
  sale_id: string | null;
  sale_number: number | null;
  register_code: string | null;
  customer_id: string | null;
  customer: string | null;
  goods_receipt_id: string | null;
  supplier: string | null;
  stock_adjustment_id: string | null;
  pack_opening_id: string | null;
  stock_transfer_id: string | null;
  reason: string | null;
};

/**
 * Batches (ADR-0025 §5, kept for every shop): holds that keep a lot off sale (a recall) and the trace of
 * where a lot came from and went (from the trigger-kept lot draws; no ledger of its own).
 */
@Injectable()
export class LotHoldsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    lot_holds_open_once: ['LOT_ALREADY_HELD', 'This lot is already on hold there'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- holds

  listHolds(auth: AuthContext, q: LotHoldListQuery) {
    this.assertHolds(auth, 'inventory.read');
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<HoldRow & { sku: string; name: string; branch_name: string | null }>(sql`
        SELECT h.id, h.variant_id AS "variantId", h.lot_code AS "lotCode", h.branch_id AS "branchId", h.reason, h.reference,
               h.placed_by AS "placedBy", h.placed_at AS "placedAt", h.released_by AS "releasedBy", h.released_at AS "releasedAt", h.release_reason AS "releaseReason",
               v.sku, concat_ws(' ', p.name, v.name) AS name, b.name AS branch_name,
               pu.display_name AS "placedByName", ru.display_name AS "releasedByName"
          FROM lot_holds h
          LEFT JOIN users pu ON pu.id = h.placed_by
          LEFT JOIN users ru ON ru.id = h.released_by
          JOIN product_variants v ON v.id = h.variant_id JOIN products p ON p.id = v.product_id
          LEFT JOIN branches b ON b.id = h.branch_id
         WHERE true
           ${q.includeReleased ? sql`` : sql`AND h.released_at IS NULL`}
           ${q.variantId ? sql`AND h.variant_id = ${q.variantId}` : sql``}
           ${q.branchId ? sql`AND (h.branch_id IS NULL OR h.branch_id = ${q.branchId})` : sql``}
         ORDER BY h.placed_at DESC
         LIMIT 500`);
      // A hold at one branch is listed to those who may read stock there; a hold everywhere to all readers.
      const scopes = new Map((await db.select({ id: branches.id, legalEntityId: branches.legalEntityId }).from(branches)).map((b) => [b.id, { branchId: b.id, legalEntityId: b.legalEntityId }]));
      const sees = (branchId: string | null) => branchId === null || this.can(auth, 'inventory.read', scopes.get(branchId)!);
      return {
        data: rows.filter((r) => sees(r.branchId)).map(({ branch_name, ...r }) => ({ ...r, branchName: branch_name })),
        /** Whether this person may place a hold at every branch (the business-wide grant); else only at their branches. */
        canHoldEverywhere: this.can(auth, 'inventory.adjust'),
      };
    });
  }

  createHold(auth: AuthContext, input: CreateLotHoldInput) {
    return this.mutate(auth, async (db) => {
      const [item] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, input.variantId));
      if (!item) throw notFound('Item');
      if (input.branchId) {
        const [branch] = await db.select().from(branches).where(eq(branches.id, input.branchId));
        if (!branch) throw notFound('Branch');
        this.assertCan(auth, 'inventory.adjust', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      } else {
        // Every branch: the business-wide grant.
        this.assertCan(auth, 'inventory.adjust');
      }
      const [row] = await db.insert(lotHolds).values({
        tenantId: tenantOf(auth).tenantId, variantId: input.variantId, lotCode: input.lotCode, branchId: input.branchId ?? null, reason: input.reason,
        reference: input.reference ?? null, placedBy: auth.userId,
      }).returning();
      await this.audit(db, auth, 'lot.held', 'lot_hold', row!.id, { variantId: input.variantId, lotCode: input.lotCode, branchId: input.branchId ?? null, reason: input.reason });
      return row!;
    });
  }

  releaseHold(auth: AuthContext, id: string, input: ReleaseLotHoldInput) {
    return this.mutate(auth, async (db) => {
      const [hold] = await db.select().from(lotHolds).where(eq(lotHolds.id, id)).for('update');
      if (!hold) throw notFound('Lot hold');
      if (hold.branchId) {
        const [branch] = await db.select().from(branches).where(eq(branches.id, hold.branchId));
        this.assertCan(auth, 'inventory.adjust', { branchId: branch!.id, legalEntityId: branch!.legalEntityId });
      } else this.assertCan(auth, 'inventory.adjust');
      if (hold.releasedAt) throw new AppError('HOLD_RELEASED', 'This hold was already released', HttpStatus.CONFLICT);
      const [row] = await db.update(lotHolds).set({ releasedAt: sql`now()`, releasedBy: auth.userId, releaseReason: input.reason }).where(eq(lotHolds.id, id)).returning();
      await this.audit(db, auth, 'lot.released', 'lot_hold', id, { reason: input.reason });
      return row!;
    });
  }

  // ---------------------------------------------------------------- trace

  /**
   * Where a batch came from and went: every draw from or addition to lots with this code,
   * of the item and of the pieces opened from it (the pieces keep the pack's lot code), at the branches the
   * caller may see; and what is left per branch. Customers' names only for those who may see customers.
   */
  trace(auth: AuthContext, q: LotTraceQuery) {
    this.assertHolds(auth, 'inventory.read');
    return this.read(auth, async (db) => {
      const [item] = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, q.variantId));
      if (!item) throw notFound('Item');
      const { rows } = await db.execute<TraceRow>(sql`
        WITH RECURSIVE chain(variant_id, depth) AS (
          SELECT ${q.variantId}::uuid, 0
          UNION ALL
          SELECT pc.piece_variant_id, c.depth + 1 FROM chain c JOIN pack_conversions pc ON pc.pack_variant_id = c.variant_id WHERE c.depth < 4)
        SELECT lm.created_at AS at, l.branch_id, b.name AS branch, l.variant_id, v.sku, concat_ws(' ', p.name, v.name) AS name, m.type,
               lm.quantity::text, l.expires_on::text, m.sale_id, s.sale_number, r.code AS register_code, s.customer_id, c.display_name AS customer,
               gl.goods_receipt_id, sup.name AS supplier, m.stock_adjustment_id, m.pack_opening_id, tl.stock_transfer_id, m.reason
          FROM stock_lots l
          JOIN stock_lot_movements lm ON lm.tenant_id = l.tenant_id AND lm.lot_id = l.id
          JOIN stock_movements m ON m.tenant_id = lm.tenant_id AND m.id = lm.movement_id
          JOIN branches b ON b.id = l.branch_id
          JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
          LEFT JOIN sales s ON s.id = m.sale_id
          LEFT JOIN registers r ON r.id = s.register_id
          LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN goods_receipt_lines gl ON gl.id = m.goods_receipt_line_id
          LEFT JOIN goods_receipts g ON g.id = gl.goods_receipt_id
          LEFT JOIN suppliers sup ON sup.id = g.supplier_id
          LEFT JOIN stock_transfer_lines tl ON tl.id = m.stock_transfer_line_id
         WHERE l.variant_id IN (SELECT variant_id FROM chain) AND upper(btrim(l.lot_code)) = upper(btrim(${q.lotCode}))
         ORDER BY lm.created_at, lm.id
         LIMIT 5000`);
      const { rows: left } = await db.execute<{ branch_id: string; branch: string; variant_id: string; sku: string; name: string; expires_on: string; quantity: string }>(sql`
        WITH RECURSIVE chain(variant_id, depth) AS (
          SELECT ${q.variantId}::uuid, 0
          UNION ALL
          SELECT pc.piece_variant_id, c.depth + 1 FROM chain c JOIN pack_conversions pc ON pc.pack_variant_id = c.variant_id WHERE c.depth < 4)
        SELECT l.branch_id, b.name AS branch, l.variant_id, v.sku, concat_ws(' ', p.name, v.name) AS name, l.expires_on::text, l.quantity::text
          FROM stock_lots l JOIN branches b ON b.id = l.branch_id JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
         WHERE l.variant_id IN (SELECT variant_id FROM chain) AND upper(btrim(l.lot_code)) = upper(btrim(${q.lotCode})) AND l.quantity > 0
         ORDER BY b.name, v.sku`);
      const scopes = new Map((await db.select({ id: branches.id, legalEntityId: branches.legalEntityId }).from(branches)).map((b) => [b.id, { branchId: b.id, legalEntityId: b.legalEntityId }]));
      const sees = (branchId: string) => this.can(auth, 'inventory.read', scopes.get(branchId)!);
      const people = (branchId: string) => this.can(auth, 'customers.read', scopes.get(branchId)!);
      return {
        variantId: q.variantId,
        lotCode: q.lotCode,
        movements: rows.filter((r) => sees(r.branch_id)).map((r) => ({
          at: new Date(r.at).toISOString(), branchId: r.branch_id, branch: r.branch, variantId: r.variant_id, sku: r.sku, name: r.name, type: r.type,
          quantity: toDec(r.quantity).toString(), expiresOn: r.expires_on,
          sale: r.sale_id ? { id: r.sale_id, saleNumber: r.sale_number, reference: `${r.register_code}-${String(r.sale_number).padStart(6, '0')}` } : null,
          customer: r.customer_id ? { id: r.customer_id, name: people(r.branch_id) ? r.customer : null } : null,
          goodsReceiptId: r.goods_receipt_id, supplier: r.supplier, stockAdjustmentId: r.stock_adjustment_id, packOpeningId: r.pack_opening_id, stockTransferId: r.stock_transfer_id,
          reason: r.reason,
        })),
        onHand: left.filter((r) => sees(r.branch_id)).map((r) => ({ branchId: r.branch_id, branch: r.branch, variantId: r.variant_id, sku: r.sku, name: r.name, expiresOn: r.expires_on, quantity: toDec(r.quantity).toString() })),
        /** Whether this person may place a hold at every branch (as on the holds list). */
        canHoldEverywhere: this.can(auth, 'inventory.adjust'),
      };
    });
  }
}
