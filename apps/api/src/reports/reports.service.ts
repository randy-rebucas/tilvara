import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, eq, sql, type Database } from '@1pos/database';
import { movementAt, movementSaleJoin } from './movement-time.js';
import { refundParts } from './refund-parts.js';
import { Dec, toDec } from '@1pos/money';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { expectedCash, loadSession } from '../sales/cash.service.js';
import { reservedAt } from '../inventory/reservations.service.js';

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
export const money = (v: string | null | undefined) => toDec(v ?? '0').toFixed(2);
export const qty = (v: string | null | undefined) => toDec(v ?? '0').toString();

export type Row = Record<string, string | number | null>;
export type ReportWindow = { branchId: string; tz: string; start: string; end: string };

/** Money columns to 2-dp strings, keys to camelCase. */
export function shape(r: Row, moneyCols: readonly string[] = BUCKETS) {
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
      // Room nights (ADR-0023 §12) are not sales; they appear as their own "Rooms" source, by night.
      const { rows: roomRows } = await db.execute<Row>(sql`
        SELECT e.night_date::text AS day, count(*) FILTER (WHERE e.kind = 'ROOM_NIGHT')::int AS count, ${sql.raw(BUCKETS.map((b) => `coalesce(sum(e.${b === 'amount_due' ? 'amount' : b}), 0)::text AS ${b}`).join(', '))}
          FROM folio_entries e JOIN folios f ON f.id = e.folio_id
         WHERE f.branch_id = ${w.branchId} AND e.night_date BETWEEN ${range.from}::date AND ${range.to}::date
           AND e.kind IN ('ROOM_NIGHT', 'NIGHT_REVERSAL') AND e.vatable_sales IS NOT NULL
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
            rooms: shape(Object.fromEntries(BUCKETS.map((b) => [b, (roomRows.find((x) => x.day === day)?.[b] as string) ?? '0']))),
          };
        }),
        rooms: {
          days: roomRows.map((r) => ({ day: r.day, nights: r.count, ...shape(Object.fromEntries(BUCKETS.map((b) => [b, r[b] as string]))) })),
          totals: { nights: roomRows.reduce((a, x) => a + (x.count as number), 0), ...shape(total(roomRows)) },
        },
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
        -- Ingredients consumed by a recipe item cost the item that was sold (ADR-0014 §4).
        cost AS (
          SELECT coalesce(l.variant_id, m.variant_id) AS variant_id, -sum(m.value) AS cogs
            FROM stock_movements m LEFT JOIN sale_lines l ON m.type = 'CONSUMPTION' AND l.id = m.sale_line_id ${movementSaleJoin}
           WHERE m.branch_id = ${w.branchId} AND m.type IN ('SALE', 'RETURN', 'CONSUMPTION') AND m.created_at >= ${w.start} AND ${movementAt} >= ${w.start} AND ${movementAt} < ${w.end}
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
      // Charges (service charge) are not products: listed apart so Σ products + Σ charges = the summary.
      const { rows: charges } = await db.execute<Row>(sql`
        WITH sold AS (
          SELECT c.kind, sum(c.amount_due) AS amount, sum(c.amount_due - c.vat_amount) AS ex_vat
            FROM sale_charges c JOIN sales s ON s.id = c.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
           GROUP BY 1),
        back AS (
          SELECT c.kind, sum(rc.amount_due) AS amount, sum(rc.amount_due - rc.vat_amount) AS ex_vat
            FROM sale_return_charges rc JOIN sale_returns r ON r.id = rc.sale_return_id JOIN sale_charges c ON c.id = rc.sale_charge_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
           GROUP BY 1)
        SELECT coalesce(sold.kind, back.kind) AS kind,
               coalesce(sold.amount, 0)::text AS charged, coalesce(back.amount, 0)::text AS returned,
               (coalesce(sold.amount, 0) - coalesce(back.amount, 0))::text AS net,
               (coalesce(sold.ex_vat, 0) - coalesce(back.ex_vat, 0))::text AS net_ex_vat
          FROM sold FULL JOIN back ON back.kind = sold.kind ORDER BY 1`);
      return {
        data: rows.map((r) => ({
          ...shape(r, ['sales', 'returns', 'net_sales', 'revenue_ex_vat', 'cogs', 'gross_profit']),
          quantitySold: qty(r.quantity_sold as string),
          quantityReturned: qty(r.quantity_returned as string),
          netQuantity: qty(r.net_quantity as string),
        })),
        charges: charges.map((c) => ({ kind: c.kind, ...shape(c, ['charged', 'returned', 'net', 'net_ex_vat']) })),
      };
    });
  }

  /**
   * Sales by size and colour (ADR-0021 §2): sales lines totalled by the value of one attribute of the
   * variant sold (`attribute`, default the first one any sold variant has). Items without it are one
   * row with `value: null`. `attributes` lists every attribute name the period's items have.
   */
  byAttribute(auth: AuthContext, range: ReportRange, attribute?: string) {
    return this.run(auth, range, async (db, w) => {
      const { rows: names } = await db.execute<{ name: string }>(sql`
        SELECT DISTINCT k AS name FROM sale_lines l JOIN sales s ON s.id = l.sale_id
          JOIN product_variants v ON v.id = l.variant_id, jsonb_object_keys(v.attributes) k
         WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
         ORDER BY 1`);
      const attr = attribute ?? names[0]?.name ?? null;
      if (!attr) return { attribute: null, attributes: [], data: [] };
      const { rows } = await db.execute<Row>(sql`
        WITH a AS (SELECT ${attr}::text AS k),
        moves AS (
          SELECT l.variant_id, l.quantity AS sold, 0::numeric AS back, l.amount_due AS amount, l.amount_due - l.vat_amount AS revenue
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} AND l.parent_line_id IS NULL
          UNION ALL
          SELECT l.variant_id, 0, rl.quantity, -rl.amount_due, -(rl.amount_due - rl.vat_amount)
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end} AND l.parent_line_id IS NULL)
        SELECT v.attributes ->> a.k AS value,
               sum(m.sold)::text AS quantity_sold, sum(m.back)::text AS quantity_returned, (sum(m.sold) - sum(m.back))::text AS net_quantity,
               sum(m.amount)::text AS net_sales, sum(m.revenue)::text AS revenue_ex_vat
          FROM moves m JOIN product_variants v ON v.id = m.variant_id CROSS JOIN a
         GROUP BY 1
         ORDER BY sum(m.amount) DESC, 1`);
      return {
        attribute: attr,
        attributes: names.map((n) => n.name),
        data: rows.map((r) => ({
          value: (r.value as string | null) ?? null,
          ...shape(r, ['net_sales', 'revenue_ex_vat']),
          quantitySold: qty(r.quantity_sold as string),
          quantityReturned: qty(r.quantity_returned as string),
          netQuantity: qty(r.net_quantity as string),
        })),
      };
    });
  }

  /**
   * Promotions (ADR-0021 §1): per promotion, the lines it priced in the period, units, the discount it
   * gave and what those lines sold for, less returns of them.
   */
  promotions(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH sold AS (
          SELECT l.promotion_id, count(DISTINCT l.sale_id) AS sales, sum(l.quantity) AS qty, sum(l.discount) AS discount, sum(l.amount_due) AS amount
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} AND l.promotion_id IS NOT NULL
           GROUP BY 1),
        back AS (
          SELECT l.promotion_id, sum(rl.quantity) AS qty, sum(rl.discount) AS discount, sum(rl.amount_due) AS amount
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end} AND l.promotion_id IS NOT NULL
           GROUP BY 1)
        SELECT p.id AS promotion_id, p.name, p.kind,
               coalesce(sold.sales, 0)::int AS sales_count,
               (coalesce(sold.qty, 0) - coalesce(back.qty, 0))::text AS net_quantity,
               (coalesce(sold.discount, 0) - coalesce(back.discount, 0))::text AS discount,
               (coalesce(sold.amount, 0) - coalesce(back.amount, 0))::text AS net_sales
          FROM promotions p LEFT JOIN sold ON sold.promotion_id = p.id LEFT JOIN back ON back.promotion_id = p.id
         WHERE sold.promotion_id IS NOT NULL OR back.promotion_id IS NOT NULL
         ORDER BY (coalesce(sold.discount, 0) - coalesce(back.discount, 0)) DESC, p.name`);
      return {
        data: rows.map((r) => ({
          promotionId: r.promotion_id,
          name: r.name,
          kind: r.kind,
          ...shape(r, ['discount', 'net_sales']),
          salesCount: r.sales_count,
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

  /**
   * Refund watch (THREAT_MODEL T5, session 16): per person, the sales they rang up, the returns and voids
   * they processed, and how many of those were of their own sales. Signals for a manager to look at,
   * not findings: HIGH_RATE when someone's refunds are at least twice the branch's rate (and at least
   * three), OWN_SALES when someone refunded their own sales twice or more.
   */
  refundWatch(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH s AS (SELECT cashier_user_id AS user_id, count(*) AS n, sum(amount_due) AS amount FROM sales
                    WHERE branch_id = ${w.branchId} AND completed_at >= ${w.start} AND completed_at < ${w.end} GROUP BY 1),
             r AS (SELECT sr.processed_by AS user_id,
                          count(*) FILTER (WHERE sr.kind = 'RETURN') AS returns_n, coalesce(sum(sr.amount_due) FILTER (WHERE sr.kind = 'RETURN'), 0) AS returns_amount,
                          count(*) FILTER (WHERE sr.kind = 'VOID') AS voids_n, coalesce(sum(sr.amount_due) FILTER (WHERE sr.kind = 'VOID'), 0) AS voids_amount,
                          count(*) FILTER (WHERE x.cashier_user_id = sr.processed_by) AS own_n
                     FROM sale_returns sr JOIN sales x ON x.id = sr.sale_id
                    WHERE sr.branch_id = ${w.branchId} AND sr.created_at >= ${w.start} AND sr.created_at < ${w.end} GROUP BY 1)
        SELECT u.id AS user_id, u.display_name, coalesce(s.n, 0)::int AS sales_count, coalesce(s.amount, 0)::text AS sales,
               coalesce(r.returns_n, 0)::int AS returns_count, coalesce(r.returns_amount, 0)::text AS returns,
               coalesce(r.voids_n, 0)::int AS voids_count, coalesce(r.voids_amount, 0)::text AS voids,
               coalesce(r.own_n, 0)::int AS own_sales_refunded
          FROM users u LEFT JOIN s ON s.user_id = u.id LEFT JOIN r ON r.user_id = u.id
         WHERE s.user_id IS NOT NULL OR r.user_id IS NOT NULL
         ORDER BY u.display_name`);
      const total = (k: string) => rows.reduce((a, r) => a.plus(r[k] as string), new Dec(0));
      const rate = (refunded: Dec, sales: Dec) => (sales.gt(0) ? refunded.div(sales) : null);
      const branchRate = rate(total('returns').plus(total('voids')), total('sales'));
      const data = rows.map((r) => {
        const refunded = toDec(r.returns as string).plus(r.voids as string);
        const mine = rate(refunded, toDec(r.sales as string));
        const count = (r.returns_count as number) + (r.voids_count as number);
        const flags = [
          ...(mine && branchRate && branchRate.gt(0) && mine.gte(branchRate.times(2)) && count >= 3 ? ['HIGH_RATE'] : []),
          ...((r.own_sales_refunded as number) >= 2 ? ['OWN_SALES'] : []),
        ];
        return { ...shape(r, ['sales', 'returns', 'voids']), refunded: money(refunded.toString()), refundRate: mine?.toFixed(4) ?? null, flags };
      });
      return {
        data,
        branch: { sales: money(total('sales').toString()), refunded: money(total('returns').plus(total('voids')).toString()), refundRate: branchRate?.toFixed(4) ?? null },
      };
    });
  }

  byTender(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH t AS (SELECT t.method, count(*) AS n, sum(t.amount) AS amount FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
                    WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} GROUP BY 1),
             -- A return split between store credit, a folio and cash counts under each, for its part (refund-parts.ts).
             r AS (SELECT method, count(DISTINCT sale_return_id) AS n, sum(amount) AS amount
                     FROM (${refundParts(sql`r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}`)}) rp GROUP BY 1)
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
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
          UNION ALL
          -- Room nights, their reversals and folio adjustments (ADR-0023 §12), signed, on their date.
          SELECT e.tax_snapshot->>'vatStatus', e.tax_snapshot->>'vatRate', 1,
                 e.statutory_discount, e.vat_exemption_amount, e.vatable_sales, e.vat_amount, e.vat_exempt_sales, e.zero_rated_sales, e.percentage_tax_sales, e.amount
            FROM folio_entries e JOIN folios f ON f.id = e.folio_id
           WHERE f.branch_id = ${w.branchId} AND e.kind IN ('ROOM_NIGHT', 'NIGHT_REVERSAL', 'ADJUSTMENT') AND e.vatable_sales IS NOT NULL
             AND coalesce(e.night_date, e.journal_date) BETWEEN ${range.from}::date AND ${range.to}::date)
        SELECT vat_status, vat_rate, ${cols} FROM docs GROUP BY 1, 2 ORDER BY 1, 2`);
      return { data: rows.map((r) => ({ ...shape(r), vatRate: toDec((r.vat_rate as string) ?? '0').toString() })) };
    });
  }

  /**
   * SC/PWD sales book (RR 5-2017 §5.9): one row per beneficiary per sale, returns as negative rows.
   * `purchase_booklet`: on a discount that covered a medicine, whether the booklet was presented (ADR-0025 §8).
   */
  statutoryBook(auth: AuthContext, range: ReportRange & { scheme?: string }) {
    return this.run(auth, range, async (db, w) => {
      const scheme = range.scheme ? sql`AND b.scheme_code = ${range.scheme}` : sql``;
      const { rows } = await db.execute<Row>(sql`
        SELECT 'SALE' AS document, s.completed_at, (s.completed_at AT TIME ZONE ${w.tz})::date::text AS day, s.sale_number::int AS number, reg.code AS register,
               b.scheme_code, b.name, b.id_number, b.tin, b.purchase_booklet,
               sum(l.vat_exempt_sales + l.zero_rated_sales + l.percentage_tax_sales)::text AS sales,
               sum(l.statutory_discount)::text AS discount, sum(l.amount_due)::text AS net
          FROM sale_beneficiaries b JOIN sales s ON s.id = b.sale_id JOIN sale_lines l ON l.beneficiary_id = b.id
          JOIN registers reg ON reg.id = s.register_id
         WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end} ${scheme}
         GROUP BY s.id, s.completed_at, s.sale_number, reg.code, b.id
        UNION ALL
        SELECT 'RETURN', r.created_at, (r.created_at AT TIME ZONE ${w.tz})::date::text, r.return_number::int, reg.code,
               b.scheme_code, b.name, b.id_number, b.tin, b.purchase_booklet,
               (-sum(rl.vat_exempt_sales + rl.zero_rated_sales + rl.percentage_tax_sales))::text, (-sum(rl.statutory_discount))::text, (-sum(rl.amount_due))::text
          FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
          JOIN sale_beneficiaries b ON b.id = l.beneficiary_id JOIN registers reg ON reg.id = r.register_id
         WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end} ${scheme}
         GROUP BY r.id, r.created_at, r.return_number, reg.code, b.id
        UNION ALL
        -- SC/PWD room nights (ADR-0023 §7): each beneficiary's part of the night by their share of the discounted share.
        SELECT CASE e.kind WHEN 'ROOM_NIGHT' THEN 'ROOM_NIGHT' ELSE 'NIGHT_REVERSAL' END, e.created_at, e.night_date::text, NULL::int, NULL,
               sb.scheme_code, sb.name, sb.id_number, NULL, NULL,
               ((e.vat_exempt_sales + e.zero_rated_sales + e.percentage_tax_sales) * (bj->>'share')::numeric / tot.share)::numeric(20,2)::text,
               (e.statutory_discount * (bj->>'share')::numeric / tot.share)::numeric(20,2)::text,
               (e.amount * (bj->>'share')::numeric / tot.share)::numeric(20,2)::text
          FROM folio_entries e JOIN folios f ON f.id = e.folio_id
          CROSS JOIN LATERAL jsonb_array_elements(e.tax_snapshot->'beneficiaries') bj
          CROSS JOIN LATERAL (SELECT sum((x->>'share')::numeric) AS share FROM jsonb_array_elements(e.tax_snapshot->'beneficiaries') x) tot
          JOIN stay_beneficiaries sb ON sb.id = (bj->>'id')::uuid
         WHERE f.branch_id = ${w.branchId} AND e.kind IN ('ROOM_NIGHT', 'NIGHT_REVERSAL') AND e.statutory_discount <> 0
           AND e.night_date BETWEEN ${range.from}::date AND ${range.to}::date ${range.scheme ? sql`AND sb.scheme_code = ${range.scheme}` : sql``}
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
      // Session 20: what is set aside for customers, and what is left to sell (reservations move no value).
      const reserved = await reservedAt(db, branch.id);
      return {
        branchId: branch.id,
        data: rows.map((r) => {
          const held = reserved.get(r.variant_id as string) ?? toDec('0');
          return {
            variantId: r.variant_id, sku: r.sku, name: r.name, quantity: qty(r.quantity as string), avgCost: toDec(r.avg_cost as string).toFixed(4), value: money(r.value as string),
            reserved: held.toString(), available: toDec(r.quantity as string).minus(held).toString(),
          };
        }),
        totalValue: total.toFixed(2),
        ledgerValue: money(ledger!.value as string),
      };
    });
  }

  /** Per item: opening + movements by type in the range = closing, in quantity and value. */
  stockMovements(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      // A sale's movements count when the sale happened, like its revenue (an offline sale arrives later).
      const { rows } = await db.execute<Row>(sql`
        SELECT m.variant_id, v.sku, p.name,
               coalesce(sum(m.quantity) FILTER (WHERE ${movementAt} < ${w.start}), 0)::text AS opening_qty,
               coalesce(sum(m.value) FILTER (WHERE ${movementAt} < ${w.start}), 0)::text AS opening_value,
               coalesce(sum(m.quantity), 0)::text AS closing_qty,
               coalesce(sum(m.value), 0)::text AS closing_value,
               count(*) FILTER (WHERE m.below_zero AND ${movementAt} >= ${w.start})::int AS below_zero
          FROM stock_movements m ${movementSaleJoin} JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
         WHERE m.branch_id = ${w.branchId} AND ${movementAt} < ${w.end}
         GROUP BY 1, 2, 3 ORDER BY v.sku`);
      const { rows: byType } = await db.execute<Row>(sql`
        SELECT m.variant_id, m.type, sum(m.quantity)::text AS qty, sum(m.value)::text AS value FROM stock_movements m ${movementSaleJoin}
         WHERE m.branch_id = ${w.branchId} AND m.created_at >= ${w.start} AND ${movementAt} >= ${w.start} AND ${movementAt} < ${w.end} GROUP BY 1, 2`);
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
          /** Movements in the range that left the item below zero (negative-stock policy). */
          belowZero: r.below_zero as number,
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
      // Front desk collections (ADR-0023 §5.2): folio payments and deposits at this drawer, apart from sales.
      const { rows: frontDesk } = await db.execute<Row>(sql`
        SELECT 'FOLIO_PAYMENT' AS kind, p.method, count(*)::int AS count, sum(p.amount)::text AS amount FROM folio_payments p WHERE p.cashier_session_id = ${sessionId} GROUP BY 1, 2
        UNION ALL
        SELECT 'DEPOSIT_' || d.kind, d.method, count(*)::int, sum(d.amount)::text FROM stay_deposits d
         WHERE d.kind IN ('RECEIVED', 'REFUNDED') AND (d.cashier_session_id = ${sessionId}
            OR d.payment_intent_id IN (SELECT id FROM payment_intents WHERE cashier_session_id = ${sessionId}))
         GROUP BY 1, 2 ORDER BY 1, 2`);
      // Job order down payments (ADR-0024 §5): taken and given back at this drawer, apart from sales.
      const { rows: downPayments } = await db.execute<Row>(sql`
        SELECT d.kind, d.method, count(*)::int AS count, sum(d.amount)::text AS amount FROM job_order_deposits d
         WHERE d.kind IN ('RECEIVED', 'REFUNDED') AND (d.cashier_session_id = ${sessionId}
            OR d.payment_intent_id IN (SELECT id FROM payment_intents WHERE cashier_session_id = ${sessionId}))
         GROUP BY 1, 2 ORDER BY 1, 2`);
      return {
        session: { id: session.id, registerId: session.registerId, status: session.status, openedAt: session.openedAt, closedAt: session.closedAt, openingFloat: money(session.openingFloat) },
        sales: shape(sales!, ['amount_due', 'statutory_discount', 'vat_amount']),
        tenders: tenders.map((t) => shape(t, ['amount'])),
        returns: returns.map((r) => shape(r, ['amount'])),
        drawer: drawer.map((d) => shape(d, ['amount'])),
        frontDeskCollections: {
          data: frontDesk.map((f) => shape(f, ['amount'])),
          cash: money(frontDesk.filter((f) => f.method === 'CASH').reduce((a, f) => a.plus(f.amount as string), toDec('0')).toString()),
        },
        jobOrderDownPayments: {
          data: downPayments.map((f) => shape(f, ['amount'])),
          cash: money(downPayments.filter((f) => f.method === 'CASH').reduce((a, f) => a.plus(f.amount as string), toDec('0')).toString()),
        },
        expectedCash: money(await expectedCash(db, sessionId)),
        count: rec ? { countedCash: money(rec.counted_cash as string), variance: money(rec.variance as string), approved: rec.approved_at !== null } : null,
      };
    });
  }

  /** Resolve the branch (404 across tenants), check scope and turn local dates into an instant range. */
  protected run<T>(auth: AuthContext, range: ReportRange, fn: (db: Database, w: ReportWindow) => Promise<T>) {
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
