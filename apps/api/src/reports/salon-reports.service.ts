import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@1pos/database';
import { toDec, type Dec } from '@1pos/money';
import type { AuthContext } from '../auth/auth-context.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { movementAt, movementSaleJoin } from './movement-time.js';
import { money, ReportsService, type ReportRange, type Row } from './reports.service.js';

const ZERO = toDec('0');
const dec = (v: unknown) => toDec(String((v as string | number | null) ?? '0'));
/** a / b as a percentage with one decimal, or null when b is zero. */
const pct = (a: Dec, b: Dec) => (b.isZero() ? null : a.div(b).times(100).toFixed(1));

/**
 * Salon reports (ADR-0022): commissions per staff member, service packages (sold, used, owed), tips
 * (taken, given back, paid out; per staff member) and supplies used against recipes. Read-only over the evidence; sales count when completed, returns when processed,
 * in the branch's local days.
 */
@Injectable()
export class SalonReportsService extends ReportsService {
  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /**
   * Commission per staff member: rate (kept on the line at the sale) × the line's ex-VAT sales, or a
   * package session's value; returns take back their share. Each line's commission is rounded to the
   * centavo, then added up.
   */
  commissions(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH facts AS (
          SELECT l.service_staff_id AS staff_id, l.commission_rate AS rate, 1 AS lines,
                 l.vatable_sales + l.vat_exempt_sales + l.zero_rated_sales + l.percentage_tax_sales + coalesce(l.package_value, 0) AS base
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE l.service_staff_id IS NOT NULL AND s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
          UNION ALL
          SELECT l.service_staff_id, l.commission_rate, 0,
                 -(rl.vatable_sales + rl.vat_exempt_sales + rl.zero_rated_sales + rl.percentage_tax_sales
                   + coalesce((SELECT sum(e.value) FROM customer_package_entries e
                                WHERE e.kind = 'RESTORED' AND e.sale_return_id = r.id
                                  AND (e.sale_line_id = l.id
                                       -- entries written before RESTORED named its line: the item the line used
                                       OR (e.sale_line_id IS NULL AND e.customer_package_item_id = (
                                             SELECT u.customer_package_item_id FROM customer_package_entries u WHERE u.kind = 'REDEEMED' AND u.sale_line_id = l.id)))), 0))
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
           WHERE l.service_staff_id IS NOT NULL AND r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end})
        SELECT f.staff_id, st.display_name AS name, sum(f.lines)::int AS lines,
               sum(f.base) FILTER (WHERE f.base >= 0)::text AS sales, (-coalesce(sum(f.base) FILTER (WHERE f.base < 0), 0))::text AS returns,
               sum(f.base)::text AS base, sum(round(f.base * f.rate, 2))::text AS commission
          FROM facts f JOIN service_staff st ON st.id = f.staff_id
         GROUP BY 1, 2 ORDER BY 2`);
      const staff = rows.map((r) => ({
        staffId: r.staff_id as string,
        name: r.name as string,
        lines: r.lines as number,
        sales: money(r.sales as string | null),
        returns: money(r.returns as string),
        netBase: money(r.base as string),
        commission: money(r.commission as string),
      }));
      const total = (k: 'sales' | 'returns' | 'netBase' | 'commission') => staff.reduce((a, s) => a.plus(s[k]), ZERO).toFixed(2);
      return {
        staff,
        totals: { lines: staff.reduce((a, s) => a + s.lines, 0), sales: total('sales'), returns: total('returns'), netBase: total('netBase'), commission: total('commission') },
      };
    });
  }

  /**
   * Service packages (ADR-0022 §6) at the branch in the period: value sold, used (turned into sales),
   * given back; and, for the branch's legal entity at the end of the period, what is still owed (Σ
   * entries) beside the Prepaid service packages account, with the open packages.
   */
  packages(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows: [moves] } = await db.execute<Row>(sql`
        SELECT coalesce(sum(e.value) FILTER (WHERE e.kind = 'SOLD'), 0)::text AS sold,
               coalesce(-sum(e.value) FILTER (WHERE e.kind = 'REDEEMED'), 0)::text AS used,
               coalesce(-sum(e.value) FILTER (WHERE e.kind = 'REFUNDED'), 0)::text AS refunded,
               coalesce(sum(e.value) FILTER (WHERE e.kind = 'RESTORED'), 0)::text AS restored,
               coalesce(sum(e.sessions) FILTER (WHERE e.kind = 'SOLD'), 0)::int AS sessions_sold,
               coalesce(-sum(e.sessions) FILTER (WHERE e.kind = 'REDEEMED'), 0)::int AS sessions_used,
               count(DISTINCT e.customer_package_id) FILTER (WHERE e.kind = 'SOLD')::int AS packages_sold
          FROM customer_package_entries e
          LEFT JOIN sales s ON s.id = e.sale_id LEFT JOIN sale_returns r ON r.id = e.sale_return_id
         WHERE (s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end})
            OR (r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end})`);
      const { rows: [owed] } = await db.execute<Row>(sql`
        WITH entity AS (SELECT legal_entity_id AS id FROM branches WHERE id = ${w.branchId})
        SELECT (SELECT coalesce(sum(e.value), 0) FROM customer_package_entries e JOIN customer_packages p ON p.id = e.customer_package_id
                 WHERE p.legal_entity_id = (SELECT id FROM entity) AND e.created_at < ${w.end})::text AS owed,
               (SELECT coalesce(sum(jl.credit - jl.debit), 0) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.journal_entry_id
                 WHERE a.system_key = 'PREPAID_SERVICES' AND a.legal_entity_id = (SELECT id FROM entity) AND je.created_at < ${w.end})::text AS ledger`);
      const { rows: open } = await db.execute<Row>(sql`
        SELECT p.id, p.name, p.expires_on::text, c.display_name AS customer, p.customer_id,
               sum(e.sessions)::int AS sessions_left, sum(e.value)::text AS value_left
          FROM customer_packages p JOIN customers c ON c.id = p.customer_id JOIN customer_package_entries e ON e.customer_package_id = p.id
         WHERE p.legal_entity_id = (SELECT legal_entity_id FROM branches WHERE id = ${w.branchId}) AND e.created_at < ${w.end}
         GROUP BY 1, 2, 3, 4, 5 HAVING sum(e.sessions) > 0 ORDER BY p.expires_on NULLS LAST, 4`);
      return {
        sold: money(moves!.sold as string),
        used: money(moves!.used as string),
        refunded: money(moves!.refunded as string),
        restored: money(moves!.restored as string),
        packagesSold: moves!.packages_sold as number,
        sessionsSold: moves!.sessions_sold as number,
        sessionsUsed: moves!.sessions_used as number,
        owed: money(owed!.owed as string),
        ledger: money(owed!.ledger as string),
        open: open.map((o) => ({
          id: o.id, name: o.name, customerId: o.customer_id, customer: o.customer, expiresOn: o.expires_on,
          sessionsLeft: o.sessions_left as number, valueLeft: money(o.value_left as string),
        })),
      };
    });
  }

  /**
   * Tips per staff member (ADR-0022 §7): their shares of the tips on sales in the period, less the
   * shares of tips given back by a void. Tips with no staff are listed as unassigned.
   */
  tipsByStaff(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH tips AS (
          SELECT t.id, t.amount, EXISTS (SELECT 1 FROM sale_returns r WHERE r.sale_id = s.id AND r.kind = 'VOID') AS voided
            FROM sale_tips t JOIN sales s ON s.id = t.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end})
        SELECT sh.staff_id, st.display_name AS name, count(*)::int AS tips,
               sum(sh.amount) FILTER (WHERE NOT t.voided)::text AS amount, coalesce(sum(sh.amount) FILTER (WHERE t.voided), 0)::text AS voided
          FROM tips t JOIN sale_tip_shares sh ON sh.sale_tip_id = t.id JOIN service_staff st ON st.id = sh.staff_id
         GROUP BY 1, 2
        UNION ALL
        SELECT NULL, NULL, count(*)::int, sum(t.amount) FILTER (WHERE NOT t.voided)::text, coalesce(sum(t.amount) FILTER (WHERE t.voided), 0)::text
          FROM tips t WHERE NOT EXISTS (SELECT 1 FROM sale_tip_shares sh WHERE sh.sale_tip_id = t.id)
        HAVING count(*) > 0
        ORDER BY 2 NULLS LAST`);
      const staff = rows.map((r) => ({
        staffId: r.staff_id as string | null,
        name: r.name as string | null,
        tips: r.tips as number,
        amount: money(r.amount as string | null),
        voided: money(r.voided as string),
      }));
      return { staff, total: staff.reduce((a, s) => a.plus(dec(s.amount)), ZERO).toFixed(2) };
    });
  }

  /**
   * Theoretical vs actual supply use, per supply (any item used in a recipe, ADR-0022 §9), in quantity and value:
   * - expected = recipe consumption at checkout + the supply sold as itself (net of restocked returns);
   * - recorded waste = WASTE adjustments;
   * - count variance = what counts found against the books (negative = short);
   * - actual = expected + waste − count variance; variance = actual − expected.
   * Manual adjustments, receipts and transfers are stock coming in or corrections, not use.
   */
  ingredientUsage(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH ingredients AS (SELECT DISTINCT ingredient_variant_id AS variant_id FROM recipe_ingredients),
        m AS (
          SELECT m.variant_id, m.quantity, m.value,
                 CASE WHEN m.type = 'CONSUMPTION' THEN 'recipe'
                      WHEN m.type IN ('SALE', 'RETURN') THEN 'sold'
                      WHEN m.type = 'WASTE' THEN 'waste'
                      ELSE 'count' END AS kind
            FROM stock_movements m ${movementSaleJoin}
           WHERE m.branch_id = ${w.branchId} AND m.created_at >= ${w.start} AND ${movementAt} >= ${w.start} AND ${movementAt} < ${w.end}
             AND m.type IN ('CONSUMPTION', 'SALE', 'RETURN', 'WASTE', 'COUNT')
             AND (m.type = 'CONSUMPTION' OR m.variant_id IN (SELECT variant_id FROM ingredients)))
        SELECT m.variant_id, v.sku, p.name, u.code AS unit, m.kind, sum(m.quantity)::text AS qty, sum(m.value)::text AS value
          FROM m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id JOIN units_of_measure u ON u.id = p.uom_id
         GROUP BY 1, 2, 3, 4, 5 ORDER BY v.sku`);

      const byIngredient = new Map<string, Row[]>();
      for (const r of rows) byIngredient.set(r.variant_id as string, [...(byIngredient.get(r.variant_id as string) ?? []), r]);
      const total = { expected: ZERO, waste: ZERO, countVariance: ZERO, actual: ZERO, variance: ZERO };
      const data = [...byIngredient.values()].map((group) => {
        // Outbound movements are negative: use = −Σ (as 0 − Σ, so nothing prints "-0.00"); the count variance keeps its sign.
        const of = (kind: string, col: 'qty' | 'value', keepSign = false) => {
          const x = dec(group.find((r) => r.kind === kind)?.[col]);
          return keepSign ? x : ZERO.minus(x);
        };
        const side = (col: 'qty' | 'value') => {
          const recipe = of('recipe', col);
          const sold = of('sold', col);
          const waste = of('waste', col);
          const countVariance = of('count', col, true);
          const expected = recipe.plus(sold);
          const actual = expected.plus(waste).minus(countVariance);
          return { recipe, sold, expected, waste, countVariance, actual, variance: actual.minus(expected) };
        };
        const q = side('qty');
        const v = side('value');
        total.expected = total.expected.plus(v.expected);
        total.waste = total.waste.plus(v.waste);
        total.countVariance = total.countVariance.plus(v.countVariance);
        total.actual = total.actual.plus(v.actual);
        total.variance = total.variance.plus(v.variance);
        return {
          variantId: group[0]!.variant_id,
          sku: group[0]!.sku,
          name: group[0]!.name,
          unit: group[0]!.unit,
          quantity: Object.fromEntries(Object.entries(q).map(([k, x]) => [k, x.toString()])),
          value: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.toFixed(2)])),
          variancePct: pct(q.variance, q.expected),
        };
      });
      return {
        data,
        totals: {
          expectedValue: total.expected.toFixed(2),
          wasteValue: total.waste.toFixed(2),
          countVarianceValue: total.countVariance.toFixed(2),
          actualValue: total.actual.toFixed(2),
          varianceValue: total.variance.toFixed(2),
        },
      };
    });
  }

  /**
   * Tips (session 25): taken with sales (cash or card/QR), given back by voids, and paid out to staff
   * from the drawers, per local day, with each cashier's share of what was taken. Owed = taken − given
   * back − paid out; `ledger` is TIPS_PAYABLE's movement from the same documents (sales, voids, payouts).
   */
  tips(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH docs AS (
          SELECT (s.completed_at AT TIME ZONE ${w.tz})::date AS day, s.cashier_user_id AS user_id,
                 CASE WHEN t.method = 'CASH' THEN t.amount ELSE 0 END AS cash, CASE WHEN t.method = 'CASH' THEN 0 ELSE t.amount END AS electronic,
                 0::numeric AS refunded, 0::numeric AS paid_out, 1 AS tips
            FROM sale_tips t JOIN sales s ON s.id = t.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
          UNION ALL
          SELECT (r.created_at AT TIME ZONE ${w.tz})::date, NULL, 0, 0, r.tip_refund, 0, 0
            FROM sale_returns r WHERE r.tip_refund > 0 AND r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
          UNION ALL
          SELECT (f.created_at AT TIME ZONE ${w.tz})::date, NULL, 0, 0, f.amount, 0, 0
            FROM sale_tip_refunds f JOIN sale_returns r ON r.id = f.sale_return_id
           WHERE r.branch_id = ${w.branchId} AND f.created_at >= ${w.start} AND f.created_at < ${w.end}
          UNION ALL
          SELECT (m.created_at AT TIME ZONE ${w.tz})::date, NULL, 0, 0, 0, -m.amount, 0
            FROM cash_movements m JOIN cashier_sessions cs ON cs.id = m.cashier_session_id
           WHERE m.type = 'TIP_PAYOUT' AND cs.branch_id = ${w.branchId} AND m.created_at >= ${w.start} AND m.created_at < ${w.end})
        SELECT day::text, sum(tips)::int AS tips, sum(cash)::text AS cash, sum(electronic)::text AS electronic, sum(refunded)::text AS refunded, sum(paid_out)::text AS paid_out
          FROM docs GROUP BY 1 ORDER BY 1`);
      const { rows: byCashier } = await db.execute<Row>(sql`
        SELECT s.cashier_user_id AS user_id, u.display_name AS name, count(*)::int AS tips, sum(t.amount)::text AS amount
          FROM sale_tips t JOIN sales s ON s.id = t.sale_id JOIN users u ON u.id = s.cashier_user_id
         WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
         GROUP BY 1, 2 ORDER BY sum(t.amount) DESC, 2`);
      const { rows: [ledger] } = await db.execute<Row>(sql`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS net
          FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.journal_entry_id
         WHERE a.system_key = 'TIPS_PAYABLE' AND e.source_id IN (
           SELECT id FROM sales WHERE branch_id = ${w.branchId} AND completed_at >= ${w.start} AND completed_at < ${w.end}
           UNION ALL
           SELECT id FROM sale_returns WHERE branch_id = ${w.branchId} AND created_at >= ${w.start} AND created_at < ${w.end}
           UNION ALL
           SELECT f.id FROM sale_tip_refunds f JOIN sale_returns r ON r.id = f.sale_return_id WHERE r.branch_id = ${w.branchId} AND f.created_at >= ${w.start} AND f.created_at < ${w.end}
           UNION ALL
           SELECT m.id FROM cash_movements m JOIN cashier_sessions cs ON cs.id = m.cashier_session_id
            WHERE m.type = 'TIP_PAYOUT' AND cs.branch_id = ${w.branchId} AND m.created_at >= ${w.start} AND m.created_at < ${w.end})`);
      const day = (r: Row) => {
        const taken = dec(r.cash).plus(dec(r.electronic));
        return {
          tips: r.tips as number,
          cash: money(r.cash as string),
          electronic: money(r.electronic as string),
          taken: taken.toFixed(2),
          refunded: money(r.refunded as string),
          paidOut: money(r.paid_out as string),
          owed: taken.minus(dec(r.refunded)).minus(dec(r.paid_out)).toFixed(2),
        };
      };
      const cols = ['cash', 'electronic', 'refunded', 'paid_out'];
      const total: Row = { tips: rows.reduce((a, r) => a + (r.tips as number), 0), ...Object.fromEntries(cols.map((c) => [c, rows.reduce((a, r) => a.plus(dec(r[c])), ZERO).toString()])) };
      return {
        days: rows.map((r) => ({ day: r.day, ...day(r) })),
        byCashier: byCashier.map((c) => ({ userId: c.user_id, name: c.name, tips: c.tips, amount: money(c.amount as string) })),
        totals: day(total),
        ledger: money(ledger!.net as string),
      };
    });
  }
}
