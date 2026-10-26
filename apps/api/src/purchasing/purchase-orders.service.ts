import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  branches,
  desc,
  eq,
  inArray,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  sql,
  suppliers,
  type Database,
  inSequence,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { PermissionCode, CreatePurchaseOrderInput, EndPurchaseOrderInput, PurchaseOrderListQuery, UpdatePurchaseOrderInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { nextNumber } from '../common/sequence.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { activeSupplier } from './suppliers.service.js';
import { withCatalogCosts } from './supplier-items.service.js';

type OrderRow = typeof purchaseOrders.$inferSelect;

/** Branch + scope for permission checks (404 across tenants). */
export async function branchScope(db: Database, branchId: string) {
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch) throw notFound('Branch');
  return { branch, scope: { branchId: branch.id, legalEntityId: branch.legalEntityId } };
}

export async function assertVariants(db: Database, ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await db.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, unique));
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new AppError('NOT_FOUND', 'Variant not found', HttpStatus.NOT_FOUND, { variantIds: missing });
}

const invalidState = (status: string, action: string) =>
  new AppError('INVALID_STATE', `A ${status.toLowerCase().replace('_', ' ')} purchase order cannot be ${action}`, HttpStatus.CONFLICT, { status });

/**
 * Purchase orders (SPEC §6.6). Creating or approving an order never changes stock; stock rises
 * only when goods are received (ReceivingService). Lines are editable only while DRAFT.
 */
