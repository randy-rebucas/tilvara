import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  kitchenStations,
  kitchenTickets,
  or,
  orderItems,
  restaurantOrders,
  restaurantTables,
  sql,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { ItemStatusInput, KitchenTicketQuery, PermissionCode } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { assertFeature } from '../billing/entitlements.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';

const RANK = ['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED'];
const STAMP: Record<string, 'prepStartedAt' | 'readyAt' | 'servedAt'> = { IN_PREP: 'prepStartedAt', READY: 'readyAt', SERVED: 'servedAt' };

/**
 * Kitchen display (ADR-0014 §7): open tickets per station, item preparation statuses and bump.
 * Polled by the KDS (push is a later option). Status only moves forward; voids are a floor action.
 */
@Injectable()
export class KitchenService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private assertAny(auth: AuthContext, perms: PermissionCode[], scope: { branchId: string; legalEntityId: string }) {
    if (!perms.some((p) => this.can(auth, p, scope))) this.assertCan(auth, perms[0]!, scope);
  }

  /** Tickets of a branch (optionally one station), oldest first; OPEN = something still to prepare or serve. */
  tickets(auth: AuthContext, q: KitchenTicketQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertAny(auth, ['kitchen.operate', 'restaurant.orders', 'restaurant.manage'], scope);
      if (q.stationId) {
        const [st] = await db.select({ branchId: kitchenStations.branchId }).from(kitchenStations).where(eq(kitchenStations.id, q.stationId));
        if (!st || st.branchId !== q.branchId) throw new AppError('NOT_FOUND', 'Station not found', HttpStatus.NOT_FOUND);
      }
      const open = sql`EXISTS (SELECT 1 FROM order_items i WHERE i.kitchen_ticket_id = ${kitchenTickets.id} AND i.status IN ('FIRED','IN_PREP','READY'))`;
      const tickets = await db
        .select({ ticket: kitchenTickets, stationCode: kitchenStations.code, stationName: kitchenStations.name })
        .from(kitchenTickets)
        .innerJoin(kitchenStations, eq(kitchenStations.id, kitchenTickets.stationId))
        .where(and(eq(kitchenTickets.branchId, q.branchId), q.stationId ? eq(kitchenTickets.stationId, q.stationId) : undefined, q.status === 'OPEN' ? open : undefined))
        .orderBy(q.status === 'OPEN' ? asc(kitchenTickets.firedAt) : desc(kitchenTickets.firedAt))
        .limit(200);
      if (!tickets.length) return { data: [] };
      const items = await db
        .select({ item: orderItems, orderNumber: restaurantOrders.orderNumber, orderType: restaurantOrders.orderType, customerName: restaurantOrders.customerName, tableCode: restaurantTables.code })
        .from(orderItems)
        .innerJoin(restaurantOrders, eq(restaurantOrders.id, orderItems.orderId))
        .leftJoin(restaurantTables, eq(restaurantTables.id, restaurantOrders.tableId))
        .where(inArray(orderItems.kitchenTicketId, tickets.map((t) => t.ticket.id)))
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
      return {
        data: tickets.map((t) => {
          const mine = items.filter((i) => i.item.kitchenTicketId === t.ticket.id);
          const parents = mine.filter((i) => i.item.kind === 'ITEM');
          // Where the food goes now (items may have moved tables since firing).
          const dest = parents[0] ?? mine[0];
          return {
            ...t.ticket,
            station: { id: t.ticket.stationId, code: t.stationCode, name: t.stationName },
            order: dest ? { id: dest.item.orderId, orderNumber: dest.orderNumber, orderType: dest.orderType, tableCode: dest.tableCode, customerName: dest.customerName } : null,
            items: parents.map((p) => ({
              id: p.item.id,
              name: p.item.name,
              quantity: toDec(p.item.quantity).toString(),
              seat: p.item.seat,
              note: p.item.note,
              status: p.item.status,
              firedAt: p.item.firedAt,
              readyAt: p.item.readyAt,
              modifiers: mine.filter((m) => m.item.parentItemId === p.item.id).map((m) => ({ id: m.item.id, name: m.item.name })),
            })),
          };
        }),
      };
    });
  }

  /** Move an item (and its modifiers) forward: IN_PREP / READY by the kitchen, SERVED by kitchen or floor. */
  setItemStatus(auth: AuthContext, itemId: string, input: ItemStatusInput) {
    return this.mutate(auth, async (db) => {
      const [item] = await db.select().from(orderItems).where(eq(orderItems.id, itemId)).for('update');
      if (!item) throw notFound('Order item');
      const [order] = await db.select({ branchId: restaurantOrders.branchId }).from(restaurantOrders).where(eq(restaurantOrders.id, item.orderId));
      const { scope } = await branchScope(db, order!.branchId);
      this.assertAny(auth, input.status === 'SERVED' ? ['kitchen.operate', 'restaurant.orders'] : ['kitchen.operate'], scope);
      await assertFeature(db, 'restaurant');
      if (item.kind !== 'ITEM') throw unprocessable('NOT_AN_ITEM', 'Change the item this choice belongs to');
      if (item.status === input.status) return this.itemView(item);
      if (item.status === 'PENDING' || item.status === 'VOIDED' || RANK.indexOf(input.status) < RANK.indexOf(item.status)) {
        throw new AppError('INVALID_TRANSITION', `An item cannot go from ${item.status.toLowerCase()} to ${input.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: item.status });
      }
      const set = { status: input.status, [STAMP[input.status]!]: sql`now()` };
      await db.update(orderItems).set(set).where(or(eq(orderItems.id, itemId), and(eq(orderItems.parentItemId, itemId), sql`${orderItems.status} <> 'VOIDED'`)));
      await this.audit(db, auth, 'order.item_status', 'order_item', itemId, { from: item.status, to: input.status });
      const [row] = await db.select().from(orderItems).where(eq(orderItems.id, itemId));
      return this.itemView(row!);
    });
  }

  /** The station marks a whole ticket ready: every item still fired or in preparation becomes READY. */
  bump(auth: AuthContext, ticketId: string) {
    return this.mutate(auth, async (db) => {
      const [ticket] = await db.select().from(kitchenTickets).where(eq(kitchenTickets.id, ticketId)).for('update');
      if (!ticket) throw notFound('Kitchen ticket');
      this.assertCan(auth, 'kitchen.operate', (await branchScope(db, ticket.branchId)).scope);
      await assertFeature(db, 'restaurant');
      const moved = await db
        .update(orderItems)
        .set({ status: 'READY', readyAt: sql`now()` })
        .where(and(eq(orderItems.kitchenTicketId, ticketId), inArray(orderItems.status, ['FIRED', 'IN_PREP'])))
        .returning({ id: orderItems.id });
      const [row] = await db.update(kitchenTickets).set({ bumpedAt: sql`now()`, bumpedBy: auth.userId }).where(eq(kitchenTickets.id, ticketId)).returning();
      await this.audit(db, auth, 'kitchen_ticket.bumped', 'kitchen_ticket', ticketId, { ticketNumber: ticket.ticketNumber, items: moved.length });
      return { ...row!, readyItems: moved.length };
    });
  }

  /**
   * Undo a mistaken bump (ADR-0014 amendment): the ticket's ready items go back to preparation and the
   * ticket is no longer bumped. Served items stay served; nothing ready means nothing to undo.
   */
  unbump(auth: AuthContext, ticketId: string) {
    return this.mutate(auth, async (db) => {
      const [ticket] = await db.select().from(kitchenTickets).where(eq(kitchenTickets.id, ticketId)).for('update');
      if (!ticket) throw notFound('Kitchen ticket');
      this.assertCan(auth, 'kitchen.operate', (await branchScope(db, ticket.branchId)).scope);
      await assertFeature(db, 'restaurant');
      const moved = await db
        .update(orderItems)
        .set({ status: 'IN_PREP', readyAt: null })
        .where(and(eq(orderItems.kitchenTicketId, ticketId), eq(orderItems.status, 'READY')))
        .returning({ id: orderItems.id });
      if (moved.length === 0) {
        throw new AppError('NOTHING_TO_UNBUMP', 'Nothing on this ticket is ready and waiting; served food cannot go back', HttpStatus.CONFLICT);
      }
      const [row] = await db.update(kitchenTickets).set({ bumpedAt: null, bumpedBy: null }).where(eq(kitchenTickets.id, ticketId)).returning();
      await this.audit(db, auth, 'kitchen_ticket.unbumped', 'kitchen_ticket', ticketId, { ticketNumber: ticket.ticketNumber, items: moved.length });
      return { ...row!, inPrepItems: moved.length };
    });
  }

  private itemView(i: typeof orderItems.$inferSelect) {
    return { ...i, quantity: toDec(i.quantity).toString() };
  }
}
