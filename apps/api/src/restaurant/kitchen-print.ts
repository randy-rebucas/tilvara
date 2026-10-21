import { sql, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { KitchenTicketPrint } from '@1pos/sync-protocol';

/** How long a till's claim on a ticket holds before another till may print it (it crashed mid-print). */
export const PRINT_CLAIM_SECONDS = 60;
/** Tickets older than this are never printed automatically (a till set up hours later prints nothing stale); reprints always are. */
export const PRINT_MAX_AGE_HOURS = 12;

/**
 * Claim the next unprinted tickets of these stations at a branch for one till (kitchen printing,
 * session 25): fired in the last PRINT_MAX_AGE_HOURS, not printed, and unclaimed or with a claim older
 * than PRINT_CLAIM_SECONDS. `FOR UPDATE SKIP LOCKED`, so two tills printing the same station never
 * take the same ticket. Returns what each ticket prints, oldest first.
 */
export async function claimTicketsToPrint(db: Database, terminalId: string, branchId: string, stationIds: string[], limit = 10): Promise<KitchenTicketPrint[]> {
  if (!stationIds.length) return [];
  const stations = sql.join(stationIds.map((s) => sql`${s}::uuid`), sql`, `);
  // A ticket whose items were all voided before it printed has nothing to print: settle it as printed
  // (without counting a print), so it neither prints an empty slip nor stays pending for ever. A reprint
  // of a ticket already on paper whose items were all voided since: its VOID slip still prints (dated
  // from its last VOID slip, or its firing).
  await db.execute(sql`
    UPDATE kitchen_tickets t SET printed_at = CASE WHEN t.print_count > 0 AND t.void_print_requested_at IS NOT NULL THEN coalesce(t.void_printed_at, t.fired_at) ELSE now() END,
           print_claimed_at = NULL, print_claimed_by = NULL
     WHERE t.id IN (
       SELECT k.id FROM kitchen_tickets k
        WHERE k.branch_id = ${branchId}
          AND k.station_id IN (${stations})
          AND k.printed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.kitchen_ticket_id = k.id AND i.status <> 'VOIDED')
          AND (k.print_claimed_at IS NULL OR k.print_claimed_at < now() - make_interval(secs => ${PRINT_CLAIM_SECONDS}))
        FOR UPDATE SKIP LOCKED)`);
  const { rows: claimed } = await db.execute<{ id: string }>(sql`
    UPDATE kitchen_tickets t SET print_claimed_at = now(), print_claimed_by = ${terminalId}
     WHERE t.id IN (
       SELECT k.id FROM kitchen_tickets k
        WHERE k.branch_id = ${branchId}
          AND k.station_id IN (${stations})
          AND k.printed_at IS NULL
          AND EXISTS (SELECT 1 FROM order_items i WHERE i.kitchen_ticket_id = k.id AND i.status <> 'VOIDED')
          AND (k.fired_at > now() - make_interval(hours => ${PRINT_MAX_AGE_HOURS}) OR k.print_count > 0)
          AND (k.print_claimed_at IS NULL OR k.print_claimed_at < now() - make_interval(secs => ${PRINT_CLAIM_SECONDS}))
        ORDER BY k.fired_at, k.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING t.id`);
  const tickets = await ticketsForPrint(db, claimed.map((c) => c.id));
  const room = limit - tickets.length;
  return room > 0 ? [...tickets, ...(await claimVoidSlips(db, terminalId, branchId, stations, room))] : tickets;
}

/**
 * VOID slips (audit 2026-10-21): a printed ticket with items voided since it printed (and since its
 * last VOID slip). A VOID asked for after a reprint already left the items off settles without a slip;
 * one older than PRINT_MAX_AGE_HOURS is never printed. Claimed like a ticket; `settleKitchenPrint`
 * settles `void_printed_at` to the claim time, so an item voided while the slip printed gets its own.
 */
const VOID_PENDING = sql`k.printed_at IS NOT NULL AND k.void_print_requested_at > greatest(k.printed_at, coalesce(k.void_printed_at, '-infinity'::timestamptz))`;
const VOIDED_SINCE = sql`i.status = 'VOIDED' AND i.voided_at > greatest(k.printed_at, coalesce(k.void_printed_at, '-infinity'::timestamptz))`;

async function claimVoidSlips(db: Database, terminalId: string, branchId: string, stations: ReturnType<typeof sql.join>, limit: number): Promise<KitchenTicketPrint[]> {
  await db.execute(sql`
    UPDATE kitchen_tickets t SET void_printed_at = t.void_print_requested_at
     WHERE t.id IN (
       SELECT k.id FROM kitchen_tickets k
        WHERE k.branch_id = ${branchId}
          AND k.station_id IN (${stations})
          AND ${VOID_PENDING}
          AND (NOT EXISTS (SELECT 1 FROM order_items i WHERE i.kitchen_ticket_id = k.id AND ${VOIDED_SINCE})
               OR k.void_print_requested_at <= now() - make_interval(hours => ${PRINT_MAX_AGE_HOURS}))
          AND (k.print_claimed_at IS NULL OR k.print_claimed_at < now() - make_interval(secs => ${PRINT_CLAIM_SECONDS}))
        FOR UPDATE SKIP LOCKED)`);
  const { rows: claimed } = await db.execute<{ id: string }>(sql`
    UPDATE kitchen_tickets t SET print_claimed_at = now(), print_claimed_by = ${terminalId}
     WHERE t.id IN (
       SELECT k.id FROM kitchen_tickets k
        WHERE k.branch_id = ${branchId}
          AND k.station_id IN (${stations})
          AND ${VOID_PENDING}
          AND EXISTS (SELECT 1 FROM order_items i WHERE i.kitchen_ticket_id = k.id AND ${VOIDED_SINCE})
          AND (k.print_claimed_at IS NULL OR k.print_claimed_at < now() - make_interval(secs => ${PRINT_CLAIM_SECONDS}))
        ORDER BY k.void_print_requested_at, k.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING t.id`);
  return ticketsForPrint(db, claimed.map((c) => c.id), 'VOID');
}

/**
 * Ask for VOID slips: the printed tickets of these just-voided items (an item voided before its ticket
 * printed simply drops off the ticket). In the void's transaction; the till prints it later.
 */
export async function requestVoidSlips(db: Database, itemIds: string[]) {
  if (!itemIds.length) return;
  const ids = sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `);
  await db.execute(sql`
    UPDATE kitchen_tickets k SET void_print_requested_at = now()
     WHERE k.printed_at IS NOT NULL
       AND k.id IN (SELECT i.kitchen_ticket_id FROM order_items i WHERE i.id IN (${ids}) AND i.kitchen_ticket_id IS NOT NULL)`);
}

/** What a ticket prints: its station, where the food goes now, and the live items with their choices. */
export async function ticketsForPrint(db: Database, ids: string[], kind: 'TICKET' | 'VOID' = 'TICKET'): Promise<KitchenTicketPrint[]> {
  if (!ids.length) return [];
  const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const { rows: tickets } = await db.execute<{
    id: string; ticket_number: string; print_count: number; course: number; course_note: string | null; fired_at: string;
    station_id: string; station_code: string; station_name: string; order_number: string; order_type: string; table_code: string | null; customer_name: string | null;
  }>(sql`
    SELECT k.id, k.ticket_number::text, k.print_count, k.course, k.course_note, k.fired_at,
           s.id AS station_id, s.code AS station_code, s.name AS station_name,
           coalesce(o.till_call_number, o.order_number)::text AS order_number, o.order_type, rt.code AS table_code, o.customer_name
      FROM kitchen_tickets k
      JOIN kitchen_stations s ON s.id = k.station_id
      -- Where the food goes now: the order of the ticket's live items (they may have moved tables or been
      -- merged since firing), as the kitchen screen shows it; the ticket's own order when none is left.
      LEFT JOIN LATERAL (
        SELECT i.order_id FROM order_items i
         WHERE i.kitchen_ticket_id = k.id AND i.status <> 'VOIDED'
         ORDER BY (i.kind = 'ITEM') DESC, i.created_at, i.id
         LIMIT 1) dest ON true
      JOIN restaurant_orders o ON o.id = coalesce(dest.order_id, k.order_id)
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
     WHERE k.id IN (${idList})
     ORDER BY k.fired_at, k.id`);
  // A VOID slip: the items voided since the ticket (or its last VOID slip) printed, with the item a
  // choice voided on its own belongs to.
  const { rows: items } = await db.execute<{ id: string; ticket_id: string; parent_item_id: string | null; parent_name: string | null; kind: string; name: string; quantity: string; seat: number | null; note: string | null }>(kind === 'VOID'
    ? sql`
    SELECT i.id, i.kitchen_ticket_id AS ticket_id, i.parent_item_id, p.name AS parent_name, i.kind, i.name, i.quantity::text, i.seat, i.note
      FROM order_items i
      JOIN kitchen_tickets k ON k.id = i.kitchen_ticket_id
      LEFT JOIN order_items p ON p.id = i.parent_item_id
     WHERE i.kitchen_ticket_id IN (${idList}) AND ${VOIDED_SINCE}
     ORDER BY i.created_at, i.id`
    : sql`
    SELECT i.id, i.kitchen_ticket_id AS ticket_id, i.parent_item_id, NULL::text AS parent_name, i.kind, i.name, i.quantity::text, i.seat, i.note
      FROM order_items i
     WHERE i.kitchen_ticket_id IN (${idList}) AND i.status <> 'VOIDED'
     ORDER BY i.created_at, i.id`);
  const shown = new Set(items.filter((i) => i.kind === 'ITEM').map((i) => i.id));
  return tickets.map((t) => ({
    id: t.id,
    kind,
    ticketNumber: Number(t.ticket_number),
    reprint: t.print_count > 0,
    course: t.course,
    courseNote: t.course_note,
    firedAt: new Date(t.fired_at).toISOString(),
    station: { id: t.station_id, code: t.station_code, name: t.station_name },
    order: { orderNumber: Number(t.order_number), orderType: t.order_type, tableCode: t.table_code, customerName: t.customer_name },
    items: items
      // An item, or (VOID) a choice voided while its item stays: "Cheese (Burger)".
      .filter((i) => i.ticket_id === t.id && (i.kind === 'ITEM' || (kind === 'VOID' && !shown.has(i.parent_item_id ?? ''))))
      .map((i) => ({
        name: i.kind === 'ITEM' ? i.name : `${i.name} (${i.parent_name ?? '?'})`,
        quantity: toDec(i.quantity).toString(),
        seat: i.seat,
        note: i.kind === 'ITEM' ? i.note : null,
        choices: i.kind === 'ITEM' ? items.filter((m) => m.parent_item_id === i.id).map((m) => m.name) : [],
      })),
  }));
}
