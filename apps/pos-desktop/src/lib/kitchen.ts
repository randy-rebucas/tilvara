import type { PrintableReceipt } from '@1pos/escpos';
import type { KitchenTicketPrint, LocalKitchenTicket } from '@1pos/pos-offline';

/**
 * Kitchen tickets on paper (session 25). Wording is English and short, as kitchens read it at a
 * glance: where the food goes (call number, table or takeaway name) printed large, then each item
 * with its quantity, its choices and the note. A reprint says so.
 */
export interface KitchenSlip {
  station: string;
  /** "#12 Ana", "Table T4 · #31", "Takeaway Ben · #7". */
  where: string;
  ticket: string | null;
  reprint?: boolean;
  /** A VOID slip (audit 2026-10-21): the items listed were voided after the ticket printed; stop making them. */
  voided?: boolean;
  courseNote?: string | null;
  dateTime: string;
  items: { name: string; quantity: string; seat?: number | null; note?: string | null; choices: string[] }[];
}

export function kitchenSlipToPrintable(s: KitchenSlip): PrintableReceipt {
  return {
    ...(s.voided && { banner: '*** VOID ***' }),
    header: [s.station.toUpperCase()],
    notice: s.voided ? 'VOID - DO NOT MAKE' : s.reprint ? 'REPRINT - KITCHEN TICKET' : 'KITCHEN TICKET',
    meta: [[s.ticket ?? '', s.dateTime]],
    items: s.items.flatMap((i) => [
      { name: `${i.quantity} x ${i.name}${i.seat ? ` (seat ${i.seat})` : ''}`, amount: '' },
      ...i.choices.map((c) => ({ name: `  + ${c}`, amount: '' })),
      ...(i.note ? [{ name: `  ! ${i.note}`, amount: '' }] : []),
    ]),
    totals: [{ label: s.where, amount: '', emphasis: true }],
    payments: [],
    footer: s.courseNote ? [`Note: ${s.courseNote}`] : [],
  };
}

/** Where a ticket's food goes, as the kitchen calls it. */
export function ticketWhere(o: KitchenTicketPrint['order']): string {
  if (o.orderType === 'COUNTER') return `#${o.orderNumber}${o.customerName ? ` ${o.customerName}` : ''}`;
  if (o.orderType === 'DINE_IN') return `Table ${o.tableCode ?? '?'} · #${o.orderNumber}`;
  return `Takeaway${o.customerName ? ` ${o.customerName}` : ''} · #${o.orderNumber}`;
}

/** A ticket the server handed this till to print. */
export function serverTicketSlip(t: KitchenTicketPrint, dateTime: string): KitchenSlip {
  return {
    station: t.station.name,
    where: ticketWhere(t.order),
    ticket: `Ticket ${t.ticketNumber}${t.course > 1 ? ` · course ${t.course}` : ''}`,
    reprint: t.reprint,
    voided: t.kind === 'VOID',
    // A VOID slip says what to stop, not the course's note.
    courseNote: t.kind === 'VOID' ? null : t.courseNote,
    dateTime,
    items: t.items,
  };
}

/** A ticket the till made itself for an offline counter sale (its call number is the sale's device number). */
export function localTicketSlip(t: LocalKitchenTicket, call: { callNumber: number; pickupName?: string | undefined }, dateTime: string): KitchenSlip {
  return {
    station: t.station.name,
    where: `#${call.callNumber}${call.pickupName ? ` ${call.pickupName}` : ''}`,
    ticket: 'Offline',
    dateTime,
    items: t.items,
  };
}