@Injectable()
export class PurchaseOrdersService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  create(auth: AuthContext, input: CreatePurchaseOrderInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'purchasing.manage', scope);
      if (branch.archivedAt) throw archived('Branch');
      await activeSupplier(db, input.supplierId);
      await assertVariants(db, input.lines.map((l) => l.variantId));
      const tenantId = tenantOf(auth).tenantId;
      const poNumber = await nextNumber(db, tenantId, branch.id, 'PURCHASE_ORDER');
      const [order] = await db
        .insert(purchaseOrders)
        .values({
          tenantId,
          branchId: branch.id,
          supplierId: input.supplierId,
          poNumber,
          expectedOn: input.expectedOn ?? null,
          supplierRef: input.supplierRef ?? null,
          notes: input.notes ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await this.insertLines(db, tenantId, order!.id, await withCatalogCosts(db, input.supplierId, input.lines));
      await this.audit(db, auth, 'purchase_order.created', 'purchase_order', order!.id, { poNumber, lines: input.lines.length });
      return this.view(db, order!);
    });
  }

  update(auth: AuthContext, id: string, input: UpdatePurchaseOrderInput) {
    return this.mutate(auth, async (db) => {
      const order = await this.load(db, auth, id, 'purchasing.manage', true);
      if (order.status !== 'DRAFT') throw invalidState(order.status, 'edited');
      if (input.supplierId) await activeSupplier(db, input.supplierId);
      const { lines, ...header } = input;
      const [updated] = await db.update(purchaseOrders).set({ ...header, updatedAt: sql`now()` }).where(eq(purchaseOrders.id, id)).returning();
      if (lines) {
        await assertVariants(db, lines.map((l) => l.variantId));
        await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
        await this.insertLines(db, tenantOf(auth).tenantId, id, await withCatalogCosts(db, input.supplierId ?? order.supplierId, lines));
      }
      await this.audit(db, auth, 'purchase_order.updated', 'purchase_order', id, { fields: Object.keys(input) });
      return this.view(db, updated!);
    });
  }

  approve(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const order = await this.load(db, auth, id, 'purchasing.manage', true);
      if (order.status !== 'DRAFT') throw invalidState(order.status, 'approved');
      await activeSupplier(db, order.supplierId);
      const [updated] = await db
        .update(purchaseOrders)
        .set({ status: 'APPROVED', approvedBy: auth.userId, approvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(purchaseOrders.id, id))
        .returning();
      await this.audit(db, auth, 'purchase_order.approved', 'purchase_order', id, { poNumber: order.poNumber });
      await emitEvent(db, { tenantId: order.tenantId, topic: 'purchase_order.approved', payload: { purchaseOrderId: id, supplierId: order.supplierId }, correlationId: auth.correlationId });
      return this.view(db, updated!);
    });
  }

  /** DRAFT or APPROVED (nothing received) → CANCELLED. */
  cancel(auth: AuthContext, id: string, input: EndPurchaseOrderInput) {
    return this.end(auth, id, input, ['DRAFT', 'APPROVED'], 'CANCELLED', 'cancelled');
  }

  /** Stop expecting the rest: PARTIALLY_RECEIVED or RECEIVED → CLOSED. */
  close(auth: AuthContext, id: string, input: EndPurchaseOrderInput) {
    return this.end(auth, id, input, ['PARTIALLY_RECEIVED', 'RECEIVED'], 'CLOSED', 'closed');
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => this.view(db, await this.load(db, auth, id, 'inventory.read')));
  }

  list(auth: AuthContext, q: PurchaseOrderListQuery) {
    return this.read(auth, async (db) => {
      const rows = await db
        .select({ order: purchaseOrders, legalEntityId: branches.legalEntityId, supplierName: suppliers.name })
        .from(purchaseOrders)
        .innerJoin(branches, eq(branches.id, purchaseOrders.branchId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(
          and(
            q.branchId ? eq(purchaseOrders.branchId, q.branchId) : undefined,
            q.supplierId ? eq(purchaseOrders.supplierId, q.supplierId) : undefined,
            q.status ? eq(purchaseOrders.status, q.status) : undefined,
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt))
        .limit(200);
      const visible = rows.filter((r) => this.canSee(auth, { branchId: r.order.branchId, legalEntityId: r.legalEntityId }));
      const totals = await this.totals(db, visible.map((r) => r.order.id));
      return { data: visible.map((r) => ({ ...r.order, supplierName: r.supplierName, ...(totals.get(r.order.id) ?? { orderedValue: '0.00' }) })) };
    });
  }

  private end(auth: AuthContext, id: string, input: EndPurchaseOrderInput, from: string[], to: 'CANCELLED' | 'CLOSED', verb: string) {
    return this.mutate(auth, async (db) => {
      const order = await this.load(db, auth, id, 'purchasing.manage', true);
      if (!from.includes(order.status)) throw invalidState(order.status, verb);
      const [updated] = await db
        .update(purchaseOrders)
        .set({ status: to, endedBy: auth.userId, endedAt: sql`now()`, endReason: input.reason, updatedAt: sql`now()` })
        .where(eq(purchaseOrders.id, id))
        .returning();
      await this.audit(db, auth, `purchase_order.${verb}`, 'purchase_order', id, { reason: input.reason });
      return this.view(db, updated!);
    });
  }

  /** Load (optionally lock) an order and check the permission at its branch; 404 across tenants. */
  private async load(db: Database, auth: AuthContext, id: string, perm: PermissionCode, lock = false) {
    const query = db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    const [order] = lock ? await query.for('update') : await query;
    if (!order) throw notFound('Purchase order');
    const { scope } = await branchScope(db, order.branchId);
    if (perm === 'inventory.read') {
      if (!this.canSee(auth, scope)) this.assertCan(auth, 'inventory.read', scope);
    } else this.assertCan(auth, perm, scope);
    return order;
  }

  private canSee(auth: AuthContext, scope: { branchId: string; legalEntityId: string }) {
    return this.can(auth, 'purchasing.manage', scope) || this.can(auth, 'inventory.read', scope);
  }

  private async insertLines(db: Database, tenantId: string, orderId: string, lines: (CreatePurchaseOrderInput['lines'][number] & { unitCost: string })[]) {
    await db.insert(purchaseOrderLines).values(lines.map((l, i) => ({ tenantId, purchaseOrderId: orderId, lineNo: i + 1, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost })));
  }

  private async totals(db: Database, ids: string[]) {
    if (!ids.length) return new Map<string, { orderedValue: string }>();
    const rows = await db
      .select({ id: purchaseOrderLines.purchaseOrderId, value: sql<string>`sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.unitCost})::text` })
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.purchaseOrderId, ids))
      .groupBy(purchaseOrderLines.purchaseOrderId);
    return new Map(rows.map((r) => [r.id, { orderedValue: toDec(r.value).toFixed(2) }]));
  }

  /** Order with lines, received/rejected/remaining per line, and its receipts. */
  async view(db: Database, order: OrderRow) {
    const [[supplier], { rows: lines }, { rows: receipts }] = await inSequence(
      () => db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, order.supplierId)),
      () => db.execute<{ id: string; line_no: number; variant_id: string; sku: string; name: string; quantity: string; unit_cost: string; received: string; rejected: string; supplier_sku: string | null; tracks_expiry: boolean }>(sql`
        SELECT l.id, l.line_no, l.variant_id, v.sku, p.name, p.tracks_expiry, l.quantity::text, l.unit_cost::text,
               (SELECT si.supplier_sku FROM supplier_items si WHERE si.tenant_id = l.tenant_id AND si.supplier_id = ${order.supplierId} AND si.variant_id = l.variant_id AND si.archived_at IS NULL) AS supplier_sku,
               coalesce(sum(g.quantity), 0)::text AS received, coalesce(sum(g.rejected_quantity), 0)::text AS rejected
          FROM purchase_order_lines l
          JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          LEFT JOIN goods_receipt_lines g ON g.tenant_id = l.tenant_id AND g.purchase_order_line_id = l.id
         WHERE l.purchase_order_id = ${order.id}
         GROUP BY l.id, v.sku, p.name, p.tracks_expiry ORDER BY l.line_no`),
      () => db.execute<{ id: string; receipt_number: number; supplier_invoice_ref: string | null; created_at: string }>(sql`
        SELECT id, receipt_number::int, supplier_invoice_ref, created_at FROM goods_receipts WHERE purchase_order_id = ${order.id} ORDER BY created_at, id`),
    );
    let orderedValue = new Dec(0);
    let receivedValue = new Dec(0);
    const out = lines.map((l) => {
      const ordered = toDec(l.quantity);
      const received = toDec(l.received);
      orderedValue = orderedValue.plus(ordered.times(l.unit_cost));
      receivedValue = receivedValue.plus(received.times(l.unit_cost));
      return {
        id: l.id,
        lineNo: l.line_no,
        variantId: l.variant_id,
        sku: l.sku,
        name: l.name,
        supplierSku: l.supplier_sku,
        // Receiving asks for an expiry date only on these (ADR-0020 §3).
        tracksExpiry: l.tracks_expiry,
        quantity: ordered.toString(),
        unitCost: toDec(l.unit_cost).toFixed(4),
        lineValue: ordered.times(l.unit_cost).toFixed(2),
        receivedQuantity: received.toString(),
        rejectedQuantity: toDec(l.rejected).toString(),
        remainingQuantity: Dec.max(ordered.minus(received), 0).toString(),
      };
    });
    return {
      ...order,
      supplier,
      lines: out,
      orderedValue: orderedValue.toFixed(2),
      receivedValue: receivedValue.toFixed(2),
      receipts: receipts.map((r) => ({ id: r.id, receiptNumber: r.receipt_number, supplierInvoiceRef: r.supplier_invoice_ref, createdAt: new Date(r.created_at).toISOString() })),
    };
  }
}
