import { HttpStatus } from '@nestjs/common';
import { balanced, DEFAULT_CHART, UnbalancedEntryError, type PostingLine } from '@1pos/accounting';
import { accounts, and, branches, eq, journalEntries, journalLines, sql, type Database } from '@1pos/database';
import { nextNumber } from '../common/sequence.js';
import { AppError } from '../infrastructure/http-error.filter.js';

export type SourceType =
  | 'SALE' | 'SALE_RETURN' | 'GOODS_RECEIPT' | 'SUPPLIER_RETURN' | 'STOCK_ADJUSTMENT' | 'STOCK_COUNT'
  | 'TRANSFER_DISPATCH' | 'TRANSFER_RECEIPT' | 'CASH_MOVEMENT' | 'CASH_VARIANCE' | 'MANUAL' | 'REVERSAL';

export interface PostInput {
  tenantId: string;
  legalEntityId: string;
  /** Branch whose local calendar dates the entry; also the default line dimension. */
  branchId?: string | null;
  /** Explicit date (manual entries); otherwise today in the branch's timezone (DB clock). */
  entryDate?: string;
  sourceType: SourceType;
  sourceId?: string | null;
  memo?: string | null;
  reversesEntryId?: string | null;
  lines: PostingLine[];
  createdBy: string;
}

/** Seed the default chart for a new legal entity (same list as migration 0029). */
export async function seedChart(db: Database, tenantId: string, legalEntityId: string) {
  await db.insert(accounts).values(DEFAULT_CHART.map((a) => ({ tenantId, legalEntityId, code: a.code, name: a.name, type: a.type, systemKey: a.key })));
}

/**
 * Post a balanced entry inside the caller's transaction (ADR-0013): one entry per source
 * document, in the month of its local business date. Lines name system accounts by key or
 * accounts by id. Nothing to post (all zero) → no entry, returns null.
 */
export async function post(db: Database, input: PostInput) {
  let lines: PostingLine[];
  try {
    lines = balanced(input.lines);
  } catch (e) {
    if (e instanceof UnbalancedEntryError) {
      throw new AppError('UNBALANCED_ENTRY', 'Debits and credits must be equal', HttpStatus.UNPROCESSABLE_ENTITY, { debit: e.debit, credit: e.credit });
    }
    throw e;
  }
  if (!lines.length) return null;

  const keys = [...new Set(lines.map((l) => l.account))];
  const found = await db
    .select({ id: accounts.id, key: accounts.systemKey, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(and(eq(accounts.legalEntityId, input.legalEntityId), sql`(${accounts.systemKey} IN ${keys} OR ${accounts.id}::text IN ${keys})`));
  const idOf = (k: string) => found.find((a) => a.key === k || a.id === k);
  const missing = keys.filter((k) => !idOf(k));
  if (missing.length) {
    // Unknown here (another entity's or another tenant's id): not found, like any foreign id.
    throw new AppError('ACCOUNT_NOT_FOUND', 'An account for this posting is not in this entity’s chart', HttpStatus.NOT_FOUND, { accounts: missing });
  }
  const archivedUsed = keys.filter((k) => idOf(k)!.archivedAt);
  if (archivedUsed.length) throw new AppError('ACCOUNT_ARCHIVED', 'Cannot post to an archived account', HttpStatus.CONFLICT, { accounts: archivedUsed });

  let entryDate = input.entryDate;
  if (!entryDate) {
    const tz = input.branchId
      ? (await db.select({ tz: branches.timezone }).from(branches).where(eq(branches.id, input.branchId)))[0]?.tz
      : undefined;
    const { rows } = await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${tz ?? 'Asia/Manila'})::date::text AS d`);
    entryDate = rows[0]!.d;
  }
  // The month's period exists from its first entry on (OPEN); a CLOSED one refuses the insert (trigger).
  await db.execute(sql`
    INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on)
    VALUES (${input.tenantId}, ${input.legalEntityId}, date_trunc('month', ${entryDate}::date)::date)
    ON CONFLICT (tenant_id, legal_entity_id, starts_on) DO NOTHING`);
  const { rows: [period] } = await db.execute<{ status: string }>(
    sql`SELECT status FROM accounting_periods WHERE legal_entity_id = ${input.legalEntityId} AND starts_on = date_trunc('month', ${entryDate}::date)::date`,
  );
  if (period!.status === 'CLOSED') {
    throw new AppError('PERIOD_CLOSED', `The accounting period for ${entryDate} is closed`, HttpStatus.CONFLICT, { entryDate });
  }

  const entryNumber = await nextNumber(db, input.tenantId, input.legalEntityId, 'JOURNAL');
  const [entry] = await db
    .insert(journalEntries)
    .values({
      tenantId: input.tenantId,
      legalEntityId: input.legalEntityId,
      entryNumber,
      entryDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      memo: input.memo ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  await db.insert(journalLines).values(
    lines.map((l) => ({
      tenantId: input.tenantId,
      legalEntityId: input.legalEntityId,
      journalEntryId: entry!.id,
      accountId: idOf(l.account)!.id,
      branchId: l.branchId ?? input.branchId ?? null,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
    })),
  );
  return entry!;
}

/** Σ signed values of the given stock movements (by id), for postings built from the ledger. */
export async function movementValue(db: Database, ids: string[]) {
  if (!ids.length) return '0';
  const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(value), 0)::text AS v FROM stock_movements WHERE id IN ${ids}`);
  return rows[0]!.v;
}
