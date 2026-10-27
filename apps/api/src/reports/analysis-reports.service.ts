import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, categories, eq, sql, type Database } from '@1pos/database';
import { movementAt, movementSaleJoin } from './movement-time.js';
import { Dec, toDec } from '@1pos/money';
import type { ConsolidatedRangeQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { assertFeature } from '../billing/entitlements.js';
import { notFound } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { money, qty, ReportsService, shape, type ReportRange, type Row } from './reports.service.js';

const FIGURES = ['sales', 'returns', 'net_sales', 'revenue_ex_vat', 'cogs', 'gross_profit'] as const;
/** A shaped report row's net sales (shape() types its figures loosely). */
const netSales = (x: object) => (x as Record<string, string>).netSales ?? '0';
const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a.plus((r[k] as string) ?? '0'), new Dec(0));

/**
 * Reports the audit found missing (session 20, SPEC §6.10): sales by category and by branch
 * (consolidated), discounts and price changes, purchases by supplier, and card/QR payments that
 * still need someone. Same rules as the other reports: local business days of each branch, sales
 * counted when completed and returns when processed, every figure traceable to its rows.
 *
 * These are the plan's `advanced_reports` (session 21 decision: Growth and Enterprise). The everyday
 * and statutory reports (sales, items, cashiers, tenders, tax, sales book, stock, Z/X) stay on every plan.
 */
@Injectable()
export class AnalysisReportsService extends ReportsService {
  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /** Every analysis report reads through here (directly or via `run`): the plan check comes first. */
  protected override read<T>(auth: AuthContext, fn: (db: Database) => Promise<T>): Promise<T> {
    return super.read(auth, async (db) => {
      await assertFeature(db, 'advanced_reports');
      return fn(db);
    });
  }

