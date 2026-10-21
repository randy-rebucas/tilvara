import {
  and,
  eq,
  inArray,
  isNull,
  kitchenStations,
  kitchenTickets,
  or,
  orderItems,
  restaurantOrders,
  sql,
  type Database,
} from '@1pos/database';
import { nextNumber } from '../common/sequence.js';
import { unprocessable } from '../tax/tax.service.js';
import { assertItemAvailable, chooseModifiers, type MenuItemChoices } from './choices.js';
import { requestVoidSlips } from './kitchen-print.js';

type Item = typeof orderItems.$inferSelect;

/** A line of a counter sale as the client sends it: a catalog line, plus choices for a menu item. */
export interface CounterLineInput {
  id?: string | undefined;
  variantId: string;
  quantity: string;
  choices?: string[] | undefined;
  kitchenNote?: string | undefined;
}

/** One menu item of a counter sale, as the kitchen gets it. Indexes point into the expanded lines. */
export interface CounterKitchenItem {
  lineIndex: number;
  variantId: string;
  name: string;
  quantity: string;
  stationCode: string | null;
  note: string | null;
  choices: { optionId: string; name: string; variantId: string | null; lineIndex: number | null }[];
}

export interface CounterPlan {
  menuVersionId: string;
  pickupName: string | null;
  items: CounterKitchenItem[];
  /** Rung up offline: tickets were printed by the till itself and the food has long been handed over. */
  offline: boolean;
  /** Offline: the call number the till printed (its device number), kept on the order. */
  tillCallNumber?: number;
}

/**
 * Counter service (ADR-0014 amendment, session 25): the lines of a sale with each menu item's priced
 * choices put right after it as their own lines (variant = the option's, quantity = the item's, the
 * item's SC/PWD share), and what the kitchen gets. Free choices have no line. The till expands its cart
 * the same way to show the total, so the server reproduces it. Without counter service (`menu` null),
 * a line with choices or a kitchen note is refused.
 */
export function expandCounterLines<L extends CounterLineInput & { statutory?: unknown }>(
  lines: L[],
  menu: { menuVersionId: string; items: MenuItemChoices[]; pickupName: string | null; offline: boolean } | null,
): { lines: Omit<L, 'choices' | 'kitchenNote'>[]; parentIndex: (number | null)[]; plan: CounterPlan | null } {
  const out: Omit<L, 'choices' | 'kitchenNote'>[] = [];
  const parentIndex: (number | null)[] = [];
  const kitchen: CounterKitchenItem[] = [];
  for (const [i, line] of lines.entries()) {
    const { choices, kitchenNote, ...rest } = line;
    const path = ['lines', i];
    const item = menu?.items.find((m) => m.variantId === line.variantId);
    if (!menu && (choices?.length || kitchenNote)) {
      throw unprocessable('COUNTER_SERVICE_OFF', 'Choices and kitchen notes need counter service at this branch', { path });
    }
    if (!item && (choices?.length || kitchenNote)) throw unprocessable('NOT_ON_MENU', 'This item is not on the menu served here', { path: [...path, 'variantId'] });
    const parentAt = out.length;
    out.push(rest);
    parentIndex.push(null);
    if (!item || !menu) continue;
    if (!menu.offline) assertItemAvailable(item, [...path, 'variantId']);
    const chosen = chooseModifiers(item, choices ?? [], [...path, 'choices'], menu.offline);
    const k: CounterKitchenItem = { lineIndex: parentAt, variantId: item.variantId, name: item.name, quantity: line.quantity, stationCode: item.stationCode, note: kitchenNote ?? null, choices: [] };
    for (const [n, c] of chosen.entries()) {
      let lineIndex: number | null = null;
      if (c.option.variantId) {
        lineIndex = out.length;
        const child = { id: `${line.id ?? String(i + 1)}.c${n + 1}`, variantId: c.option.variantId, quantity: line.quantity, ...(line.statutory !== undefined && { statutory: line.statutory }) };
        out.push(child as unknown as Omit<L, 'choices' | 'kitchenNote'>);
        parentIndex.push(parentAt);
      }
      k.choices.push({ optionId: c.option.id, name: c.option.name, variantId: c.option.variantId, lineIndex });
    }
    kitchen.push(k);
  }
  const plan = menu && kitchen.length ? { menuVersionId: menu.menuVersionId, pickupName: menu.pickupName, items: kitchen, offline: menu.offline } : null;
  return { lines: out, parentIndex, plan };
}

/**
 * Send items to the kitchen: one ticket per station and course (ADR-0014 §7). An item goes to the
 * branch's station with its code, else the default station; with neither, the fire is refused, or (an
 * offline counter sale, whose ticket the till printed itself) its items go without a ticket. Modifiers
 * follow their item. `printed`: the tickets were already printed by the till (offline).
 */
