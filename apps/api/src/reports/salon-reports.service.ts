import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { AuthContext } from '../auth/auth-context.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { money, ReportsService, type ReportRange, type Row } from './reports.service.js';

const ZERO = toDec('0');
const dec = (v: unknown) => toDec(String((v as string | number | null) ?? '0'));

/**
 * Salon reports (ADR-0022): commissions per staff member, service packages (sold, used, owed) and tips
 * per staff member. Read-only over the evidence; sales count when completed, returns when processed,
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
                                WHERE e.kind = 'RESTORED' AND e.sale_return_id = r.id AND e.customer_package_id = l.customer_package_id), 0))
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
}
