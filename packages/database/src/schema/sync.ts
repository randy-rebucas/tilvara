import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { registers, terminals } from './organization.js';
import { cashierSessions, sales } from './sales.js';

/**
 * A configuration snapshot handed to a terminal (ADR-0015 §3). Offline sales name it, and the server
 * re-prices them as of `as_of` — a time the server chose, so a terminal cannot pick an old price.
 */
export const terminalSnapshots = pgTable(
  'terminal_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    registerId: uuid('register_id').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('terminal_snapshots_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.terminalId], foreignColumns: [terminals.tenantId, terminals.id] }),
    foreignKey({ columns: [t.tenantId, t.registerId], foreignColumns: [registers.tenantId, registers.id] }),
    index('terminal_snapshots_terminal_idx').on(t.tenantId, t.terminalId, t.asOf.desc()),
  ],
);

/**
 * Every offline transaction a terminal delivered (ADR-0015 §5): the dedupe key for sync retries and
 * the quarantine for sales that could not be recorded. RECORDED and DISMISSED are final.
 */
export const terminalTransactions = pgTable(
  'terminal_transactions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    terminalTxnId: uuid('terminal_txn_id').notNull(),
    deviceSeq: bigint('device_seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull().default('SALE'),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    cashierSessionId: uuid('cashier_session_id'),
    status: text('status').notNull(),
    saleId: uuid('sale_id'),
    errorCode: text('error_code'),
    errorDetail: jsonb('error_detail'),
    attempts: integer('attempts').notNull().default(1),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    resolveReason: text('resolve_reason'),
  },
  (t) => [
    unique('terminal_transactions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('terminal_transactions_txn_unique').on(t.tenantId, t.terminalId, t.terminalTxnId),
    foreignKey({ columns: [t.tenantId, t.terminalId], foreignColumns: [terminals.tenantId, terminals.id] }),
    foreignKey({ columns: [t.tenantId, t.saleId], foreignColumns: [sales.tenantId, sales.id] }),
    foreignKey({ columns: [t.tenantId, t.cashierSessionId], foreignColumns: [cashierSessions.tenantId, cashierSessions.id] }),
    index('terminal_transactions_status_idx').on(t.tenantId, t.status, t.receivedAt),
    index('terminal_transactions_session_idx').on(t.tenantId, t.cashierSessionId),
    // Monitoring (ADR-0016): offline sales waiting for a manager, across tenants.
    index('terminal_transactions_quarantined_idx').on(t.receivedAt).where(sql`${t.status} = 'QUARANTINED'`),
    check('terminal_transactions_kind_check', sql`${t.kind} IN ('SALE')`),
    check('terminal_transactions_status_check', sql`${t.status} IN ('RECORDED','QUARANTINED','DISMISSED')`),
    check('terminal_transactions_recorded_has_sale', sql`(${t.status} = 'RECORDED') = (${t.saleId} IS NOT NULL)`),
    check('terminal_transactions_quarantine_has_code', sql`${t.status} <> 'QUARANTINED' OR ${t.errorCode} IS NOT NULL`),
    check('terminal_transactions_seq_positive', sql`${t.deviceSeq} > 0`),
  ],
);