export async function fireItems(
  db: Database,
  order: { id: string; tenantId: string; branchId: string },
  pending: Item[],
  userId: string,
  opts: { courseNotes?: { course: number; note: string }[]; printed?: boolean; withoutStation?: boolean } = {},
) {
  const stations = await db.select().from(kitchenStations).where(and(eq(kitchenStations.branchId, order.branchId), isNull(kitchenStations.archivedAt)));
  const fallback = stations.find((s) => s.isDefault);
  const groups = new Map<string, { stationId: string | null; course: number; items: Item[] }>();
  for (const it of pending) {
    const station = stations.find((s) => s.code === it.stationCode) ?? fallback;
    if (!station && !opts.withoutStation) {
      throw unprocessable('NO_KITCHEN_STATION', `No kitchen station for ${it.stationCode ?? 'this item'} and no default station at this branch`, { stationCode: it.stationCode });
    }
    const key = `${station?.id ?? '-'}:${it.course}`;
    const g = groups.get(key) ?? { stationId: station?.id ?? null, course: it.course, items: [] };
    g.items.push(it);
    groups.set(key, g);
  }
  const fired: { ticketId: string | null; ticketNumber: number | null; stationId: string | null; course: number; items: number }[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.course - b.course)) {
    let ticket: typeof kitchenTickets.$inferSelect | null = null;
    if (g.stationId) {
      const ticketNumber = await nextNumber(db, order.tenantId, order.branchId, 'KITCHEN_TICKET');
      const courseNote = opts.courseNotes?.find((n) => n.course === g.course)?.note ?? null;
      [ticket] = await db
        .insert(kitchenTickets)
        .values({
          tenantId: order.tenantId, branchId: order.branchId, orderId: order.id, stationId: g.stationId, ticketNumber, course: g.course, firedBy: userId, courseNote,
          ...(opts.printed && { printedAt: sql`now()`, printCount: 1 }),
        })
        .returning() as [typeof kitchenTickets.$inferSelect];
    }
    const ids = g.items.map((i) => i.id);
    await db
      .update(orderItems)
      .set({ status: 'FIRED', firedAt: sql`now()`, kitchenTicketId: ticket?.id ?? null })
      .where(and(or(inArray(orderItems.id, ids), inArray(orderItems.parentItemId, ids)), eq(orderItems.status, 'PENDING')));
    fired.push({ ticketId: ticket?.id ?? null, ticketNumber: ticket?.ticketNumber ?? null, stationId: g.stationId, course: g.course, items: ids.length });
  }
  return fired;
}

/**
 * A counter sale was voided: what the kitchen has not handed over yet (fired, in preparation, ready)
 * is voided with the given reason, so it leaves the kitchen display. No waste document: the food's
 * cost stays with the voided sale (recipe-made lines are never restocked). Returns how many items.
 */
export async function recallCounterOrder(db: Database, saleId: string, userId: string, reason: string) {
  const [order] = await db.select({ id: restaurantOrders.id }).from(restaurantOrders).where(eq(restaurantOrders.saleId, saleId));
  if (!order) return 0;
  const voided = await db
    .update(orderItems)
    .set({ status: 'VOIDED', voidedAt: sql`now()`, voidedBy: userId, voidReason: reason })
    .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.status, ['FIRED', 'IN_PREP', 'READY'])))
    .returning({ id: orderItems.id, kind: orderItems.kind });
  // A ticket the kitchen already has on paper gets a VOID slip.
  await requestVoidSlips(db, voided.map((v) => v.id));
  return voided.filter((v) => v.kind === 'ITEM').length;
}

/**
 * The kitchen's copy of a counter sale, in the sale's transaction: a COUNTER order (per-branch
 * number = the call number on the receipt) with the sale's menu items and their choices, fired at
 * once and SETTLED. An offline sale's tickets are marked printed (the till printed them) and its items
 * served (handed over long ago), so the kitchen display never shows them as new.
 */
export async function recordCounterOrder(
  db: Database,
  ctx: { tenantId: string; branchId: string; saleId: string; userId: string },
  plan: CounterPlan,
) {
  const orderNumber = await nextNumber(db, ctx.tenantId, ctx.branchId, 'RESTAURANT_ORDER');
  const [order] = await db
    .insert(restaurantOrders)
    .values({
      tenantId: ctx.tenantId, branchId: ctx.branchId, orderNumber, orderType: 'COUNTER', saleId: ctx.saleId, customerName: plan.pickupName, openedBy: ctx.userId,
      tillCallNumber: plan.tillCallNumber ?? null,
    })
    .returning();
  const common = { tenantId: ctx.tenantId, orderId: order!.id, menuVersionId: plan.menuVersionId, course: 1, addedBy: ctx.userId };
  const parents: Item[] = [];
  for (const k of plan.items) {
    const [parent] = await db
      .insert(orderItems)
      .values({ ...common, kind: 'ITEM', variantId: k.variantId, name: k.name, quantity: k.quantity, stationCode: k.stationCode, note: k.note })
      .returning();
    parents.push(parent!);
    if (k.choices.length) {
      await db.insert(orderItems).values(
        k.choices.map((c) => ({ ...common, kind: 'MODIFIER', parentItemId: parent!.id, variantId: c.variantId, modifierOptionId: c.optionId, name: c.name, quantity: k.quantity, stationCode: k.stationCode })),
      );
    }
  }
  const fired = await fireItems(db, order!, parents, ctx.userId, { printed: plan.offline, withoutStation: plan.offline });
  if (plan.offline) {
    await db.update(orderItems).set({ status: 'SERVED', servedAt: sql`now()` }).where(and(eq(orderItems.orderId, order!.id), eq(orderItems.status, 'FIRED')));
  }
  await db.update(restaurantOrders).set({ status: 'SETTLED', closedBy: ctx.userId, closedAt: sql`now()` }).where(eq(restaurantOrders.id, order!.id));
  return { id: order!.id, orderNumber, tickets: fired.flatMap((f) => (f.ticketId ? [{ id: f.ticketId, ticketNumber: f.ticketNumber!, stationId: f.stationId! }] : [])) };
}
