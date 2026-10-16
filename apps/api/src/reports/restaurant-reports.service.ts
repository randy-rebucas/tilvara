import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@1pos/database';
import { toDec, type Dec } from '@1pos/money';
import type { AuthContext } from '../auth/auth-context.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { money, qty, ReportsService, type ReportRange, type Row } from './reports.service.js';

const ZERO = toDec('0');
const dec = (v: unknown) => toDec((v as string | null) ?? '0');
/** a / b as a percentage with one decimal, or null when b is zero. */
const pct = (a: Dec, b: Dec) => (b.isZero() ? null : a.div(b).times(100).toFixed(1));

/** Stage an item had reached when it was voided, from its kitchen timestamps. */
const stage = (r: Row) => (r.served_at ? 'SERVED' : r.ready_at ? 'READY' : r.prep_started_at ? 'IN_PREP' : 'FIRED');

/**
 * Restaurant reports (ADR-0014 §10), read-only over the evidence: sale lines, returns, stock movements,
 * order items and kitchen tickets, bills and charges. Same conventions as the retail reports: sales count
 * when completed, returns when processed, movements when written, all in the branch's local days.
 */
@Injectable()
export class RestaurantReportsService extends ReportsService {
  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /**
   * Menu items with their priced modifiers nested under them: quantity, net sales, revenue ex VAT,
   * COGS (the item's own stock or its recipe's ingredients) and margin. A modifier line counts under
   * the item it modified; the same variant sold on its own is its own row. Σ rows = by-product.
   */
  itemPerformance(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH facts AS (
          SELECT l.id AS line_id, l.sale_id, l.quantity AS sold_qty, 0::numeric AS returned_qty, l.amount_due AS sales, 0::numeric AS returns,
                 l.amount_due - l.vat_amount AS revenue, 0::numeric AS cogs
            FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
          UNION ALL
          SELECT rl.sale_line_id, NULL, 0, rl.quantity, 0, rl.amount_due, -(rl.amount_due - rl.vat_amount), 0
            FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id
           WHERE r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end}
          UNION ALL
          SELECT m.sale_line_id, NULL, 0, 0, 0, 0, 0, -m.value
            FROM stock_movements m
           WHERE m.branch_id = ${w.branchId} AND m.type IN ('SALE', 'RETURN', 'CONSUMPTION') AND m.created_at >= ${w.start} AND m.created_at < ${w.end}),
        g AS (
          SELECT coalesce(p.variant_id, l.variant_id) AS item_id,
                 CASE WHEN l.parent_line_id IS NULL THEN NULL ELSE l.variant_id END AS modifier_id,
                 sum(f.sold_qty) AS sold_qty, sum(f.returned_qty) AS returned_qty, sum(f.sales) AS sales, sum(f.returns) AS returns,
                 sum(f.revenue) AS revenue, sum(f.cogs) AS cogs, count(DISTINCT f.sale_id)::int AS checks
            FROM facts f JOIN sale_lines l ON l.id = f.line_id LEFT JOIN sale_lines p ON p.id = l.parent_line_id
           GROUP BY 1, 2)
        SELECT g.item_id, iv.sku AS item_sku, ip.name AS item_name, g.modifier_id, mv.sku AS modifier_sku, mp.name AS modifier_name,
               g.sold_qty::text, g.returned_qty::text, g.sales::text, g.returns::text, g.revenue::text, g.cogs::text, g.checks
          FROM g JOIN product_variants iv ON iv.id = g.item_id JOIN products ip ON ip.id = iv.product_id
          LEFT JOIN product_variants mv ON mv.id = g.modifier_id LEFT JOIN products mp ON mp.id = mv.product_id
         ORDER BY iv.sku, mv.sku NULLS FIRST`);

      const figures = (r?: Row) => {
        const revenue = dec(r?.revenue);
        const cogs = dec(r?.cogs);
        return {
          quantitySold: qty(r?.sold_qty as string),
          quantityReturned: qty(r?.returned_qty as string),
          netQuantity: dec(r?.sold_qty).minus(dec(r?.returned_qty)).toString(),
          sales: money(r?.sales as string),
          returns: money(r?.returns as string),
          netSales: dec(r?.sales).minus(dec(r?.returns)).toFixed(2),
          revenueExVat: revenue.toFixed(2),
          cogs: cogs.toFixed(2),
          grossProfit: revenue.minus(cogs).toFixed(2),
          marginPct: pct(revenue.minus(cogs), revenue),
        };
      };
      const sum = (fs: { netSales: string; revenueExVat: string; cogs: string }[]) => {
        const total = (k: 'netSales' | 'revenueExVat' | 'cogs') => fs.reduce((a, f) => a.plus(f[k]), ZERO);
        const [netSales, revenue, cogs] = [total('netSales'), total('revenueExVat'), total('cogs')];
        return { netSales: netSales.toFixed(2), revenueExVat: revenue.toFixed(2), cogs: cogs.toFixed(2), grossProfit: revenue.minus(cogs).toFixed(2), marginPct: pct(revenue.minus(cogs), revenue) };
      };

      const byItem = new Map<string, Row[]>();
      for (const r of rows) byItem.set(r.item_id as string, [...(byItem.get(r.item_id as string) ?? []), r]);
      const data = [...byItem.values()].map((group) => {
        const own = group.find((r) => r.modifier_id === null);
        const mods = group.filter((r) => r.modifier_id !== null);
        const self = figures(own);
        const modifiers = mods.map((m) => ({ variantId: m.modifier_id, sku: m.modifier_sku, name: m.modifier_name, checks: m.checks, ...figures(m) }));
        return {
          variantId: group[0]!.item_id,
          sku: group[0]!.item_sku,
          name: group[0]!.item_name,
          checks: own?.checks ?? 0,
          ...self,
          modifiers,
          withModifiers: sum([self, ...modifiers]),
        };
      });
      data.sort((a, b) => toDec(b.withModifiers.netSales).comparedTo(a.withModifiers.netSales) || String(a.sku).localeCompare(String(b.sku)));
      return { data, totals: sum(data.map((d) => d.withModifiers)) };
    });
  }

  /**
   * Theoretical vs actual ingredient use, per ingredient (any item used in a recipe), in quantity and value:
   * - expected = recipe consumption at checkout + the ingredient sold as itself (net of restocked returns);
   * - recorded waste = prepared food voided and thrown away (order item → WASTE document) + other waste;
   * - count variance = what counts found against the books (negative = short);
   * - actual = expected + waste − count variance; variance = actual − expected.
   * Manual adjustments, receipts and transfers are stock coming in or corrections, not use.
   */
  ingredientUsage(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH ingredients AS (SELECT DISTINCT ingredient_variant_id AS variant_id FROM recipe_ingredients),
        prepared AS (SELECT DISTINCT waste_adjustment_id AS id FROM order_items WHERE waste_adjustment_id IS NOT NULL),
        m AS (
          SELECT m.variant_id, m.quantity, m.value,
                 CASE WHEN m.type = 'CONSUMPTION' THEN 'recipe'
                      WHEN m.type IN ('SALE', 'RETURN') THEN 'sold'
                      WHEN m.type = 'WASTE' AND m.stock_adjustment_id IN (SELECT id FROM prepared) THEN 'prepared_waste'
                      WHEN m.type = 'WASTE' THEN 'other_waste'
                      ELSE 'count' END AS kind
            FROM stock_movements m
           WHERE m.branch_id = ${w.branchId} AND m.created_at >= ${w.start} AND m.created_at < ${w.end}
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
          const preparedWaste = of('prepared_waste', col);
          const otherWaste = of('other_waste', col);
          const countVariance = of('count', col, true);
          const expected = recipe.plus(sold);
          const actual = expected.plus(preparedWaste).plus(otherWaste).minus(countVariance);
          return { recipe, sold, expected, preparedWaste, otherWaste, countVariance, actual, variance: actual.minus(expected) };
        };
        const q = side('qty');
        const v = side('value');
        total.expected = total.expected.plus(v.expected);
        total.waste = total.waste.plus(v.preparedWaste).plus(v.otherWaste);
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
   * Items voided after they were fired, in the local days they were voided: what, where, who and why,
   * the stage the kitchen had reached (from its timestamps), and whether it was thrown away (with the
   * value of its WASTE document). Summarised by reason and by user.
   */
  kitchenVoids(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT i.id AS order_item_id, i.voided_at, o.id AS order_id, o.order_number::int AS order_number, o.order_type, t.code AS table_code,
               st.code AS station_code, i.name, i.quantity::text AS quantity, i.void_reason AS reason,
               i.voided_by, u.display_name AS voided_by_name, i.fired_at, i.prep_started_at, i.ready_at, i.served_at, i.waste_adjustment_id,
               (SELECT -sum(m.value) FROM stock_movements m WHERE m.stock_adjustment_id = i.waste_adjustment_id)::text AS waste_value,
               coalesce((SELECT array_agg(c.name ORDER BY c.created_at, c.id) FROM order_items c WHERE c.parent_item_id = i.id), '{}') AS modifiers
          FROM order_items i JOIN restaurant_orders o ON o.id = i.order_id
          LEFT JOIN restaurant_tables t ON t.id = o.table_id
          LEFT JOIN kitchen_tickets k ON k.id = i.kitchen_ticket_id LEFT JOIN kitchen_stations st ON st.id = k.station_id
          LEFT JOIN users u ON u.id = i.voided_by
         WHERE o.branch_id = ${w.branchId} AND i.kind = 'ITEM' AND i.status = 'VOIDED' AND i.voided_at >= ${w.start} AND i.voided_at < ${w.end}
         ORDER BY i.voided_at, i.id`);

      const data = rows.map((r) => {
        const s = stage(r);
        return {
          orderItemId: r.order_item_id,
          voidedAt: r.voided_at,
          order: { id: r.order_id, orderNumber: r.order_number, orderType: r.order_type, tableCode: r.table_code },
          stationCode: r.station_code,
          name: r.name,
          quantity: qty(r.quantity as string),
          modifiers: r.modifiers as unknown as string[],
          reason: r.reason,
          voidedBy: { userId: r.voided_by, displayName: r.voided_by_name },
          stage: s,
          cookingStarted: s !== 'FIRED',
          wasted: r.waste_adjustment_id !== null,
          wasteAdjustmentId: r.waste_adjustment_id,
          wasteValue: money(r.waste_value as string),
        };
      });
      type Void = (typeof data)[number];
      const summarize = (key: (v: Void) => string, label: (v: Void) => Record<string, unknown>) => {
        const groups = new Map<string, Void[]>();
        for (const v of data) groups.set(key(v), [...(groups.get(key(v)) ?? []), v]);
        return [...groups.values()].map((vs) => ({ ...label(vs[0]!), ...totals(vs) }));
      };
      const totals = (vs: Void[]) => ({
        voids: vs.length,
        cookingStarted: vs.filter((v) => v.cookingStarted).length,
        wasted: vs.filter((v) => v.wasted).length,
        wasteValue: vs.reduce((a, v) => a.plus(v.wasteValue), ZERO).toFixed(2),
      });
      return {
        data,
        byReason: summarize((v) => String(v.reason), (v) => ({ reason: v.reason })),
        byUser: summarize((v) => String(v.voidedBy.userId), (v) => ({ userId: v.voidedBy.userId, displayName: v.voidedBy.displayName })),
        totals: totals(data),
      };
    });
  }

  /**
   * Kitchen preparation times per station, for items fired in the range (seconds): fired → ready
   * (average, median, 90th percentile, longest), fired → preparation started, and ready → served.
   * Only items the kitchen marked ready are timed; voided items count apart.
   */
  prepTimes(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH x AS (
          SELECT k.station_id, i.kitchen_ticket_id, i.status,
                 extract(epoch FROM i.ready_at - i.fired_at)::float8 AS prep,
                 extract(epoch FROM i.prep_started_at - i.fired_at)::float8 AS wait,
                 extract(epoch FROM i.served_at - i.ready_at)::float8 AS pass
            FROM order_items i JOIN kitchen_tickets k ON k.id = i.kitchen_ticket_id
           WHERE k.branch_id = ${w.branchId} AND i.kind = 'ITEM' AND i.fired_at >= ${w.start} AND i.fired_at < ${w.end})
        SELECT st.id AS station_id, st.code, st.name,
               count(DISTINCT x.kitchen_ticket_id)::int AS tickets, count(*)::int AS items,
               count(*) FILTER (WHERE x.status = 'VOIDED')::int AS voided, count(x.prep)::int AS timed,
               round(avg(x.prep))::int AS avg_seconds,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x.prep))::int AS median_seconds,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY x.prep))::int AS p90_seconds,
               round(max(x.prep))::int AS max_seconds,
               round(avg(x.wait))::int AS avg_wait_seconds,
               round(avg(x.pass))::int AS avg_pass_seconds
          FROM x JOIN kitchen_stations st ON st.id = x.station_id
         GROUP BY GROUPING SETS ((st.id, st.code, st.name), ())
         ORDER BY st.code NULLS LAST`);
      const view = ({ station_id: _id, code: _c, name: _n, ...r }: Row) => ({
        tickets: r.tickets,
        items: r.items,
        voided: r.voided,
        timed: r.timed,
        prepSeconds: { average: r.avg_seconds, median: r.median_seconds, p90: r.p90_seconds, max: r.max_seconds },
        waitSeconds: r.avg_wait_seconds,
        passSeconds: r.avg_pass_seconds,
      });
      const stations = rows.filter((r) => r.station_id !== null);
      const overall = rows.find((r) => r.station_id === null);
      return {
        stations: stations.map((r) => ({ stationId: r.station_id, code: r.code, name: r.name, ...view(r) })),
        overall: overall ? view(overall) : null,
      };
    });
  }

  /**
   * Orders still open at the close of a local day (or now, for today): never settled, cancelled or merged
   * before then. Billed ones show the bill and what checks had paid by then. Item counts are as the
   * items are attached now (items can move between orders).
   */
  openOrders(auth: AuthContext, q: { branchId: string; day: string }) {
    return this.run(auth, { branchId: q.branchId, from: q.day, to: q.day }, async (db, w) => {
      const { rows: [cut] } = await db.execute<{ as_of: string }>(sql`SELECT least(${w.end}::timestamptz, now())::text AS as_of`);
      const asOf = cut!.as_of;
      const { rows } = await db.execute<Row>(sql`
        SELECT o.id, o.order_number::int AS order_number, o.order_type, t.code AS table_code, o.customer_name, o.guest_count,
               o.opened_at, o.opened_by, u.display_name AS opened_by_name, o.status AS status_now,
               b.id AS bill_id, b.bill_number::int AS bill_number, b.amount_due::text AS bill_amount,
               (SELECT coalesce(sum(s.amount_due), 0) FROM sales s WHERE s.order_bill_id = b.id AND s.completed_at < ${asOf})::text AS paid,
               (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.kind = 'ITEM' AND i.status <> 'VOIDED')::int AS items,
               (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.kind = 'ITEM' AND i.status IN ('PENDING', 'FIRED', 'IN_PREP', 'READY'))::int AS not_served
          FROM restaurant_orders o
          LEFT JOIN restaurant_tables t ON t.id = o.table_id
          LEFT JOIN users u ON u.id = o.opened_by
          LEFT JOIN LATERAL (
            SELECT b.* FROM order_bills b
             WHERE b.order_id = o.id AND b.created_at < ${asOf} AND (b.voided_at IS NULL OR b.voided_at >= ${asOf})
             ORDER BY b.created_at DESC LIMIT 1) b ON true
         WHERE o.branch_id = ${w.branchId} AND o.opened_at < ${asOf} AND (o.closed_at IS NULL OR o.closed_at >= ${asOf})
         ORDER BY o.opened_at, o.order_number`);
      const data = rows.map((r) => {
        const bill = r.bill_id
          ? { id: r.bill_id, billNumber: r.bill_number, amountDue: money(r.bill_amount as string), paid: money(r.paid as string), remaining: dec(r.bill_amount).minus(dec(r.paid)).toFixed(2) }
          : null;
        return {
          orderId: r.id,
          orderNumber: r.order_number,
          orderType: r.order_type,
          tableCode: r.table_code,
          customerName: r.customer_name,
          guestCount: r.guest_count,
          openedAt: r.opened_at,
          openedBy: { userId: r.opened_by, displayName: r.opened_by_name },
          status: bill ? 'BILLED' : 'OPEN',
          statusNow: r.status_now,
          bill,
          items: r.items,
          notServed: r.not_served,
        };
      });
      return {
        day: q.day,
        asOf,
        data,
        totals: {
          orders: data.length,
          unbilled: data.filter((d) => !d.bill).length,
          billed: data.filter((d) => d.bill).length,
          unpaid: data.reduce((a, d) => a.plus(d.bill?.remaining ?? '0'), ZERO).toFixed(2),
        },
      };
    });
  }

  /**
   * Service charge collected per local day, net of what returns gave back, for distribution to covered
   * employees (RA 11360, DOLE). The distributable amount is the charge ex VAT, i.e. what was credited to
   * SERVICE_CHARGE_PAYABLE (ADR-0014 §9; pending the accountant); `ledger` is that account's movement
   * from these same documents, so a difference would show at once.
   */
  serviceCharge(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH docs AS (
          SELECT (s.completed_at AT TIME ZONE ${w.tz})::date AS day, 1 AS checks, 0 AS returns, c.base,
                 c.amount_due - c.vat_amount AS ex_vat, c.vat_amount AS vat, c.amount_due AS amount
            FROM sale_charges c JOIN sales s ON s.id = c.sale_id
           WHERE c.kind = 'SERVICE_CHARGE' AND s.branch_id = ${w.branchId} AND s.completed_at >= ${w.start} AND s.completed_at < ${w.end}
          UNION ALL
          SELECT (r.created_at AT TIME ZONE ${w.tz})::date, 0, 1, 0,
                 -(rc.amount_due - rc.vat_amount), -rc.vat_amount, -rc.amount_due
            FROM sale_return_charges rc JOIN sale_returns r ON r.id = rc.sale_return_id JOIN sale_charges c ON c.id = rc.sale_charge_id
           WHERE c.kind = 'SERVICE_CHARGE' AND r.branch_id = ${w.branchId} AND r.created_at >= ${w.start} AND r.created_at < ${w.end})
        SELECT day::text, sum(checks)::int AS checks, sum(returns)::int AS returns, sum(base)::text AS base,
               coalesce(sum(ex_vat) FILTER (WHERE checks = 1), 0)::text AS charged_ex_vat,
               coalesce(sum(vat) FILTER (WHERE checks = 1), 0)::text AS charged_vat,
               coalesce(sum(amount) FILTER (WHERE checks = 1), 0)::text AS charged,
               coalesce(-sum(ex_vat) FILTER (WHERE returns = 1), 0)::text AS returned_ex_vat,
               coalesce(-sum(vat) FILTER (WHERE returns = 1), 0)::text AS returned_vat,
               coalesce(-sum(amount) FILTER (WHERE returns = 1), 0)::text AS returned
          FROM docs GROUP BY 1 ORDER BY 1`);
      const { rows: [ledger] } = await db.execute<Row>(sql`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS net
          FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.journal_entry_id
         WHERE a.system_key = 'SERVICE_CHARGE_PAYABLE' AND e.source_id IN (
           SELECT id FROM sales WHERE branch_id = ${w.branchId} AND completed_at >= ${w.start} AND completed_at < ${w.end}
           UNION ALL
           SELECT id FROM sale_returns WHERE branch_id = ${w.branchId} AND created_at >= ${w.start} AND created_at < ${w.end})`);

      const part = (r: Row, p: 'charged' | 'returned') => ({ exVat: money(r[`${p}_ex_vat`] as string), vat: money(r[`${p}_vat`] as string), amountDue: money(r[p] as string) });
      const net = (r: Row) => ({
        exVat: dec(r.charged_ex_vat).minus(dec(r.returned_ex_vat)).toFixed(2),
        vat: dec(r.charged_vat).minus(dec(r.returned_vat)).toFixed(2),
        amountDue: dec(r.charged).minus(dec(r.returned)).toFixed(2),
      });
      const cols = ['base', 'charged_ex_vat', 'charged_vat', 'charged', 'returned_ex_vat', 'returned_vat', 'returned'];
      const total: Row = Object.fromEntries(cols.map((c) => [c, rows.reduce((a, r) => a.plus(dec(r[c])), ZERO).toString()]));
      const totalNet = net(total);
      return {
        days: rows.map((r) => ({ day: r.day, checks: r.checks, returns: r.returns, base: money(r.base as string), charged: part(r, 'charged'), returned: part(r, 'returned'), net: net(r) })),
        totals: {
          checks: rows.reduce((a, r) => a + (r.checks as number), 0),
          returns: rows.reduce((a, r) => a + (r.returns as number), 0),
          base: money(total.base as string),
          charged: part(total, 'charged'),
          returned: part(total, 'returned'),
          net: totalNet,
        },
        distributable: totalNet.exVat,
        ledger: money(ledger!.net as string),
      };
    });
  }
}
