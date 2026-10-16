import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, eq, sql, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { expectedCash, loadSession } from '../sales/cash.service.js';

export interface ReportRange {
  branchId: string;
  /** Inclusive local dates (YYYY-MM-DD) in the branch's timezone. */
  from: string;
  to: string;
}

const BUCKETS = [
  'gross', 'discount', 'statutory_discount', 'vat_exemption_amount', 'vatable_sales', 'vat_amount',
  'vat_exempt_sales', 'zero_rated_sales', 'percentage_tax_sales', 'amount_due',
] as const;
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const money = (v: string | null | undefined) => toDec(v ?? '0').toFixed(2);
const qty = (v: string | null | undefined) => toDec(v ?? '0').toString();

type Row = Record<string, string | number | null>;

/** Money columns to 2-dp strings, keys to camelCase. */
function shape(r: Row, moneyCols: readonly string[] = BUCKETS) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) o[camel(k)] = moneyCols.includes(k) ? money(v as string) : v;
  return o;
}

/**
 * Read-only reports over the evidence tables (sales, returns, tenders, cash and stock ledgers).
 * Sales are counted when completed and returns when processed, both in the branch's local days;
 * "net" = sales − returns. Every figure is reproducible from source rows (tests assert it).
 */
@Injectable()
export class ReportsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  salesSummary(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const sum = (alias: string) => sql.raw(BUCKETS.map((b) => `coalesce(sum(${alias}.${b}), 0)::text AS ${b}`).join(', '));
      const { rows: sales } = await db.execute<Row>(sql`
        SELECT (s.completed_at AT TIME ZONE ${w.tz})::date::text AS day, count(*)::int AS count, ${sum('s')}
          FROM sales s WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
         GROUP BY 1 ORDER BY 1`);
      const { rows: returns } = await db.execute<Row>(sql`
        SELECT (r.created_at AT TIME ZONE ${w.tz})::date::text AS day, count(*)::int AS count,
               count(*) FILTER (WHERE r.kind = 'VOID')::int AS voids, ${sum('r')}
          FROM sale_returns r WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
         GROUP BY 1 ORDER BY 1`);
      const days = [...new Set([...sales.map((r) => r.day as string), ...returns.map((r) => r.day as string)])].sort();
      const net = (s?: Row, r?: Row) =>
        Object.fromEntries(BUCKETS.map((b) => [camel(b), toDec((s?.[b] as string) ?? '0').minus((r?.[b] as string) ?? '0').toFixed(2)]));
      const total = (rows: Row[]) =>
        Object.fromEntries(BUCKETS.map((b) => [b, rows.reduce((a, x) => a.plus((x[b] as string) ?? '0'), toDec('0')).toString()])) as Row;
      const ts = total(sales);
      const tr = total(returns);
      return {
        days: days.map((day) => {
          const s = sales.find((x) => x.day === day);
          const r = returns.find((x) => x.day === day);
          return {
            day,
            salesCount: s?.count ?? 0,
            returnsCount: r?.count ?? 0,
            voidsCount: r?.voids ?? 0,
            sales: shape(Object.fromEntries(BUCKETS.map((b) => [b, (s?.[b] as string) ?? '0']))),
            returns: shape(Object.fromEntries(BUCKETS.map((b) => [b, (r?.[b] as string) ?? '0']))),
            net: net(s, r),
          };
        }),
        totals: {
          salesCount: sales.reduce((a, x) => a + (x.count as number), 0),
          returnsCount: returns.reduce((a, x) => a + (x.count as number), 0),
          sales: shape(ts),
          returns: shape(tr),
          net: net(ts, tr),
        },
      };
    });
  }

  byProduct(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      // Revenue excludes VAT (output tax is owed, not earned); COGS = value that left stock on sales,
      // less what returns brought back (ADR-0012), from the ledger movements written with them.
      const { rows } = await db.execute<Row>(sql`
        WITH sold AS (
          SELECT l.variant_id, sum(l.quantity) AS qty, sum(l.amount_due) AS amount, sum(l.amount_due - l.vat_amount) AS revenue
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
           GROUP BY 1),
        back AS (
          SELECT l.variant_id, sum(rl.quantity) AS qty, sum(rl.amount_due) AS amount, sum(rl.amount_due - rl.vat_amount) AS revenue
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
           GROUP BY 1),
        cost AS (
          SELECT variant_id, -sum(value) AS cogs FROM stock_movements
           WHERE branch_id = ${w.branchId} AND type IN ('SALE', 'RETURN') AND created_at >= ${w.start} AND created_at < ${w.end}
           GROUP BY 1)
        SELECT v.id AS variant_id, v.sku, p.name,
               coalesce(sold.qty, 0)::text AS quantity_sold, coalesce(back.qty, 0)::text AS quantity_returned,
               (coalesce(sold.qty, 0) - coalesce(back.qty, 0))::text AS net_quantity,
               coalesce(sold.amount, 0)::text AS sales, coalesce(back.amount, 0)::text AS returns,
               (coalesce(sold.amount, 0) - coalesce(back.amount, 0))::text AS net_sales,
               (coalesce(sold.revenue, 0) - coalesce(back.revenue, 0))::text AS revenue_ex_vat,
               coalesce(cost.cogs, 0)::text AS cogs,
               (coalesce(sold.revenue, 0) - coalesce(back.revenue, 0) - coalesce(cost.cogs, 0))::text AS gross_profit
          FROM product_variants v JOIN products p ON p.id = v.product_id
          LEFT JOIN sold ON sold.variant_id = v.id LEFT JOIN back ON back.variant_id = v.id LEFT JOIN cost ON cost.variant_id = v.id
         WHERE sold.variant_id IS NOT NULL OR back.variant_id IS NOT NULL
         ORDER BY net_sales DESC, v.sku`);
      return {
        data: rows.map((r) => ({
          ...shape(r, ['sales', 'returns', 'net_sales', 'revenue_ex_vat', 'cogs', 'gross_profit']),
          quantitySold: qty(r.quantity_sold as string),
          quantityReturned: qty(r.quantity_returned as string),
          netQuantity: qty(r.net_quantity as string),
        })),
      };
    });
  }

  byCashier(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH s AS (SELECT cashier_user_id AS user_id, count(*) AS n, sum(amount_due) AS amount FROM sales
                    WHERE branch_id = ${w.branchId} AND completed_at >= ${w.start} AND completed_at < ${w.end} GROUP BY 1),
             r AS (SELECT processed_by AS user_id, count(*) AS n, sum(amount_due) AS amount FROM sale_returns
                    WHERE branch_id = ${w.branchId} AND created_at >= ${w.start} AND created_at < ${w.end} GROUP BY 1)
        SELECT u.id AS user_id, u.display_name, coalesce(s.n, 0)::int AS sales_count, coalesce(s.amount, 0)::text AS sales,
               coalesce(r.n, 0)::int AS returns_processed, coalesce(r.amount, 0)::text AS returns
          FROM users u LEFT JOIN s ON s.user_id = u.id LEFT JOIN r ON r.user_id = u.id
         WHERE s.user_id IS NOT NULL OR r.user_id IS NOT NULL
         ORDER BY u.display_name`);
      return { data: rows.map((r) => shape(r, ['sales', 'returns'])) };
    });
  }

  byTender(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH t AS (SELECT t.method, count(*) AS n, sum(t.amount) AS amount FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
                    WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} GROUP BY 1),
             r AS (SELECT refund_method AS method, count(*) AS n, sum(amount_due) AS amount FROM sale_returns
                    WHERE branch_id = ${w.branchId} AND created_at >= ${w.start} AND created_at < ${w.end} GROUP BY 1)
        SELECT coalesce(t.method, r.method) AS method, coalesce(t.n, 0)::int AS tenders, coalesce(t.amount, 0)::text AS collected,
               coalesce(r.n, 0)::int AS refunds_count, coalesce(r.amount, 0)::text AS refunded,
               (coalesce(t.amount, 0) - coalesce(r.amount, 0))::text AS net
          FROM t FULL JOIN r ON r.method = t.method ORDER BY 1`);
      return { data: rows.map((r) => shape(r, ['collected', 'refunded', 'net'])) };
    });
  }

  /** VAT buckets net of returns, split by the VAT rate actually used (from each sale's snapshot). */
  taxSummary(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const cols = sql.raw(BUCKETS.filter((b) => b !== 'gross' && b !== 'discount').map((b) => `sum(${b})::text AS ${b}`).join(', '));
      const { rows } = await db.execute<Row>(sql`
        WITH docs AS (
          SELECT s.tax_snapshot->>'vatStatus' AS vat_status, s.tax_snapshot->>'vatRate' AS vat_rate, 1 AS sign,
                 s.statutory_discount, s.vat_exemption_amount, s.vatable_sales, s.vat_amount, s.vat_exempt_sales, s.zero_rated_sales, s.percentage_tax_sales, s.amount_due
            FROM sales s WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
          UNION ALL
          SELECT s.tax_snapshot->>'vatStatus', s.tax_snapshot->>'vatRate', -1,
                 -r.statutory_discount, -r.vat_exemption_amount, -r.vatable_sales, -r.vat_amount, -r.vat_exempt_sales, -r.zero_rated_sales, -r.percentage_tax_sales, -r.amount_due
            FROM sale_returns r JOIN sales s ON s.id = r.sale_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end})
        SELECT vat_status, vat_rate, ${cols} FROM docs GROUP BY 1, 2 ORDER BY 1, 2`);
      return { data: rows.map((r) => ({ ...shape(r), vatRate: toDec((r.vat_rate as string) ?? '0').toString() })) };
    });
  }

  /** SC/PWD sales book (RR 5-2017 §5.9): one row per beneficiary per sale, returns as negative rows. */
  statutoryBook(auth: AuthContext, range: ReportRange & { scheme?: string }) {
    return this.run(auth, range, async (db, w) => {
      const scheme = range.scheme ? sql`AND b.scheme_code = ${range.scheme}` : sql``;
      const { rows } = await db.execute<Row>(sql`
        SELECT 'SALE' AS document, s.completed_at, (s.completed_at AT TIME ZONE ${w.tz})::date::text AS day, s.sale_number::int AS number, reg.code AS register,
               b.scheme_code, b.name, b.id_number, b.tin,
               sum(l.vat_exempt_sales + l.zero_rated_sales + l.percentage_tax_sales)::text AS sales,
               sum(l.statutory_discount)::text AS discount, sum(l.amount_due)::text AS net
          FROM sale_beneficiaries b JOIN sales s ON s.id = b.sale_id JOIN sale_lines l ON l.beneficiary_id = b.id
          JOIN registers reg ON reg.id = s.register_id
         WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} ${scheme}
         GROUP BY s.id, s.completed_at, s.sale_number, reg.code, b.id
        UNION ALL
        SELECT 'RETURN', r.created_at, (r.created_at AT TIME ZONE ${w.tz})::date::text, r.return_number::int, reg.code,
               b.scheme_code, b.name, b.id_number, b.tin,
               (-sum(rl.vat_exempt_sales + rl.zero_rated_sales + rl.percentage_tax_sales))::text, (-sum(rl.statutory_discount))::text, (-sum(rl.amount_due))::text
          FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
          JOIN sale_beneficiaries b ON b.id = l.beneficiary_id JOIN registers reg ON reg.id = r.register_id
         WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end} ${scheme}
         GROUP BY r.id, r.created_at, r.return_number, reg.code, b.id
         ORDER BY 2, 1`);
      return { data: rows.map(({ completed_at: _t, ...r }) => shape(r as Row, ['sales', 'discount', 'net'])) };
    });
  }

  /** Stock on hand at cost now, per item, with the ledger total as a check (Σ movement value = Σ balance value). */
  inventoryValuation(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw notFound('Branch');
      this.assertCan(auth, 'reports.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      const { rows } = await db.execute<Row>(sql`
        SELECT b.variant_id, v.sku, p.name, b.quantity::text AS quantity, b.avg_cost::text AS avg_cost, b.value::text AS value
          FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
         WHERE b.branch_id = ${branch.id} AND (b.quantity <> 0 OR b.value <> 0)
         ORDER BY b.value DESC, v.sku`);
      const { rows: [ledger] } = await db.execute<Row>(sql`SELECT coalesce(sum(value), 0)::text AS value FROM stock_movements WHERE branch_id = ${branch.id}`);
      const total = rows.reduce((a, r) => a.plus(r.value as string), toDec('0'));
      return {
        branchId: branch.id,
        data: rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, name: r.name, quantity: qty(r.quantity as string), avgCost: toDec(r.avg_cost as string).toFixed(4), value: money(r.value as string) })),
        totalValue: total.toFixed(2),
        ledgerValue: money(ledger!.value as string),
      };
    });
  }

  /** Per item: opening + movements by type in the range = closing, in quantity and value. */
  stockMovements(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT m.variant_id, v.sku, p.name,
               coalesce(sum(m.quantity) FILTER (WHERE m.created_at < ${w.start}), 0)::text AS opening_qty,
               coalesce(sum(m.value) FILTER (WHERE m.created_at < ${w.start}), 0)::text AS opening_value,
               coalesce(sum(m.quantity) FILTER (WHERE m.created_at < ${w.end}), 0)::text AS closing_qty,
               coalesce(sum(m.value) FILTER (WHERE m.created_at < ${w.end}), 0)::text AS closing_value
          FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
         WHERE m.branch_id = ${w.branchId} AND m.created_at < ${w.end}
         GROUP BY 1, 2, 3 ORDER BY v.sku`);
      const { rows: byType } = await db.execute<Row>(sql`
        SELECT variant_id, type, sum(quantity)::text AS qty, sum(value)::text AS value FROM stock_movements
         WHERE branch_id = ${w.branchId} AND created_at >= ${w.start} AND created_at < ${w.end} GROUP BY 1, 2`);
      return {
        data: rows.map((r) => ({
          variantId: r.variant_id,
          sku: r.sku,
          name: r.name,
          opening: { quantity: qty(r.opening_qty as string), value: money(r.opening_value as string) },
          movements: Object.fromEntries(
            byType.filter((t) => t.variant_id === r.variant_id).map((t) => [t.type as string, { quantity: qty(t.qty as string), value: money(t.value as string) }]),
          ),
          closing: { quantity: qty(r.closing_qty as string), value: money(r.closing_value as string) },
        })),
      };
    });
  }

  /** Session report (X-reading style): drawer, sales, tenders, refunds and the count. */
  session(auth: AuthContext, sessionId: string) {
    return this.read(auth, async (db) => {
      const { session, scope } = await loadSession(db, sessionId);
      if (session.openedBy !== auth.userId) this.assertCan(auth, 'reports.read', scope);
      const { rows: [sales] } = await db.execute<Row>(sql`
        SELECT count(*)::int AS count, coalesce(sum(amount_due), 0)::text AS amount_due, coalesce(sum(statutory_discount), 0)::text AS statutory_discount,
               coalesce(sum(vat_amount), 0)::text AS vat_amount, min(sale_number)::int AS first_number, max(sale_number)::int AS last_number
          FROM sales WHERE cashier_session_id = ${sessionId}`);
      const { rows: tenders } = await db.execute<Row>(sql`
        SELECT t.method, count(*)::int AS count, sum(t.amount)::text AS amount FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
         WHERE s.cashier_session_id = ${sessionId} GROUP BY 1 ORDER BY 1`);
      const { rows: returns } = await db.execute<Row>(sql`
        SELECT kind, count(*)::int AS count, sum(amount_due)::text AS amount FROM sale_returns WHERE cashier_session_id = ${sessionId} GROUP BY 1 ORDER BY 1`);
      const { rows: drawer } = await db.execute<Row>(sql`
        SELECT type, count(*)::int AS count, sum(amount)::text AS amount FROM cash_movements WHERE cashier_session_id = ${sessionId} GROUP BY 1 ORDER BY 1`);
      const { rows: [rec] } = await db.execute<Row>(sql`SELECT counted_cash::text, variance::text, approved_at FROM cash_reconciliations WHERE cashier_session_id = ${sessionId}`);
      return {
        session: { id: session.id, registerId: session.registerId, status: session.status, openedAt: session.openedAt, closedAt: session.closedAt, openingFloat: money(session.openingFloat) },
        sales: shape(sales!, ['amount_due', 'statutory_discount', 'vat_amount']),
        tenders: tenders.map((t) => shape(t, ['amount'])),
        returns: returns.map((r) => shape(r, ['amount'])),
        drawer: drawer.map((d) => shape(d, ['amount'])),
        expectedCash: money(await expectedCash(db, sessionId)),
        count: rec ? { countedCash: money(rec.counted_cash as string), variance: money(rec.variance as string), approved: rec.approved_at !== null } : null,
      };
    });
  }

  /** Resolve the branch (404 across tenants), check scope and turn local dates into an instant range. */
  private run<T>(auth: AuthContext, range: ReportRange, fn: (db: Database, w: { branchId: string; tz: string; start: string; end: string }) => Promise<T>) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, range.branchId));
      if (!branch) throw notFound('Branch');
      this.assertCan(auth, 'reports.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      if (range.from > range.to) throw new AppError('VALIDATION_FAILED', '"from" must not be after "to"', HttpStatus.BAD_REQUEST);
      const { rows } = await db.execute<{ start: string; end: string }>(sql`
        SELECT (${range.from}::date::timestamp AT TIME ZONE ${branch.timezone})::text AS start,
               ((${range.to}::date + 1)::timestamp AT TIME ZONE ${branch.timezone})::text AS end`);
      const result = await fn(db, { branchId: branch.id, tz: branch.timezone, start: rows[0]!.start, end: rows[0]!.end });
      return { branchId: branch.id, timezone: branch.timezone, from: range.from, to: range.to, ...result };
    });
  }
}
