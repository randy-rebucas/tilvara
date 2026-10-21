import { HttpStatus } from '@nestjs/common';
import type { PostingLine } from '@1pos/accounting';
import { and, eq, folioEntries, folios, sql, stays, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { notFound } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';

export type StayRow = typeof stays.$inferSelect;
export type FolioRow = typeof folios.$inferSelect;
export type FolioEntryRow = typeof folioEntries.$inferSelect;

/** The lock the folio-entry trigger takes too (migration 0102): one folio's entries one at a time. */
export const lockFolio = (db: Database, folioId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`folio:${folioId}`}, 0))`);
/** The lock the deposit trigger takes too: one stay's deposits one at a time. */
export const lockDeposits = (db: Database, stayId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`deposit:${stayId}`}, 0))`);

export async function folioBalance(db: Database, folioId: string): Promise<Dec> {
  const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(amount), 0)::text AS v FROM folio_entries WHERE folio_id = ${folioId}`);
  return toDec(rows[0]!.v);
}

/** What a stay holds in deposits (Σ RECEIVED − APPLIED − REFUNDED − FORFEITED). */
export async function depositsHeld(db: Database, stayId: string): Promise<Dec> {
  const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(amount), 0)::text AS v FROM stay_deposits WHERE stay_id = ${stayId}`);
  return toDec(rows[0]!.v);
}

/**
 * With `lock`: FOR NO KEY UPDATE, which still serialises changes to the stay but lets folio entries and
 * deposits (whose foreign keys take KEY SHARE on the stay) be written meanwhile; FOR UPDATE made a
 * check-out holding the stay and waiting for the folio lock deadlock with a payment holding the folio
 * lock and inserting an entry (audit 2026-10-21).
 */
export async function loadStay(db: Database, id: string, lock = false): Promise<StayRow> {
  const q = db.select().from(stays).where(eq(stays.id, id));
  const [row] = lock ? await q.for('no key update') : await q;
  if (!row) throw notFound('Stay');
  return row;
}

export async function folioOfStay(db: Database, stayId: string): Promise<FolioRow | undefined> {
  return (await db.select().from(folios).where(eq(folios.stayId, stayId)))[0];
}

/** The stay's folio, opened now if it has none yet (check-in or the first deposit, §5). */
export async function ensureFolio(db: Database, stay: StayRow, userId: string): Promise<FolioRow> {
  const found = await folioOfStay(db, stay.id);
  if (found) return found;
  const { rows } = await db.execute<{ currency: string }>(sql`SELECT coalesce((SELECT currency FROM price_lists WHERE is_default AND archived_at IS NULL LIMIT 1), 'PHP') AS currency`);
  const [row] = await db
    .insert(folios)
    .values({ tenantId: stay.tenantId, legalEntityId: stay.legalEntityId, branchId: stay.branchId, stayId: stay.id, currency: rows[0]!.currency, openedBy: userId })
    .returning();
  return row!;
}

/**
 * Money taken or given back at a drawer (§5.2): the lines post with the drawer's branch, except the
 * guest's own account (guest ledger, guest deposits), which stays with the stay's branch, as the nights
 * and the deposits applied do. The entry stays balanced (only the branch tag moves).
 */
export const liabilityAtStayBranch = (lines: PostingLine[], account: 'GUEST_LEDGER' | 'GUEST_DEPOSITS', stayBranchId: string): PostingLine[] =>
  lines.map((l) => (l.account === account ? { ...l, branchId: stayBranchId } : l));

export const folioSettled = () => new AppError('FOLIO_SETTLED', 'This folio is settled and takes no more entries', HttpStatus.CONFLICT);

/**
 * The journal date for a document of `date` (§7): that day, unless its month is closed; then the first
 * day of the first open month after it.
 */
export async function openJournalDate(db: Database, legalEntityId: string, date: string): Promise<string> {
  let d = date;
  for (let i = 0; i < 36; i += 1) {
    const { rows } = await db.execute<{ status: string }>(sql`
      SELECT status FROM accounting_periods WHERE legal_entity_id = ${legalEntityId} AND starts_on = date_trunc('month', ${d}::date)::date`);
    if (rows[0]?.status !== 'CLOSED') return d;
    const { rows: [next] } = await db.execute<{ d: string }>(sql`SELECT (date_trunc('month', ${d}::date) + interval '1 month')::date::text AS d`);
    d = next!.d;
  }
  throw new AppError('PERIOD_CLOSED', 'No open accounting period to book this in', HttpStatus.CONFLICT, { entryDate: date });
}

