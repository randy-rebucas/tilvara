import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { branches, legalEntities } from './organization.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });

/** Chart of accounts per legal entity (ADR-0013). System accounts carry a fixed `system_key`. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    systemKey: text('system_key'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('accounts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('accounts_entity_id_unique').on(t.tenantId, t.legalEntityId, t.id),
    unique('accounts_code_unique').on(t.tenantId, t.legalEntityId, t.code),
    uniqueIndex('accounts_system_key_unique').on(t.tenantId, t.legalEntityId, t.systemKey).where(sql`${t.systemKey} IS NOT NULL`),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    check('accounts_type_check', sql`${t.type} IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')`),
    check('accounts_name_check', sql`length(trim(${t.name})) > 0 AND length(trim(${t.code})) > 0`),
  ],
);

/** Calendar months; entries can only land in an OPEN period (trigger-enforced). */
export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    startsOn: date('starts_on').notNull(),
    status: text('status').notNull().default('OPEN'),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('accounting_periods_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('accounting_periods_month_unique').on(t.tenantId, t.legalEntityId, t.startsOn),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    check('accounting_periods_status_check', sql`${t.status} IN ('OPEN','CLOSED')`),
    check('accounting_periods_month_check', sql`extract(day FROM ${t.startsOn}) = 1`),
  ],
);

/** Append-only. One entry per source document (`source_type`, `source_id`); corrections are reversals. */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    entryNumber: bigint('entry_number', { mode: 'number' }).notNull(),
    entryDate: date('entry_date').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    memo: text('memo'),
    reversesEntryId: uuid('reverses_entry_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('journal_entries_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('journal_entries_entity_id_unique').on(t.tenantId, t.legalEntityId, t.id),
    unique('journal_entries_number_unique').on(t.tenantId, t.legalEntityId, t.entryNumber),
    uniqueIndex('journal_entries_source_unique').on(t.tenantId, t.sourceType, t.sourceId).where(sql`${t.sourceId} IS NOT NULL`),
    uniqueIndex('journal_entries_reversal_unique').on(t.tenantId, t.reversesEntryId).where(sql`${t.reversesEntryId} IS NOT NULL`),
    foreignKey({ columns: [t.tenantId, t.legalEntityId], foreignColumns: [legalEntities.tenantId, legalEntities.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId, t.reversesEntryId], foreignColumns: [t.tenantId, t.legalEntityId, t.id] }),
    index('journal_entries_date_idx').on(t.tenantId, t.legalEntityId, t.entryDate),
    check(
      'journal_entries_source_check',
      sql`${t.sourceType} IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','MANUAL','REVERSAL')`,
    ),
    check('journal_entries_manual_memo', sql`${t.sourceType} NOT IN ('MANUAL','REVERSAL') OR length(trim(coalesce(${t.memo}, ''))) > 0`),
    check('journal_entries_reversal_link', sql`(${t.sourceType} = 'REVERSAL') = (${t.reversesEntryId} IS NOT NULL)`),
  ],
);

/** Append-only; each line is a debit or a credit. Σ debit = Σ credit per entry (deferred trigger). */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    accountId: uuid('account_id').notNull(),
    branchId: uuid('branch_id'),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    memo: text('memo'),
  },
  (t) => [
    unique('journal_lines_tenant_id_id_unique').on(t.tenantId, t.id),
    // Lines, their entry and their account all belong to the same legal entity.
    foreignKey({ columns: [t.tenantId, t.legalEntityId, t.journalEntryId], foreignColumns: [journalEntries.tenantId, journalEntries.legalEntityId, journalEntries.id] }),
    foreignKey({ columns: [t.tenantId, t.legalEntityId, t.accountId], foreignColumns: [accounts.tenantId, accounts.legalEntityId, accounts.id] }),
    foreignKey({ columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    index('journal_lines_entry_idx').on(t.tenantId, t.journalEntryId),
    index('journal_lines_account_idx').on(t.tenantId, t.accountId),
    check('journal_lines_amount_check', sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND (${t.debit} = 0) <> (${t.credit} = 0)`),
  ],
);
