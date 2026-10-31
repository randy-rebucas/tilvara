import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { reversalOf, type PostingLine, type SystemAccount } from '@1pos/accounting';
import { accounts, and, asc, branches, desc, eq, inArray, journalEntries, journalLines, legalEntities, sql, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  AccountListQuery,
  CreateAccountInput,
  CreateJournalEntryInput,
  JournalLinesQuery,
  JournalListQuery,
  PeriodActionInput,
  PeriodListQuery,
  ReverseJournalEntryInput,
  TrialBalanceQuery,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { post } from './ledger.js';
import { entityToday, localToday } from './today.js';

const money = (v: string | null | undefined) => toDec(v ?? '0').toFixed(2);

/**
 * The system accounts a manual entry may name (audit 2026-10-27 #11). Every other system account is kept
 * by documents and checked against them: Inventory 1200 and In transit 1210 against stock value, GRNI 2010
 * and Accounts payable 2000 against receipts and supplier invoices, Customer store credit 2300 against its
 * sub-ledger, VAT, sales, COGS and the variance accounts against the documents that post them. A manual
 * line there would make the books stop matching, mostly unseen. What is left is cash moved by hand: cash
 * on hand 1010 (funding or emptying the cash box), cash in bank 1030 (deposits, bank charges) and cash
 * fund transfers 3900 (the owner putting money in or taking it out). The business's own accounts (no
 * system key) are always allowed.
 */
export const MANUAL_SYSTEM_ACCOUNTS: ReadonlySet<string> = new Set<SystemAccount>(['CASH_ON_HAND', 'CASH_IN_BANK', 'CASH_TRANSFERS']);
const manualAllowed = (systemKey: string | null) => !systemKey || MANUAL_SYSTEM_ACCOUNTS.has(systemKey);
/** Most lines one export returns (a busy shop's year is far below this). */
const LINES_CAP = 50_000;

/**
 * Chart of accounts, journal, manual entries and reversals, periods, trial balance (ADR-0013).
 * Books are per legal entity: `accounting.read` / `accounting.post` at that entity.
 */
@Injectable()
export class AccountingService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    accounts_code_unique: ['ACCOUNT_CODE_TAKEN', 'This entity already has an account with this code'],
    journal_entries_reversal_unique: ['ALREADY_REVERSED', 'This entry was already reversed'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  listAccounts(auth: AuthContext, q: AccountListQuery) {
    return this.read(auth, async (db) => {
      await this.entity(db, auth, q.legalEntityId, 'accounting.read');
      const rows = await db.select().from(accounts).where(eq(accounts.legalEntityId, q.legalEntityId)).orderBy(asc(accounts.code));
      // `manualAllowed`: whether a manual entry may name it (archived ones are refused apart, ACCOUNT_ARCHIVED).
      return { data: rows.map((a) => ({ ...a, manualAllowed: manualAllowed(a.systemKey) })) };
    });
  }

  createAccount(auth: AuthContext, input: CreateAccountInput) {
    return this.mutate(auth, async (db) => {
      await this.entity(db, auth, input.legalEntityId, 'accounting.post');
      const [row] = await db.insert(accounts).values({ tenantId: tenantOf(auth).tenantId, ...input }).returning();
      await this.audit(db, auth, 'account.created', 'account', row!.id, { code: row!.code, type: row!.type });
      return row!;
    });
  }

  /**
   * Take one of the business's own accounts out of the pickers (manual entries refuse it). Its lines and balance stay
   * in the journal and the trial balance; restoring brings it back. System accounts (the ones the books post to by
   * themselves, and those of removed features) are never archived or restored here (DB: accounts_system_protected).
   */
  setAccountArchived(auth: AuthContext, id: string, archive: boolean) {
    return this.mutate(auth, async (db) => {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
      if (!account) throw notFound('Account');
      await this.entity(db, auth, account.legalEntityId, 'accounting.post');
      if (account.systemKey) {
        throw new AppError('ACCOUNT_SYSTEM', 'The books post to this account by themselves: it cannot be archived or restored', HttpStatus.CONFLICT);
      }
      if (Boolean(account.archivedAt) === archive) {
        throw new AppError('INVALID_STATE', archive ? 'This account is already archived' : 'This account is not archived', HttpStatus.CONFLICT);
      }
      const [row] = await db.update(accounts).set({ archivedAt: archive ? new Date() : null }).where(eq(accounts.id, id)).returning();
      await this.audit(db, auth, archive ? 'account.archived' : 'account.restored', 'account', id, { code: account.code });
      return row!;
    });
  }

  listEntries(auth: AuthContext, q: JournalListQuery) {
    return this.read(auth, async (db) => {
      await this.entity(db, auth, q.legalEntityId, 'accounting.read');
      const { rows } = await db.execute<{ id: string; entry_number: number; entry_date: string; source_type: string; source_id: string | null; memo: string | null; reverses_entry_id: string | null; total: string }>(sql`
        SELECT e.id, e.entry_number::int, e.entry_date::text, e.source_type, e.source_id, e.memo, e.reverses_entry_id, sum(l.debit)::text AS total
          FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
         WHERE e.legal_entity_id = ${q.legalEntityId}
           ${q.from ? sql`AND e.entry_date >= ${q.from}` : sql``} ${q.to ? sql`AND e.entry_date <= ${q.to}` : sql``}
           ${q.sourceType ? sql`AND e.source_type = ${q.sourceType}` : sql``} ${q.sourceId ? sql`AND e.source_id = ${q.sourceId}` : sql``}
           ${q.accountId ? sql`AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.journal_entry_id = e.id AND x.account_id = ${q.accountId})` : sql``}
         GROUP BY e.id ORDER BY e.entry_number DESC LIMIT 500`);
      return {
        data: rows.map((r) => ({
          id: r.id,
          entryNumber: r.entry_number,
          entryDate: r.entry_date,
          sourceType: r.source_type,
          sourceId: r.source_id,
          memo: r.memo,
          reversesEntryId: r.reverses_entry_id,
          total: money(r.total),
        })),
      };
    });
  }

  /** Flat journal lines (entry, account, branch, debit, credit) in entry order, for an export. */
  listLines(auth: AuthContext, q: JournalLinesQuery) {
    return this.read(auth, async (db) => {
      await this.entity(db, auth, q.legalEntityId, 'accounting.read');
      const { rows } = await db.execute<{ entry_number: number; entry_date: string; source_type: string; source_id: string | null; memo: string | null; account_code: string; account_name: string; branch_code: string | null; debit: string; credit: string }>(sql`
        SELECT e.entry_number::int, e.entry_date::text, e.source_type, e.source_id, e.memo,
               a.code AS account_code, a.name AS account_name, b.code AS branch_code, l.debit::text, l.credit::text
          FROM journal_entries e
          JOIN journal_lines l ON l.journal_entry_id = e.id
          JOIN accounts a ON a.id = l.account_id
          LEFT JOIN branches b ON b.id = l.branch_id
         WHERE e.legal_entity_id = ${q.legalEntityId} AND e.entry_date BETWEEN ${q.from} AND ${q.to}
         ORDER BY e.entry_number, l.id
         LIMIT ${LINES_CAP + 1}`);
      if (rows.length > LINES_CAP) {
        throw new AppError('RANGE_TOO_LARGE', `More than ${LINES_CAP} lines: export a shorter range`, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      return {
        legalEntityId: q.legalEntityId,
        from: q.from,
        to: q.to,
        data: rows.map((r) => ({
          entryNumber: r.entry_number,
          entryDate: r.entry_date,
          sourceType: r.source_type,
          sourceId: r.source_id,
          memo: r.memo,
          accountCode: r.account_code,
          accountName: r.account_name,
          branchCode: r.branch_code,
          debit: money(r.debit),
          credit: money(r.credit),
        })),
      };
    });
  }

  getEntry(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
      if (!entry) throw notFound('Journal entry');
      await this.entity(db, auth, entry.legalEntityId, 'accounting.read');
      return this.view(db, entry);
    });
  }

  createManual(auth: AuthContext, input: CreateJournalEntryInput) {
    return this.mutate(auth, async (db) => {
      await this.entity(db, auth, input.legalEntityId, 'accounting.post');
      const branchIds = [...new Set(input.lines.flatMap((l) => (l.branchId ? [l.branchId] : [])))];
      for (const b of branchIds) {
        const [row] = await db.select({ legalEntityId: branches.legalEntityId }).from(branches).where(eq(branches.id, b));
        if (!row) throw notFound('Branch');
        if (row.legalEntityId !== input.legalEntityId) throw unprocessable('BRANCH_OF_OTHER_ENTITY', 'The branch belongs to another legal entity', { branchId: b });
      }
      const named = [...new Set(input.lines.map((l) => l.accountId))];
      const kept = (
        await db
          .select({ id: accounts.id, systemKey: accounts.systemKey })
          .from(accounts)
          .where(and(eq(accounts.legalEntityId, input.legalEntityId), inArray(accounts.id, named)))
      ).filter((a) => !manualAllowed(a.systemKey));
      if (kept.length) {
        throw unprocessable('SYSTEM_ACCOUNT_NOT_ALLOWED', 'The books keep these accounts from their documents: a manual entry cannot post to them', {
          accounts: kept.map((a) => a.id),
          systemKeys: kept.map((a) => a.systemKey),
        });
      }
      // A typo such as 2062 would open that far period and sit in every report until then (audit 2026-10-31 #23).
      const today = await entityToday(db, input.legalEntityId);
      if (input.entryDate > today) throw unprocessable('DATE_IN_FUTURE', 'The entry date is after today', { today });
      const entry = await post(db, {
        tenantId: tenantOf(auth).tenantId,
        legalEntityId: input.legalEntityId,
        entryDate: input.entryDate,
        sourceType: 'MANUAL',
        memo: input.memo,
        lines: input.lines.map((l) => ({ account: l.accountId, debit: l.debit ?? '0', credit: l.credit ?? '0', branchId: l.branchId ?? null, memo: l.memo ?? null })),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'journal.manual_posted', 'journal_entry', entry!.id, { entryDate: input.entryDate, memo: input.memo });
      return this.view(db, entry!);
    });
  }

  /** Mirror an entry, once. The original stays; both remain in the books. */
  reverse(auth: AuthContext, id: string, input: ReverseJournalEntryInput) {
    return this.mutate(auth, async (db) => {
      const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
      if (!entry) throw notFound('Journal entry');
      await this.entity(db, auth, entry.legalEntityId, 'accounting.post');
      if (entry.sourceType === 'REVERSAL') throw unprocessable('CANNOT_REVERSE_REVERSAL', 'Post a new entry instead of reversing a reversal');
      // An invoice's entry is undone by cancelling the invoice, which also frees its receipts; a
      // reversal by hand would leave the invoice open against books that no longer carry it.
      if (entry.sourceType === 'SUPPLIER_INVOICE') throw unprocessable('CANCEL_THE_DOCUMENT', 'Cancel the supplier invoice instead of reversing its entry');
      // The same for a payment (void it: the invoices it settled open again) and a note (record an opposite note).
      if (entry.sourceType === 'SUPPLIER_PAYMENT') throw unprocessable('CANCEL_THE_DOCUMENT', 'Void the supplier payment instead of reversing its entry');
      if (entry.sourceType === 'SUPPLIER_NOTE') throw unprocessable('CANCEL_THE_DOCUMENT', 'Record an opposite note instead of reversing this entry');
      // Every other document's entry too (a sale, return, receipt, count, adjustment, transfer, drawer
      // difference, and the retired lodging/laundry ones): the books must keep matching the documents
      // (ledger.test, the traceability audit), and a return of a sale whose entry was undone would post again.
      // Only a manual entry is corrected by a reversal.
      if (entry.sourceType !== 'MANUAL') {
        throw unprocessable('CANCEL_THE_DOCUMENT', 'This entry was posted by its document: correct the document (a return or void, a count, an adjustment) instead of reversing its entry', { sourceType: entry.sourceType });
      }
      const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, id));
      const posting: PostingLine[] = lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, branchId: l.branchId, memo: l.memo }));
      const branchId = lines.find((l) => l.branchId)?.branchId ?? null;
      // Not before its original, and not after today unless on the original's own date (an entry dated ahead
      // before this rule can still be undone on its date) (audit 2026-10-31 #23).
      let entryDate = input.entryDate;
      if (entryDate) {
        if (entryDate < entry.entryDate) throw unprocessable('REVERSAL_BEFORE_ORIGINAL', 'A reversal cannot be dated before the entry it reverses', { originalDate: entry.entryDate });
        const today = await entityToday(db, entry.legalEntityId);
        if (entryDate > today && entryDate !== entry.entryDate) throw unprocessable('DATE_IN_FUTURE', 'The reversal date is after today', { today });
      } else {
        // Today, as post() would date it; an original dated ahead is reversed on its own date.
        const [b] = branchId ? await db.select({ tz: branches.timezone }).from(branches).where(eq(branches.id, branchId)) : [];
        const today = await localToday(db, b?.tz ?? 'Asia/Manila');
        if (today < entry.entryDate) entryDate = entry.entryDate;
      }
      const reversal = await post(db, {
        tenantId: entry.tenantId,
        legalEntityId: entry.legalEntityId,
        branchId,
        ...(entryDate && { entryDate }),
        sourceType: 'REVERSAL',
        reversesEntryId: entry.id,
        memo: input.memo,
        lines: reversalOf(posting),
        // Undoing a manual entry must stay possible after one of its accounts was archived.
        allowArchived: true,
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'journal.reversed', 'journal_entry', entry.id, { reversalId: reversal!.id, memo: input.memo });
      return this.view(db, reversal!);
    });
  }

  listPeriods(auth: AuthContext, q: PeriodListQuery) {
    return this.read(auth, async (db) => {
      await this.entity(db, auth, q.legalEntityId, 'accounting.read');
      const { rows } = await db.execute<{ id: string; starts_on: string; status: string; closed_by: string | null; closed_at: string | null }>(
        sql`SELECT id, starts_on::text, status, closed_by, closed_at FROM accounting_periods WHERE legal_entity_id = ${q.legalEntityId} ORDER BY starts_on DESC`,
      );
      return { data: rows.map((r) => ({ id: r.id, month: r.starts_on.slice(0, 7), status: r.status, closedBy: r.closed_by, closedAt: r.closed_at })) };
    });
  }

  /** Close a past month: nothing more can be posted into it. The month in progress cannot be closed. */
  closePeriod(auth: AuthContext, input: PeriodActionInput) {
    return this.mutate(auth, async (db) => {
      await this.entity(db, auth, input.legalEntityId, 'accounting.post');
      const startsOn = `${input.month}-01`;
      // The latest local date among the entity's branches (default Manila): today's month stays open.
      const currentMonth = (await entityToday(db, input.legalEntityId)).slice(0, 7);
      if (input.month >= currentMonth) throw unprocessable('PERIOD_IN_PROGRESS', 'Only a month that has ended can be closed', { currentMonth });
      await db.execute(sql`
        INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on, status, closed_by, closed_at)
        VALUES (${tenantOf(auth).tenantId}, ${input.legalEntityId}, ${startsOn}, 'CLOSED', ${auth.userId}, now())
        ON CONFLICT (tenant_id, legal_entity_id, starts_on)
        DO UPDATE SET status = 'CLOSED', closed_by = EXCLUDED.closed_by, closed_at = now() WHERE accounting_periods.status = 'OPEN'`);
      await this.audit(db, auth, 'period.closed', 'legal_entity', input.legalEntityId, { month: input.month });
      return { month: input.month, status: 'CLOSED' };
    });
  }

  reopenPeriod(auth: AuthContext, input: PeriodActionInput) {
    return this.mutate(auth, async (db) => {
      await this.entity(db, auth, input.legalEntityId, 'accounting.post');
      if (!input.reason) throw new AppError('VALIDATION_FAILED', 'Say why the period is reopened', HttpStatus.BAD_REQUEST);
      const { rows } = await db.execute<{ id: string }>(sql`
        UPDATE accounting_periods SET status = 'OPEN', closed_by = NULL, closed_at = NULL
         WHERE legal_entity_id = ${input.legalEntityId} AND starts_on = ${`${input.month}-01`} AND status = 'CLOSED' RETURNING id`);
      if (!rows.length) throw new AppError('INVALID_STATE', 'That period is not closed', HttpStatus.CONFLICT);
      await this.audit(db, auth, 'period.reopened', 'legal_entity', input.legalEntityId, { month: input.month, reason: input.reason });
      return { month: input.month, status: 'OPEN' };
    });
  }

  /** Per account: opening balance before `from`, debits and credits in the range, closing balance. */
  trialBalance(auth: AuthContext, q: TrialBalanceQuery) {
    return this.read(auth, async (db) => {
      await this.entity(db, auth, q.legalEntityId, 'accounting.read');
      const { rows } = await db.execute<{ id: string; code: string; name: string; type: string; system_key: string | null; opening: string; debit: string; credit: string }>(sql`
        SELECT a.id, a.code, a.name, a.type, a.system_key,
               coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < ${q.from}), 0)::text AS opening,
               coalesce(sum(l.debit) FILTER (WHERE e.entry_date BETWEEN ${q.from} AND ${q.to}), 0)::text AS debit,
               coalesce(sum(l.credit) FILTER (WHERE e.entry_date BETWEEN ${q.from} AND ${q.to}), 0)::text AS credit
          FROM accounts a
          LEFT JOIN journal_lines l ON l.account_id = a.id
          LEFT JOIN journal_entries e ON e.id = l.journal_entry_id AND e.entry_date <= ${q.to}
         WHERE a.legal_entity_id = ${q.legalEntityId} AND (l.id IS NULL OR e.id IS NOT NULL)
         GROUP BY a.id ORDER BY a.code`);
      let debit = new Dec(0);
      let credit = new Dec(0);
      let closingSum = new Dec(0);
      const data = rows
        .map((r) => {
          const closing = toDec(r.opening).plus(r.debit).minus(r.credit);
          debit = debit.plus(r.debit);
          credit = credit.plus(r.credit);
          closingSum = closingSum.plus(closing);
          return { accountId: r.id, code: r.code, name: r.name, type: r.type, systemKey: r.system_key, opening: money(r.opening), debit: money(r.debit), credit: money(r.credit), closing: money(closing.toString()) };
        })
        .filter((r) => r.opening !== '0.00' || r.debit !== '0.00' || r.credit !== '0.00');
      return { legalEntityId: q.legalEntityId, from: q.from, to: q.to, data, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2), closing: closingSum.toFixed(2) } };
    });
  }

  private async entity(db: Database, auth: AuthContext, legalEntityId: string, perm: 'accounting.read' | 'accounting.post') {
    const [row] = await db.select().from(legalEntities).where(eq(legalEntities.id, legalEntityId));
    if (!row) throw notFound('Legal entity');
    this.assertCan(auth, perm, { legalEntityId });
    return row;
  }

  private async view(db: Database, e: typeof journalEntries.$inferSelect) {
    const lines = await db
      .select({ line: journalLines, code: accounts.code, name: accounts.name, systemKey: accounts.systemKey })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.journalEntryId, e.id))
      .orderBy(desc(journalLines.debit), asc(accounts.code));
    const [reversedBy] = await db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.reversesEntryId, e.id)));
    return {
      ...e,
      reversedBy: reversedBy?.id ?? null,
      lines: lines.map((l) => ({ ...l.line, accountCode: l.code, accountName: l.name, systemKey: l.systemKey, debit: money(l.line.debit), credit: money(l.line.credit) })),
      total: money(lines.reduce((a, l) => a.plus(l.line.debit), new Dec(0)).toString()),
    };
  }
}
