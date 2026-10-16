import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  kitchenStations,
  kitchenTickets,
  ne,
  or,
  orderBills,
  orderItems,
  products,
  productVariants,
  restaurantOrders,
  restaurantTables,
  sql,
  unitsOfMeasure,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  AddOrderItemsInput,
  CancelOrderInput,
  FireOrderInput,
  MergeOrderInput,
  MoveOrderItemsInput,
  OpenOrderInput,
  OrderListQuery,
  PermissionCode,
  TransferOrderInput,
  UpdateOrderItemInput,
  VoidOrderItemInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { nextNumber } from '../common/sequence.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { recordPreparedWaste } from './consumption.js';
import { MenusService } from './menus.service.js';

type Order = typeof restaurantOrders.$inferSelect;
type Item = typeof orderItems.$inferSelect;

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(code, message, HttpStatus.CONFLICT, details);
const notOpen = (o: Order) => conflict('ORDER_NOT_OPEN', `This order is ${o.status.toLowerCase()}`, { status: o.status });
const FLOOR_READ: PermissionCode[] = ['restaurant.orders', 'restaurant.manage', 'kitchen.operate'];
const LIVE = ['OPEN', 'BILLED'];

/**
 * Restaurant orders (ADR-0014 §6, §7): operational records of what a table or takeaway customer
 * ordered and where it is in the kitchen. Never financial — settling creates sales (slice 4).
 * Every change locks the order row, so two tablets on one order apply one after the other.
 */
