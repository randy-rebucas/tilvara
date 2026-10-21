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
  const { rows: claimed } = await db.execute<{ id: string }>(sql`
    UPDATE kitchen_tickets t SET print_claimed_at = now(), print_claimed_by = ${terminalId}
     WHERE t.id IN (
       SELECT k.id FROM kitchen_tickets k
        WHERE k.branch_id = ${branchId}
          AND k.station_id IN (${sql.join(stationIds.map((s) => sql`${s}::uuid`), sql`, `)})
          AND k.printed_at IS NULL
          AND (k.fired_at > now() - make_interval(hours => ${PRINT_MAX_AGE_HOURS}) OR k.print_count > 0)
          AND (k.print_claimed_at IS NULL OR k.print_claimed_at < now() - make_interval(secs => ${PRINT_CLAIM_SECONDS}))
        ORDER BY k.fired_at, k.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING t.id`);
  return ticketsForPrint(db, claimed.map((c) => c.id));
}

/** What a ticket prints: its station, where the food goes, and the live items with their choices. */
export async function ticketsForPrint(db: Database, ids: string[]): Promise<KitchenTicketPrint[]> {
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
      JOIN restaurant_orders o ON o.id = k.order_id
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
     WHERE k.id IN (${idList})
     ORDER BY k.fired_at, k.id`);
  const { rows: items } = await db.execute<{ id: string; ticket_id: string; parent_item_id: string | null; kind: string; name: string; quantity: string; seat: number | null; note: string | null }>(sql`
    SELECT i.id, i.kitchen_ticket_id AS ticket_id, i.parent_item_id, i.kind, i.name, i.quantity::text, i.seat, i.note
      FROM order_items i
     WHERE i.kitchen_ticket_id IN (${idList}) AND i.status <> 'VOIDED'
     ORDER BY i.created_at, i.id`);
  return tickets.map((t) => ({
    id: t.id,
    ticketNumber: Number(t.ticket_number),
    reprint: t.print_count > 0,
    course: t.course,
    courseNote: t.course_note,
    firedAt: new Date(t.fired_at).toISOString(),
    station: { id: t.station_id, code: t.station_code, name: t.station_name },
    order: { orderNumber: Number(t.order_number), orderType: t.order_type, tableCode: t.table_code, customerName: t.customer_name },
    items: items
      .filter((i) => i.ticket_id === t.id && i.kind === 'ITEM')
      .map((i) => ({
        name: i.name,
        quantity: toDec(i.quantity).toString(),
        seat: i.seat,
        note: i.note,
        choices: items.filter((m) => m.parent_item_id === i.id).map((m) => m.name),
      })),
  }));
}