  /**
   * Net sales, revenue ex VAT, COGS and gross profit per category, as on the product report. `data`
   * is each category on its own (with its path); `top` rolls every category up to its top-level one.
   * Items without a category are their own row; both lists add up to the product report.
   */
  byCategory(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH sold AS (
          SELECT p.category_id, sum(l.quantity) AS qty, sum(l.amount_due) AS amount, sum(l.amount_due - l.vat_amount) AS revenue
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
           GROUP BY 1),
        back AS (
          SELECT p.category_id, sum(rl.quantity) AS qty, sum(rl.amount_due) AS amount, sum(rl.amount_due - rl.vat_amount) AS revenue
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
            JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
           GROUP BY 1),
        cost AS (
          SELECT p.category_id, -sum(m.value) AS cogs
            FROM stock_movements m LEFT JOIN sale_lines l ON m.type = 'CONSUMPTION' AND l.id = m.sale_line_id ${movementSaleJoin}
            JOIN product_variants v ON v.id = coalesce(l.variant_id, m.variant_id) JOIN products p ON p.id = v.product_id
           WHERE m.branch_id = ${w.branchId} AND m.type IN ('SALE', 'RETURN', 'CONSUMPTION') AND m.created_at >= ${w.start} AND ${movementAt} >= ${w.start} AND ${movementAt} < ${w.end}
           GROUP BY 1),
        cats AS (SELECT category_id FROM sold UNION SELECT category_id FROM back UNION SELECT category_id FROM cost)
        SELECT cats.category_id,
               (coalesce(sold.qty, 0) - coalesce(back.qty, 0))::text AS net_quantity,
               coalesce(sold.amount, 0)::text AS sales, coalesce(back.amount, 0)::text AS returns,
               (coalesce(sold.amount, 0) - coalesce(back.amount, 0))::text AS net_sales,
               (coalesce(sold.revenue, 0) - coalesce(back.revenue, 0))::text AS revenue_ex_vat,
               coalesce(cost.cogs, 0)::text AS cogs,
               (coalesce(sold.revenue, 0) - coalesce(back.revenue, 0) - coalesce(cost.cogs, 0))::text AS gross_profit
          FROM cats
          LEFT JOIN sold ON sold.category_id IS NOT DISTINCT FROM cats.category_id
          LEFT JOIN back ON back.category_id IS NOT DISTINCT FROM cats.category_id
          LEFT JOIN cost ON cost.category_id IS NOT DISTINCT FROM cats.category_id`);
      // Recipe ingredients cost the dish (by-product does the same); a cost row with no sale is a
      // category whose items only cost something here, and still belongs to the totals.
      const tree = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
      const byId = new Map(tree.map((c) => [c.id, c]));
      const chain = (id: string | null) => {
        const out: { id: string; name: string }[] = [];
        for (let c = id ? byId.get(id) : undefined; c && out.length < 6; c = c.parentId ? byId.get(c.parentId) : undefined) out.unshift({ id: c.id, name: c.name });
        return out;
      };
      const data = rows
        .map((r) => {
          const path = chain(r.category_id as string | null);
          return { categoryId: (r.category_id as string | null) ?? null, name: path.at(-1)?.name ?? null, path: path.map((p) => p.name), ...shape(r, FIGURES), netQuantity: qty(r.net_quantity as string) };
        })
        .sort((a, b) => toDec(netSales(b)).cmp(netSales(a)) || (a.path.join('/') < b.path.join('/') ? -1 : 1));
      const tops = new Map<string, { categoryId: string | null; name: string | null; rows: Row[] }>();
      for (const r of rows) {
        const root = chain(r.category_id as string | null)[0] ?? null;
        const key = root?.id ?? '';
        const acc = tops.get(key) ?? { categoryId: root?.id ?? null, name: root?.name ?? null, rows: [] };
        acc.rows.push(r);
        tops.set(key, acc);
      }
      const top = [...tops.values()]
        .map((t) => ({ categoryId: t.categoryId, name: t.name, ...Object.fromEntries(FIGURES.map((k) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), money(sum(t.rows, k).toString())])) }))
        .sort((a, b) => toDec(netSales(b)).cmp(netSales(a)));
      return { data, top, totals: Object.fromEntries(FIGURES.map((k) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), money(sum(rows, k).toString())])) };
    });
  }

  /**
   * Every branch the person may report on, side by side, and the total: sales, returns and net, with
   * VAT and discounts, each branch in its own local days. `legalEntityId` narrows to one company.
   * An archived branch is listed (with `archivedAt`) when it sold or took returns in the range, so the
   * total still adds up to the books for a past period.
   */
  byBranch(auth: AuthContext, q: ConsolidatedRangeQuery) {
    return this.read(auth, async (db) => {
      const all = await db.select().from(branches);
      const mine = all.filter((b) => (!q.legalEntityId || b.legalEntityId === q.legalEntityId) && hasPermission(tenantOf(auth).grants, 'reports.read', { branchId: b.id, legalEntityId: b.legalEntityId }));
      if (!mine.length) throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['reports.read'] });
      const rows: Row[] = [];
      for (const b of mine.sort((x, y) => (x.code < y.code ? -1 : 1))) {
        const { rows: [r] } = await db.execute<Row>(sql`
          WITH w AS (SELECT (${q.from}::date::timestamp AT TIME ZONE ${b.timezone}) AS start, ((${q.to}::date + 1)::timestamp AT TIME ZONE ${b.timezone}) AS fin),
               s AS (SELECT count(*) AS n, coalesce(sum(amount_due), 0) AS amount, coalesce(sum(vat_amount), 0) AS vat,
                            coalesce(sum(discount), 0) AS discount, coalesce(sum(statutory_discount), 0) AS statutory,
                            coalesce(sum(amount_due - vat_amount), 0) AS ex_vat
                       FROM sales, w WHERE branch_id = ${b.id} AND completed_at >= w.start AND completed_at < w.fin),
               r AS (SELECT count(*) AS n, coalesce(sum(amount_due), 0) AS amount, coalesce(sum(vat_amount), 0) AS vat,
                            coalesce(sum(amount_due - vat_amount), 0) AS ex_vat
                       FROM sale_returns, w WHERE branch_id = ${b.id} AND created_at >= w.start AND created_at < w.fin)
          SELECT s.n::int AS sales_count, s.amount::text AS sales, r.n::int AS returns_count, r.amount::text AS returns,
                 (s.amount - r.amount)::text AS net_sales, (s.vat - r.vat)::text AS vat_amount, (s.ex_vat - r.ex_vat)::text AS net_ex_vat,
                 s.discount::text AS discount, s.statutory::text AS statutory_discount
            FROM s, r`);
        if (b.archivedAt && r!.sales_count === 0 && r!.returns_count === 0) continue;
        rows.push({ ...r!, branch_id: b.id, code: b.code, name: b.name, legal_entity_id: b.legalEntityId, timezone: b.timezone, archived_at: b.archivedAt?.toISOString() ?? null });
      }
      const cols = ['sales', 'returns', 'net_sales', 'vat_amount', 'net_ex_vat', 'discount', 'statutory_discount'];
      return {
        from: q.from,
        to: q.to,
        data: rows.map((r) => shape(r, cols)),
        totals: {
          salesCount: rows.reduce((a, r) => a + (r.sales_count as number), 0),
          returnsCount: rows.reduce((a, r) => a + (r.returns_count as number), 0),
          ...Object.fromEntries(cols.map((k) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), money(sum(rows, k).toString())])),
        },
      };
    });
  }

  /**
   * Every sale line sold below (or above) its list price: an ordinary discount, an approved price
   * change, or both, with who sold it and who approved the price (SPEC §6.10, ADR-0017). Σ discount =
   * the discount bucket of the sales summary for the same days.
   */
  discounts(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT s.id AS sale_id, l.id AS line_id, s.sale_number, rg.code AS register_code, s.completed_at, l.name, l.quantity::text AS quantity,
               coalesce(o.list_unit_price, pp.amount)::text AS list_unit_price, l.unit_price::text AS unit_price,
               l.discount::text AS discount,
               CASE WHEN o.id IS NULL THEN 0 ELSE round((o.list_unit_price - l.unit_price) * l.quantity, 2) END::text AS price_change,
               s.cashier_user_id, cu.display_name AS cashier_name, o.approved_by, au.display_name AS approved_by_name, o.approval_method, o.reason AS price_reason
          FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN registers rg ON rg.id = s.register_id
          LEFT JOIN price_overrides o ON o.id = l.price_override_id
          LEFT JOIN product_prices pp ON pp.id = l.price_id
          LEFT JOIN users cu ON cu.id = s.cashier_user_id
          LEFT JOIN users au ON au.id = o.approved_by
         WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
           AND (l.discount <> 0 OR l.price_override_id IS NOT NULL)
         ORDER BY s.completed_at, l.line_no`);
      const data = rows.map((r) => ({
        ...shape(r, ['discount', 'price_change']),
        reference: `${r.register_code}-${String(r.sale_number).padStart(6, '0')}`,
        quantity: qty(r.quantity as string),
        listUnitPrice: toDec((r.list_unit_price as string) ?? '0').toString(),
        unitPrice: toDec(r.unit_price as string).toString(),
      }));
      const people = new Map<string, { userId: string; name: string | null; lines: number; discount: Dec; priceChange: Dec }>();
      for (const r of rows) {
        const p = people.get(r.cashier_user_id as string) ?? { userId: r.cashier_user_id as string, name: (r.cashier_name as string) ?? null, lines: 0, discount: new Dec(0), priceChange: new Dec(0) };
        p.lines += 1;
        p.discount = p.discount.plus(r.discount as string);
        p.priceChange = p.priceChange.plus(r.price_change as string);
        people.set(p.userId, p);
      }
      return {
        data,
        byCashier: [...people.values()].map((p) => ({ userId: p.userId, displayName: p.name, lines: p.lines, discount: money(p.discount.toString()), priceChange: money(p.priceChange.toString()) })),
        totals: { lines: rows.length, discount: money(sum(rows, 'discount').toString()), priceChange: money(sum(rows, 'price_change').toString()) },
      };
    });
  }

  /**
   * Per supplier: goods received (accepted quantities at receipt cost), what went back to them, the
   * net, and the invoices dated in the period. Received − returned per supplier ties to the GRNI it
   * created (ADR-0013).
   */
  purchasesBySupplier(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH rec AS (
          SELECT g.supplier_id, count(DISTINCT g.id) AS n, sum(gl.quantity * gl.unit_cost) AS amount
            FROM goods_receipts g JOIN goods_receipt_lines gl ON gl.goods_receipt_id = g.id
           WHERE g.branch_id = ${w.branchId} AND g.created_at >= ${w.start} AND g.created_at < ${w.end}
           GROUP BY 1),
        ret AS (
          SELECT r.supplier_id, count(DISTINCT r.id) AS n, sum(rl.quantity * rl.credit_unit_cost) AS amount
            FROM supplier_returns r JOIN supplier_return_lines rl ON rl.supplier_return_id = r.id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
           GROUP BY 1),
        inv AS (
          SELECT i.supplier_id, count(*) AS n, sum(i.total_amount) AS amount
            FROM supplier_invoices i
           WHERE i.branch_id = ${w.branchId} AND i.status <> 'CANCELLED' AND i.invoice_date BETWEEN ${range.from}::date AND ${range.to}::date
           GROUP BY 1),
        sup AS (SELECT supplier_id FROM rec UNION SELECT supplier_id FROM ret UNION SELECT supplier_id FROM inv)
        SELECT sp.id AS supplier_id, sp.code, sp.name,
               coalesce(rec.n, 0)::int AS receipts, round(coalesce(rec.amount, 0), 4)::text AS received,
               coalesce(ret.n, 0)::int AS supplier_returns, round(coalesce(ret.amount, 0), 4)::text AS returned,
               round(coalesce(rec.amount, 0) - coalesce(ret.amount, 0), 4)::text AS net_received,
               coalesce(inv.n, 0)::int AS invoices, coalesce(inv.amount, 0)::text AS invoiced
          FROM sup JOIN suppliers sp ON sp.id = sup.supplier_id
          LEFT JOIN rec ON rec.supplier_id = sp.id LEFT JOIN ret ON ret.supplier_id = sp.id LEFT JOIN inv ON inv.supplier_id = sp.id
         ORDER BY coalesce(rec.amount, 0) - coalesce(ret.amount, 0) DESC, sp.code`);
      const cols = ['received', 'returned', 'net_received', 'invoiced'];
      return {
        data: rows.map((r) => shape(r, cols)),
        totals: Object.fromEntries(cols.map((k) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), money(sum(rows, k).toString())])),
      };
    });
  }

  /**
   * Card/QR payments of this branch that still need someone, on any shift (open or closed): no answer
   * (UNKNOWN), still waiting (PROCESSING), or approved but in no sale. Oldest first, with the shift's
   * register and cashier, so a manager can check or cancel them (ADR-0010).
   */
  paymentExceptions(auth: AuthContext, branchId: string) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw notFound('Branch');
      const scope = { branchId: branch.id, legalEntityId: branch.legalEntityId };
      // Managers who reconcile drawers settle these too, report readers or not.
      if (!this.can(auth, 'cash.reconcile', scope)) this.assertCan(auth, 'reports.read', scope);
      const w = { branchId: branch.id };
      const { rows } = await db.execute<Row>(sql`
        SELECT p.id, p.method, p.amount::text AS amount, p.status, p.created_at, p.updated_at, p.cashier_session_id,
               cs.status AS shift_status, rg.code AS register_code, u.display_name AS cashier_name,
               extract(epoch FROM now() - p.created_at)::int AS age_seconds
          FROM payment_intents p JOIN cashier_sessions cs ON cs.id = p.cashier_session_id
          JOIN registers rg ON rg.id = p.register_id LEFT JOIN users u ON u.id = cs.opened_by
         WHERE p.branch_id = ${w.branchId}
           AND (p.status IN ('UNKNOWN', 'PROCESSING') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.purpose = 'SALE'))
         ORDER BY p.created_at`);
      return {
        branchId: branch.id,
        timezone: branch.timezone,
        data: rows.map((r) => ({ ...shape(r, ['amount']), problem: r.status === 'SUCCEEDED' ? 'NOT_IN_A_SALE' : r.status === 'UNKNOWN' ? 'NO_ANSWER' : 'WAITING' })),
        totals: { count: rows.length, amount: money(sum(rows, 'amount').toString()) },
      };
    });
  }
}