@Injectable()
export class OrdersService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    restaurant_orders_table_live_unique: ['TABLE_OCCUPIED', 'This table already has an open order'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(MenusService) private readonly menus: MenusService,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- open, list, read
  open(auth: AuthContext, input: OpenOrderInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'restaurant.orders', scope);
      await assertFeature(db, 'restaurant');
      if (branch.archivedAt) throw archived('Branch');
      const order = await this.insertOrder(db, auth, branch.id, input);
      await this.audit(db, auth, 'order.opened', 'restaurant_order', order.id, { orderNumber: order.orderNumber, orderType: order.orderType, tableId: order.tableId });
      return this.view(db, order);
    });
  }

  list(auth: AuthContext, q: OrderListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertAny(auth, FLOOR_READ, scope);
      const rows = await db
        .select({ order: restaurantOrders, tableCode: restaurantTables.code })
        .from(restaurantOrders)
        .leftJoin(restaurantTables, eq(restaurantTables.id, restaurantOrders.tableId))
        .where(and(eq(restaurantOrders.branchId, q.branchId), q.status === 'LIVE' ? inArray(restaurantOrders.status, LIVE) : undefined))
        .orderBy(desc(restaurantOrders.openedAt))
        .limit(200);
      const counts = rows.length
        ? await db
            .select({ orderId: orderItems.orderId, status: orderItems.status, n: sql<number>`count(*)::int` })
            .from(orderItems)
            .where(and(inArray(orderItems.orderId, rows.map((r) => r.order.id)), eq(orderItems.kind, 'ITEM')))
            .groupBy(orderItems.orderId, orderItems.status)
        : [];
      return {
        data: rows.map((r) => ({
          ...r.order,
          table: r.order.tableId ? { id: r.order.tableId, code: r.tableCode } : null,
          items: Object.fromEntries(counts.filter((c) => c.orderId === r.order.id).map((c) => [c.status, Number(c.n)])),
        })),
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const order = await this.order(db, id);
      this.assertAny(auth, FLOOR_READ, (await branchScope(db, order.branchId)).scope);
      return this.view(db, order);
    });
  }

  // ---------------------------------------------------------------- items
  /**
   * Add items from the branch's published menu for this order type, with modifier choices checked
   * against each item's groups (min/max, availability). Priced options become modifier items with
   * their own item; free options are kitchen instructions. Everything starts PENDING.
   */
  addItems(auth: AuthContext, orderId: string, input: AddOrderItemsInput) {
    return this.mutate(auth, async (db) => {
      const order = await this.lockedOrder(db, auth, orderId, 'restaurant.orders');
      if (order.status !== 'OPEN') throw notOpen(order);
      const served = await this.menus.served(db, order.branchId, order.orderType as 'DINE_IN' | 'TAKEAWAY');
      if (!served.menu) throw conflict('NO_MENU', 'This branch serves no published menu for this order type');
      const menuItems = served.menu.sections.flatMap((s) => s.items);
      await this.assertWholeUnits(db, input.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })));
      const tenantId = tenantOf(auth).tenantId;
      const added: string[] = [];
      for (const [idx, req] of input.items.entries()) {
        const path = ['items', idx];
        const item = menuItems.find((m) => m.variantId === req.variantId);
        if (!item) throw unprocessable('NOT_ON_MENU', 'This item is not on the menu served here', { path: [...path, 'variantId'] });
        if (!item.available) {
          throw unprocessable(item.soldOut ? 'SOLD_OUT' : 'NOT_AVAILABLE', item.soldOut ? `${item.name} is sold out` : `${item.name} cannot be sold here (no price)`, { path: [...path, 'variantId'] });
        }
        if (new Set(req.modifierOptionIds).size !== req.modifierOptionIds.length) throw unprocessable('DUPLICATE_MODIFIER', 'Each choice once per item', { path: [...path, 'modifierOptionIds'] });
        const chosen = req.modifierOptionIds.map((oid) => {
          for (const g of item.modifierGroups) {
            const o = g.options.find((x) => x.id === oid);
            if (o) return { group: g, option: o };
          }
          throw unprocessable('MODIFIER_NOT_ALLOWED', 'This choice does not belong to this item', { path: [...path, 'modifierOptionIds'], modifierOptionId: oid });
        });
        for (const g of item.modifierGroups) {
          const n = chosen.filter((c) => c.group.id === g.id).length;
          if (n < g.minSelect || n > g.maxSelect) {
            throw unprocessable('MODIFIER_COUNT', g.minSelect === g.maxSelect ? `Choose ${g.minSelect} for ${g.name}` : `Choose ${g.minSelect} to ${g.maxSelect} for ${g.name}`, {
              path: [...path, 'modifierOptionIds'], modifierGroupId: g.id, minSelect: g.minSelect, maxSelect: g.maxSelect,
            });
          }
        }
        const gone = chosen.find((c) => !c.option.available);
        if (gone) throw unprocessable('NOT_AVAILABLE', `${gone.option.name} is not available`, { path: [...path, 'modifierOptionIds'], modifierOptionId: gone.option.id });

        const common = { tenantId, orderId, menuVersionId: served.menu.menuVersionId, quantity: req.quantity, course: req.course, stationCode: item.stationCode, addedBy: auth.userId };
        const [parent] = await db
          .insert(orderItems)
          .values({ ...common, kind: 'ITEM', variantId: item.variantId, name: item.name, seat: req.seat ?? null, note: req.note ?? null })
          .returning({ id: orderItems.id });
        if (chosen.length) {
          await db.insert(orderItems).values(
            chosen.map((c) => ({ ...common, kind: 'MODIFIER', parentItemId: parent!.id, variantId: c.option.variantId, modifierOptionId: c.option.id, name: c.option.name, seat: req.seat ?? null })),
          );
        }
        added.push(parent!.id);
      }
      await this.audit(db, auth, 'order.items_added', 'restaurant_order', orderId, { items: added.length });
      return this.view(db, order);
    });
  }

  /** Edit an item the kitchen has not seen yet; its modifiers follow quantity and course. */
  updateItem(auth: AuthContext, itemId: string, input: UpdateOrderItemInput) {
    return this.mutate(auth, async (db) => {
      const { order, item } = await this.lockedItem(db, auth, itemId, 'restaurant.orders');
      if (order.status !== 'OPEN') throw notOpen(order);
      if (item.status !== 'PENDING') throw conflict('ITEM_FIRED', 'This item was already sent to the kitchen; void it instead');
      if (input.quantity) await this.assertWholeUnits(db, [{ variantId: item.variantId!, quantity: input.quantity }]);
      await db.update(orderItems).set(input).where(eq(orderItems.id, itemId));
      const follow = { ...(input.quantity && { quantity: input.quantity }), ...(input.course && { course: input.course }), ...(input.seat !== undefined && { seat: input.seat }) };
      if (Object.keys(follow).length) await db.update(orderItems).set(follow).where(eq(orderItems.parentItemId, itemId));
      await this.audit(db, auth, 'order.item_updated', 'restaurant_order', order.id, { itemId, ...input });
      return this.view(db, order);
    });
  }

  /** Remove an item the kitchen has not seen yet (with its modifiers). */
  removeItem(auth: AuthContext, itemId: string) {
    return this.mutate(auth, async (db) => {
      const { order, item } = await this.lockedItem(db, auth, itemId, 'restaurant.orders');
      if (order.status !== 'OPEN') throw notOpen(order);
      if (item.status !== 'PENDING') throw conflict('ITEM_FIRED', 'This item was already sent to the kitchen; void it instead');
      await db.delete(orderItems).where(eq(orderItems.parentItemId, itemId));
      await db.delete(orderItems).where(eq(orderItems.id, itemId));
      await this.audit(db, auth, 'order.item_removed', 'restaurant_order', order.id, { itemId, name: item.name, quantity: item.quantity });
      return this.view(db, order);
    });
  }

  /**
   * Void an item the kitchen has seen (needs `sales.void`). When preparation had started and the
   * food is thrown away (`wasted`), its stock — the item itself if tracked, else its recipe — is
   * written off in a WASTE stock adjustment with its journal entry, in this transaction.
   */
  voidItem(auth: AuthContext, itemId: string, input: VoidOrderItemInput) {
    return this.mutate(auth, async (db) => {
      const { order, item, branch } = await this.lockedItem(db, auth, itemId, 'sales.void');
      if (order.status !== 'OPEN') throw notOpen(order);
      if (item.status === 'PENDING') throw conflict('ITEM_NOT_FIRED', 'This item was not sent to the kitchen; remove it instead');
      if (item.status === 'VOIDED') throw conflict('ALREADY_VOIDED', 'This item is already voided');
      const children = await db.select().from(orderItems).where(eq(orderItems.parentItemId, itemId));
      let wasteAdjustmentId: string | null = null;
      if (input.wasted) {
        const lines = [item, ...children].flatMap((x) => (x.variantId ? [{ variantId: x.variantId, quantity: x.quantity }] : []));
        const tracked = await db
          .select({ id: productVariants.id, track: products.trackInventory })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(productVariants.id, lines.map((l) => l.variantId)));
        wasteAdjustmentId = await recordPreparedWaste(db, {
          tenantId: order.tenantId,
          branchId: order.branchId,
          legalEntityId: branch.legalEntityId,
          reason: `Voided after firing (order #${order.orderNumber}): ${input.reason}`,
          userId: auth.userId,
          items: lines.map((l) => ({ ...l, tracked: tracked.find((t) => t.id === l.variantId)!.track })),
        });
      }
      const voided = { status: 'VOIDED', voidedAt: sql`now()`, voidedBy: auth.userId, voidReason: input.reason };
      await db.update(orderItems).set({ ...voided, wasteAdjustmentId }).where(eq(orderItems.id, itemId));
      await db.update(orderItems).set(voided).where(and(eq(orderItems.parentItemId, itemId), ne(orderItems.status, 'VOIDED')));
      await this.audit(db, auth, 'order.item_voided', 'restaurant_order', order.id, { itemId, name: item.name, quantity: item.quantity, fromStatus: item.status, reason: input.reason, wasteAdjustmentId });
      return this.view(db, order);
    });
  }

  // ---------------------------------------------------------------- kitchen
  /**
   * Send pending items (of the given courses, else all) to the kitchen: one ticket per station and
   * course. Items route by station code to the branch's station with that code, else its default
   * station. Firing with nothing pending changes nothing, so a retried fire is harmless.
   */
  fire(auth: AuthContext, orderId: string, input: FireOrderInput) {
    return this.mutate(auth, async (db) => {
      const order = await this.lockedOrder(db, auth, orderId, 'restaurant.orders');
      if (!LIVE.includes(order.status)) throw notOpen(order);
      const pending = await db
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), eq(orderItems.kind, 'ITEM'), eq(orderItems.status, 'PENDING'), input.courses ? inArray(orderItems.course, input.courses) : undefined))
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
      if (!pending.length) return { ...(await this.view(db, order)), fired: [] };
      const stations = await db.select().from(kitchenStations).where(and(eq(kitchenStations.branchId, order.branchId), isNull(kitchenStations.archivedAt)));
      const fallback = stations.find((s) => s.isDefault);
      const groups = new Map<string, { stationId: string; course: number; items: Item[] }>();
      for (const it of pending) {
        const station = stations.find((s) => s.code === it.stationCode) ?? fallback;
        if (!station) throw unprocessable('NO_KITCHEN_STATION', `No kitchen station for ${it.stationCode ?? 'this item'} and no default station at this branch`, { stationCode: it.stationCode });
        const key = `${station.id}:${it.course}`;
        const g = groups.get(key) ?? { stationId: station.id, course: it.course, items: [] };
        g.items.push(it);
        groups.set(key, g);
      }
      const fired: { ticketId: string; ticketNumber: number; stationId: string; course: number; items: number }[] = [];
      for (const g of [...groups.values()].sort((a, b) => a.course - b.course)) {
        const ticketNumber = await nextNumber(db, order.tenantId, order.branchId, 'KITCHEN_TICKET');
        const [ticket] = await db
          .insert(kitchenTickets)
          .values({ tenantId: order.tenantId, branchId: order.branchId, orderId, stationId: g.stationId, ticketNumber, course: g.course, firedBy: auth.userId })
          .returning();
        const ids = g.items.map((i) => i.id);
        await db
          .update(orderItems)
          .set({ status: 'FIRED', firedAt: sql`now()`, kitchenTicketId: ticket!.id })
          .where(and(or(inArray(orderItems.id, ids), inArray(orderItems.parentItemId, ids)), eq(orderItems.status, 'PENDING')));
        fired.push({ ticketId: ticket!.id, ticketNumber, stationId: g.stationId, course: g.course, items: ids.length });
      }
      await this.audit(db, auth, 'order.fired', 'restaurant_order', orderId, { tickets: fired.map((f) => f.ticketNumber), courses: input.courses ?? null });
      return { ...(await this.view(db, order)), fired };
    });
  }

  // ---------------------------------------------------------------- tables: transfer, merge, move
  transfer(auth: AuthContext, orderId: string, input: TransferOrderInput) {
    return this.mutate(auth, async (db) => {
      const order = await this.lockedOrder(db, auth, orderId, 'restaurant.orders');
      if (!LIVE.includes(order.status)) throw notOpen(order);
      if (order.orderType !== 'DINE_IN') throw unprocessable('NOT_DINE_IN', 'Only dine-in orders sit at a table');
      if (order.tableId === input.tableId) return this.view(db, order);
      await this.freeTable(db, order.branchId, input.tableId);
      const [row] = await db.update(restaurantOrders).set({ tableId: input.tableId }).where(eq(restaurantOrders.id, orderId)).returning();
      await this.audit(db, auth, 'order.table_transferred', 'restaurant_order', orderId, { fromTableId: order.tableId, toTableId: input.tableId });
      return this.view(db, row!);
    });
  }

  /** Merge this order into another open order of the branch: every item moves; this one closes as MERGED. */
  merge(auth: AuthContext, orderId: string, input: MergeOrderInput) {
    return this.mutate(auth, async (db) => {
      if (orderId === input.intoOrderId) throw unprocessable('SAME_ORDER', 'An order cannot be merged into itself');
      const [source, target] = await this.lockPair(db, auth, orderId, input.intoOrderId);
      for (const o of [source, target]) if (o.status !== 'OPEN') throw notOpen(o);
      await db.update(orderItems).set({ orderId: target.id }).where(eq(orderItems.orderId, source.id));
      await db.update(restaurantOrders)
        .set({ status: 'MERGED', mergedIntoId: target.id, closedBy: auth.userId, closedAt: sql`now()` })
        .where(eq(restaurantOrders.id, source.id));
      await this.audit(db, auth, 'order.merged', 'restaurant_order', target.id, { mergedOrderId: source.id, mergedOrderNumber: source.orderNumber });
      return this.view(db, target);
    });
  }

  /** Move items (with their modifiers) to another open order, or to a new order on a free table. */
  moveItems(auth: AuthContext, orderId: string, input: MoveOrderItemsInput) {
    return this.mutate(auth, async (db) => {
      if (input.toOrderId === orderId) throw unprocessable('SAME_ORDER', 'Items are already on this order');
      let [source, target]: [Order, Order | null] = input.toOrderId
        ? await this.lockPair(db, auth, orderId, input.toOrderId)
        : [await this.lockedOrder(db, auth, orderId, 'restaurant.orders'), null];
      if (source.status !== 'OPEN') throw notOpen(source);
      if (target && target.status !== 'OPEN') throw notOpen(target);
      const items = await db.select().from(orderItems).where(and(eq(orderItems.orderId, source.id), inArray(orderItems.id, input.itemIds)));
      const missing = input.itemIds.filter((id) => !items.some((i) => i.id === id));
      if (missing.length) throw new AppError('NOT_FOUND', 'Item not found on this order', HttpStatus.NOT_FOUND, { itemIds: missing });
      if (items.some((i) => i.kind !== 'ITEM')) throw unprocessable('MOVE_WHOLE_ITEMS', 'Move an item with its choices, not a choice alone');
      if (items.some((i) => i.status === 'VOIDED')) throw unprocessable('ITEM_VOIDED', 'Voided items stay where they were voided');
      // A new order on a free table only once the move itself is valid.
      target ??= await this.insertOrder(db, auth, source.branchId, { orderType: 'DINE_IN', tableId: input.toTableId! });
      await db.update(orderItems).set({ orderId: target.id })
        .where(or(inArray(orderItems.id, input.itemIds), inArray(orderItems.parentItemId, input.itemIds)));
      await this.audit(db, auth, 'order.items_moved', 'restaurant_order', source.id, { toOrderId: target.id, itemIds: input.itemIds });
      return { from: await this.view(db, source), to: await this.view(db, target) };
    });
  }

  /** Cancel an order nothing was cooked for: pending items disappear; fired items must be voided first. */
  cancel(auth: AuthContext, orderId: string, input: CancelOrderInput) {
    return this.mutate(auth, async (db) => {
      const order = await this.lockedOrder(db, auth, orderId, 'restaurant.orders');
      if (order.status !== 'OPEN') throw notOpen(order);
      const [live] = await db.select({ id: orderItems.id }).from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), eq(orderItems.kind, 'ITEM'), sql`${orderItems.status} NOT IN ('PENDING','VOIDED')`)).limit(1);
      if (live) throw conflict('ORDER_HAS_FIRED_ITEMS', 'Items of this order were sent to the kitchen; void them first');
      await db.delete(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.kind, 'MODIFIER'), eq(orderItems.status, 'PENDING')));
      await db.delete(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'PENDING')));
      const [row] = await db.update(restaurantOrders)
        .set({ status: 'CANCELLED', closeReason: input.reason, closedBy: auth.userId, closedAt: sql`now()` })
        .where(eq(restaurantOrders.id, orderId))
        .returning();
      await this.audit(db, auth, 'order.cancelled', 'restaurant_order', orderId, { reason: input.reason });
      return this.view(db, row!);
    });
  }

  // ---------------------------------------------------------------- helpers
  private assertAny(auth: AuthContext, perms: PermissionCode[], scope: { branchId: string; legalEntityId: string }) {
    if (!perms.some((p) => this.can(auth, p, scope))) this.assertCan(auth, perms[0]!, scope);
  }

  private async insertOrder(db: Database, auth: AuthContext, branchId: string, input: Pick<OpenOrderInput, 'orderType' | 'tableId' | 'guestCount' | 'customerName' | 'note'>) {
    if (input.tableId) await this.freeTable(db, branchId, input.tableId);
    const tenantId = tenantOf(auth).tenantId;
    const orderNumber = await nextNumber(db, tenantId, branchId, 'RESTAURANT_ORDER');
    const [order] = await db
      .insert(restaurantOrders)
      .values({
        tenantId, branchId, orderNumber, orderType: input.orderType, tableId: input.tableId ?? null, guestCount: input.guestCount ?? null,
        customerName: input.customerName ?? null, note: input.note ?? null, openedBy: auth.userId,
      })
      .returning();
    return order!;
  }

  /** The table exists at this branch, is active and has no live order (the unique index backs the race). */
  private async freeTable(db: Database, branchId: string, tableId: string) {
    const [table] = await db.select().from(restaurantTables).where(eq(restaurantTables.id, tableId));
    if (!table || table.branchId !== branchId) throw new AppError('NOT_FOUND', 'Table not found', HttpStatus.NOT_FOUND, { tableId });
    if (table.archivedAt) throw archived('Table');
    const [busy] = await db.select({ id: restaurantOrders.id, orderNumber: restaurantOrders.orderNumber }).from(restaurantOrders)
      .where(and(eq(restaurantOrders.tableId, tableId), inArray(restaurantOrders.status, LIVE)));
    if (busy) throw conflict('TABLE_OCCUPIED', `Table ${table.code} already has an open order`, { orderId: busy.id, orderNumber: busy.orderNumber });
  }

  /** Every item must be in whole units unless its unit allows fractions (as checkout requires). */
  private async assertWholeUnits(db: Database, lines: { variantId: string; quantity: string }[]) {
    const fractional = lines.filter((l) => !toDec(l.quantity).isInteger());
    if (!fractional.length) return;
    const rows = await db
      .select({ id: productVariants.id, allowsFraction: unitsOfMeasure.allowsFraction })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.uomId))
      .where(inArray(productVariants.id, fractional.map((l) => l.variantId)));
    const bad = fractional.find((l) => rows.some((r) => r.id === l.variantId && !r.allowsFraction));
    if (bad) throw unprocessable('FRACTIONAL_QUANTITY', 'This item is sold in whole units', { variantId: bad.variantId });
  }

  private async order(db: Database, id: string) {
    const [row] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, id));
    if (!row) throw notFound('Order');
    return row;
  }

  /** Lock the order row, then authorize at its branch and require the restaurant plan. */
  private async lockedOrder(db: Database, auth: AuthContext, id: string, perm: PermissionCode) {
    const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, id)).for('update');
    if (!order) throw notFound('Order');
    this.assertCan(auth, perm, (await branchScope(db, order.branchId)).scope);
    await assertFeature(db, 'restaurant');
    return order;
  }

  /** Two orders of one branch, locked in id order so concurrent merges/moves cannot deadlock. */
  private async lockPair(db: Database, auth: AuthContext, firstId: string, secondId: string): Promise<[Order, Order]> {
    const [lo, hi] = firstId < secondId ? [firstId, secondId] : [secondId, firstId];
    const a = await this.lockedOrder(db, auth, lo, 'restaurant.orders');
    const b = await this.lockedOrder(db, auth, hi, 'restaurant.orders');
    const [first, second] = a.id === firstId ? [a, b] : [b, a];
    if (first.branchId !== second.branchId) throw notFound('Order');
    return [first, second];
  }

  private async lockedItem(db: Database, auth: AuthContext, itemId: string, perm: PermissionCode) {
    const [peek] = await db.select({ orderId: orderItems.orderId }).from(orderItems).where(eq(orderItems.id, itemId));
    if (!peek) throw notFound('Order item');
    const order = await this.lockedOrder(db, auth, peek.orderId, perm);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, itemId));
    // Moved to another order between the peek and the lock: ask the client to retry.
    if (!item || item.orderId !== order.id) throw conflict('ORDER_CHANGED', 'This item just moved to another order; reload and try again');
    if (item.kind !== 'ITEM') throw unprocessable('NOT_AN_ITEM', 'Change the item this choice belongs to');
    const { branch } = await branchScope(db, order.branchId);
    return { order, item, branch };
  }

  async view(db: Database, o: Order) {
    const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, o.id));
    const [table] = order!.tableId ? await db.select({ id: restaurantTables.id, code: restaurantTables.code }).from(restaurantTables).where(eq(restaurantTables.id, order!.tableId)) : [];
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(asc(orderItems.createdAt), asc(orderItems.id));
    const ticketIds = [...new Set(items.flatMap((i) => (i.kitchenTicketId ? [i.kitchenTicketId] : [])))];
    const tickets = ticketIds.length ? await db.select().from(kitchenTickets).where(inArray(kitchenTickets.id, ticketIds)).orderBy(asc(kitchenTickets.ticketNumber)) : [];
    const item = (i: Item) => ({ ...i, quantity: toDec(i.quantity).toString() });
    const bills = await db
      .select({ id: orderBills.id, billNumber: orderBills.billNumber, status: orderBills.status, amountDue: orderBills.amountDue })
      .from(orderBills).where(eq(orderBills.orderId, o.id)).orderBy(asc(orderBills.billNumber));
    const current = bills.filter((b) => b.status !== 'VOIDED').at(-1);
    return {
      ...order!,
      table: table ?? null,
      bill: current ? { ...current, amountDue: toDec(current.amountDue).toFixed(2) } : null,
      items: items.filter((i) => i.kind === 'ITEM').map((i) => ({ ...item(i), modifiers: items.filter((m) => m.parentItemId === i.id).map(item) })),
      tickets,
    };
  }
}