/** Insert one folio entry (the caller holds the folio lock) and tell a PMS about it (ids only, §13). */
export async function insertEntry(db: Database, values: typeof folioEntries.$inferInsert, correlationId?: string | null): Promise<FolioEntryRow> {
  const [row] = await db.insert(folioEntries).values(values).returning();
  await emitEvent(db, { tenantId: values.tenantId, topic: 'folio.entry_posted', payload: { folioId: row!.folioId, entryId: row!.id, kind: row!.kind, stayId: row!.stayId }, correlationId });
  return row!;
}

/** Outlet charges on a folio so far, net of returns (what `charge_limit` caps). */
export async function chargedSoFar(db: Database, folioId: string): Promise<Dec> {
  const { rows } = await db.execute<{ v: string }>(
    sql`SELECT coalesce(sum(amount), 0)::text AS v FROM folio_entries WHERE folio_id = ${folioId} AND kind IN ('CHARGE', 'CHARGE_RETURN')`,
  );
  return toDec(rows[0]!.v);
}

/**
 * Charge to room (§5.1), checked before the sale is written: an in-house stay of the sale's legal entity
 * (any of its branches), charges allowed, within the limit, its folio open. Locks the folio.
 */
export async function planRoomCharge(db: Database, a: { stayId: string; legalEntityId: string; amount: Dec }) {
  const [stay] = await db.select().from(stays).where(eq(stays.id, a.stayId));
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found', HttpStatus.NOT_FOUND, { stayId: a.stayId });
  if (stay.legalEntityId !== a.legalEntityId) throw unprocessable('ROOM_CHARGE_WRONG_ENTITY', 'This guest stays with another legal entity; charge them there');
  if (stay.status !== 'IN_HOUSE') throw new AppError('GUEST_NOT_IN_HOUSE', 'This guest is not checked in', HttpStatus.CONFLICT, { status: stay.status });
  if (!stay.allowCharges) throw new AppError('ROOM_CHARGES_NOT_ALLOWED', 'This stay takes no charges to the room', HttpStatus.CONFLICT);
  const folio = await folioOfStay(db, stay.id);
  if (!folio || folio.status !== 'OPEN') throw folioSettled();
  await lockFolio(db, folio.id);
  if (stay.chargeLimit !== null) {
    const charged = await chargedSoFar(db, folio.id);
    const limit = toDec(stay.chargeLimit);
    if (charged.plus(a.amount).gt(limit)) {
      throw new AppError('ROOM_CHARGE_LIMIT', 'This is more than the stay may charge to the room', HttpStatus.CONFLICT, {
        limit: limit.toFixed(2), charged: charged.toFixed(2), available: Dec.max(limit.minus(charged), 0).toFixed(2),
      });
    }
  }
  return { stay, folio };
}

/** The guest's open folio for a return of a room-charged sale (§5.1): how much of the refund goes back onto it. */
export async function folioRefundPlan(db: Database, a: { saleId: string; stayId: string; refund: Dec }) {
  const folio = await folioOfStay(db, a.stayId);
  if (!folio || folio.status !== 'OPEN' || a.refund.lte(0)) return null;
  await lockFolio(db, folio.id);
  const { rows: [r] } = await db.execute<{ charged: string; back: string }>(sql`
    SELECT coalesce(sum(amount) FILTER (WHERE kind = 'CHARGE'), 0)::text AS charged,
           coalesce(-sum(amount) FILTER (WHERE kind = 'CHARGE_RETURN'), 0)::text AS back
      FROM folio_entries WHERE folio_id = ${folio.id} AND sale_id = ${a.saleId}`);
  const left = toDec(r!.charged).minus(r!.back);
  // Never more than the folio still owes: a paid folio gives the rest back as the till does today.
  const amount = Dec.min(a.refund, left, Dec.max(await folioBalance(db, folio.id), 0));
  return amount.gt(0) ? { folio, amount } : null;
}

export const stayGuestName = async (db: Database, stay: Pick<StayRow, 'id' | 'customerId' | 'guestName'>): Promise<string | null> => {
  const { rows: [r] } = await db.execute<{ name: string | null }>(sql`
    SELECT coalesce(
      (SELECT g.full_name FROM stay_guests g WHERE g.stay_id = ${stay.id} AND g.is_primary),
      ${stay.guestName}::text,
      (SELECT c.display_name FROM customers c WHERE c.id = ${stay.customerId}::uuid)) AS name`);
  return r?.name ?? null;
};

/** "Reyes" of "Liza Reyes": what the receipt prints after the room number. */
export const surnameOf = (name: string | null) => (name ? (name.trim().split(/\s+/).at(-1) ?? null) : null);

export const entryOf = (db: Database, folioId: string, id: string) =>
  db.select().from(folioEntries).where(and(eq(folioEntries.folioId, folioId), eq(folioEntries.id, id)));
