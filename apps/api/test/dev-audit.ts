/**
 * The traceability audit (Phase 3 exit criterion) over a whole database, for exit reviews against the
 * dev database after migrating. Connects as a role that bypasses RLS (the compose superuser), so the
 * checks run across every tenant at once; documents are joined by uuid, so tenants never mix.
 *
 *   AUDIT_DATABASE_URL=postgres://onepos_owner:<password>@127.0.0.1:55460/onepos \
 *     pnpm --filter @1pos/api exec tsx test/dev-audit.ts
 *
 * Sales, returns and drawer variances recorded before the first journal entry anywhere have no entry
 * by design (migration 0028 does not post history; ADR-0013): they are counted as "before the ledger"
 * and do not fail the audit. Anything else is a violation (exit code 1).
 */
import pg from 'pg';
import { traceabilityAudit } from './integration/traceability-audit.js';

const url = process.env.AUDIT_DATABASE_URL;
if (!url) throw new Error('Set AUDIT_DATABASE_URL to a role that bypasses RLS');
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const { rows: [who] } = await c.query(`SELECT rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = current_user`);
  if (!who?.bypass) throw new Error('This role is subject to RLS and would see no tenant rows; use the compose superuser');

  const { rows: [ledger] } = await c.query(`SELECT min(created_at) AS start FROM journal_entries`);
  const { rows: [counts] } = await c.query(`
    SELECT (SELECT count(*) FROM tenants)::int AS tenants, (SELECT count(*) FROM sales)::int AS sales,
           (SELECT count(*) FROM order_bills)::int AS bills, (SELECT count(*) FROM stock_movements)::int AS movements,
           (SELECT count(*) FROM journal_entries)::int AS entries,
           (SELECT count(*) FROM drizzle.__drizzle_migrations)::int AS migrations`);
  const when: Record<string, string> = {
    SALE: 'SELECT completed_at AS at FROM sales WHERE id = $1',
    SALE_RETURN: 'SELECT created_at AS at FROM sale_returns WHERE id = $1',
    CASH_VARIANCE: 'SELECT counted_at AS at FROM cash_reconciliations WHERE cashier_session_id = $1',
    CASH_MOVEMENT: 'SELECT created_at AS at FROM cash_movements WHERE id = $1',
  };

  const result = await traceabilityAudit(c);
  const violations: Record<string, unknown[]> = {};
  const beforeLedger: Record<string, number> = {};
  for (const [check, rows] of Object.entries(result)) {
    for (const row of rows as Record<string, unknown>[]) {
      if (check.startsWith('document that moved value') && Number(row.entries) === 0 && when[row.doc_type as string] && ledger.start) {
        const at = (await c.query(when[row.doc_type as string]!, [row.doc_id])).rows[0]?.at as Date | undefined;
        if (at && at < ledger.start) {
          beforeLedger[row.doc_type as string] = (beforeLedger[row.doc_type as string] ?? 0) + 1;
          continue;
        }
      }
      (violations[check] ??= []).push(row);
    }
  }
  console.log(JSON.stringify({ ...counts, ledgerStart: ledger.start, beforeLedger, violations }, null, 2));
  process.exitCode = Object.keys(violations).length ? 1 : 0;
} finally {
  await c.end();
}
