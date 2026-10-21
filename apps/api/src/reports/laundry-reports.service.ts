import { Inject, Injectable } from '@nestjs/common';
import { eq, legalEntities, sql } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { JobOrderDepositsQuery } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound } from '../common/tenant-service.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { money, ReportsService, type ReportRange, type Row } from './reports.service.js';

const dec = (v: unknown) => toDec(String((v as string | number | null) ?? '0'));
const ratio = (a: Dec, b: Dec, scale = 2) => (b.isZero() ? null : a.dividedBy(b).toFixed(scale));
const jobRef = (n: unknown) => `J-${String(n).padStart(6, '0')}`;

/**
 * Laundry reports (ADR-0024 §13), every plan, `reports.read`: job orders and turnaround per day, kilos
 * and loads by service, machine usage, down payments held beside the books with unclaimed laundry, and
 * pickups and deliveries. Days are the branch's calendar. Claim sales are ordinary sales elsewhere.
 */
@Injectable()
export class LaundryReportsService extends ReportsService {
  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /**
   * Per day: jobs received, made ready, claimed, cancelled and disposed of; the average turnaround
   * (received → ready, hours) and the share ready by the promised time of those made ready that day;
   * the jobs overdue now; kilos and loads by service of the jobs received in the range.
   */
  jobOrders(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH days AS (SELECT d::date AS day FROM generate_series(${range.from}::date::timestamp, ${range.to}::date::timestamp, interval '1 day') AS d),
             j AS (SELECT * FROM job_orders WHERE branch_id = ${w.branchId})
        SELECT d.day::text AS day,
               (SELECT count(*) FROM j WHERE (j.created_at AT TIME ZONE ${w.tz})::date = d.day)::int AS received,
               (SELECT count(*) FROM j WHERE (j.ready_at AT TIME ZONE ${w.tz})::date = d.day)::int AS ready,
               (SELECT count(*) FROM j WHERE (j.claimed_at AT TIME ZONE ${w.tz})::date = d.day)::int AS claimed,
               (SELECT count(*) FROM j WHERE (j.cancelled_at AT TIME ZONE ${w.tz})::date = d.day)::int AS cancelled,
               (SELECT count(*) FROM j WHERE (j.disposed_at AT TIME ZONE ${w.tz})::date = d.day)::int AS disposed,
               (SELECT avg(extract(epoch FROM j.ready_at - j.created_at) / 3600) FROM j WHERE (j.ready_at AT TIME ZONE ${w.tz})::date = d.day)::text AS turnaround_hours,
               (SELECT count(*) FROM j WHERE (j.ready_at AT TIME ZONE ${w.tz})::date = d.day AND j.ready_at <= j.promised_at)::int AS on_time
          FROM days d ORDER BY 1`);
      const { rows: services } = await db.execute<Row>(sql`
        SELECT l.variant_id, l.name, l.laundry_unit, sum(l.measured_quantity)::text AS measured, sum(l.quantity)::text AS billed, count(DISTINCT l.job_order_id)::int AS jobs,
               sum(l.amount_due)::text AS amount
          FROM job_order_lines l JOIN job_orders j ON j.id = l.job_order_id
         WHERE j.branch_id = ${w.branchId} AND j.created_at >= ${w.start}::timestamptz AND j.created_at < ${w.end}::timestamptz
           AND l.laundry_unit IS NOT NULL AND j.status <> 'CANCELLED'
         GROUP BY 1, 2, 3 ORDER BY 3, 2`);
      const { rows: [now] } = await db.execute<Row>(sql`
        SELECT count(*) FILTER (WHERE promised_at < now() AND status IN ('RECEIVED','WASHING','DRYING','FOLDING'))::int AS overdue,
               count(*) FILTER (WHERE status NOT IN ('CLAIMED','CANCELLED','DISPOSED'))::int AS open
          FROM job_orders WHERE branch_id = ${w.branchId}`);
      const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
      const ready = sum('ready');
      const weighted = rows.reduce((a, r) => a.plus(r.turnaround_hours ? dec(r.turnaround_hours).times(Number(r.ready)) : 0), new Dec(0));
      return {
        days: rows.map((r) => ({
          day: r.day, received: r.received, ready: r.ready, claimed: r.claimed, cancelled: r.cancelled, disposed: r.disposed,
          averageTurnaroundHours: r.turnaround_hours ? dec(r.turnaround_hours).toFixed(1) : null,
          onTimePercent: ratio(new Dec(Number(r.on_time)).times(100), new Dec(Number(r.ready)), 1),
        })),
        services: services.map((s) => ({
          variantId: s.variant_id, name: s.name, unit: s.laundry_unit, measured: dec(s.measured).toString(), billed: dec(s.billed).toString(), jobs: s.jobs, amount: money(s.amount as string),
        })),
        totals: {
          received: sum('received'), ready, claimed: sum('claimed'), cancelled: sum('cancelled'), disposed: sum('disposed'),
          averageTurnaroundHours: ready ? weighted.dividedBy(ready).toFixed(1) : null,
          onTimePercent: ratio(new Dec(sum('on_time')).times(100), new Dec(ready), 1),
          kilos: services.filter((s) => s.laundry_unit === 'KG').reduce((a, s) => a.plus(dec(s.measured)), new Dec(0)).toString(),
          loads: services.filter((s) => s.laundry_unit === 'LOAD').reduce((a, s) => a.plus(dec(s.billed)), new Dec(0)).toString(),
          overdueNow: now!.overdue, openNow: now!.open,
        },
      };
    });
  }

  /**
   * Per machine: cycles and minutes run in the range (self-service and drop-off loads apart), the share
   * of the range's hours it ran, and what self-service cycles on it sold. A run counts on the day it started.
   */
  machineUsage(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT m.id, m.kind, m.label, m.archived_at IS NOT NULL AS archived,
               count(r.id) FILTER (WHERE r.source = 'SELF_SERVICE')::int AS self_cycles,
               count(r.id) FILTER (WHERE r.source = 'JOB')::int AS job_cycles,
               coalesce(sum(extract(epoch FROM coalesce(r.stopped_at, r.ends_at) - r.started_at) / 60) FILTER (WHERE r.source = 'SELF_SERVICE'), 0)::int AS self_minutes,
               coalesce(sum(extract(epoch FROM coalesce(r.stopped_at, r.ends_at) - r.started_at) / 60) FILTER (WHERE r.source = 'JOB'), 0)::int AS job_minutes,
               (SELECT coalesce(sum(l.amount_due), 0) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                 WHERE l.machine_id = m.id AND s.completed_at >= ${w.start}::timestamptz AND s.completed_at < ${w.end}::timestamptz)::text AS self_sales
          FROM laundry_machines m
          LEFT JOIN machine_runs r ON r.machine_id = m.id AND r.started_at >= ${w.start}::timestamptz AND r.started_at < ${w.end}::timestamptz
         WHERE m.branch_id = ${w.branchId}
         GROUP BY m.id ORDER BY m.kind DESC, lower(m.label)`);
      const { rows: [span] } = await db.execute<Row>(sql`SELECT (extract(epoch FROM ${w.end}::timestamptz - ${w.start}::timestamptz) / 60)::int AS minutes`);
      const available = new Dec(Number(span!.minutes));
      return {
        machines: rows.map((r) => {
          const minutes = Number(r.self_minutes) + Number(r.job_minutes);
          return {
            machineId: r.id, kind: r.kind, label: r.label, archived: r.archived,
            selfServiceCycles: r.self_cycles, dropOffCycles: r.job_cycles, selfServiceMinutes: r.self_minutes, dropOffMinutes: r.job_minutes,
            utilisationPercent: ratio(new Dec(minutes).times(100), available, 1), selfServiceSales: money(r.self_sales as string),
          };
        }),
        totals: {
          selfServiceCycles: rows.reduce((a, r) => a + Number(r.self_cycles), 0),
          dropOffCycles: rows.reduce((a, r) => a + Number(r.job_cycles), 0),
          selfServiceSales: rows.reduce((a, r) => a.plus(dec(r.self_sales)), new Dec(0)).toFixed(2),
        },
      };
    });
  }

  /**
   * Down payments held on open jobs per legal entity, beside GL 2330; the laundry unclaimed now (READY
   * beyond the branch's unclaimed days) with its value; what was kept from disposed or cancelled jobs.
   */
  jobOrderDeposits(auth: AuthContext, q: JobOrderDepositsQuery) {
    return this.read(auth, async (db) => {
      const [entity] = await db.select().from(legalEntities).where(eq(legalEntities.id, q.legalEntityId));
      if (!entity) throw notFound('Legal entity');
      this.assertCan(auth, 'reports.read', { legalEntityId: entity.id });
      const { rows: held } = await db.execute<Row>(sql`
        SELECT j.id, j.number, j.branch_id, j.status, coalesce(c.display_name, j.customer_name) AS customer, j.amount_due::text AS amount_due, sum(d.amount)::text AS held
          FROM job_order_deposits d JOIN job_orders j ON j.id = d.job_order_id LEFT JOIN customers c ON c.id = j.customer_id
         WHERE d.legal_entity_id = ${entity.id} GROUP BY j.id, c.display_name HAVING sum(d.amount) <> 0 ORDER BY j.created_at`);
      const { rows: unclaimed } = await db.execute<Row>(sql`
        SELECT j.id, j.number, j.branch_id, coalesce(c.display_name, j.customer_name) AS customer, j.ready_at, j.amount_due::text AS amount_due,
               (SELECT coalesce(sum(d.amount), 0) FROM job_order_deposits d WHERE d.job_order_id = j.id)::text AS held,
               (now()::date - j.ready_at::date)::int AS days_waiting,
               EXISTS (SELECT 1 FROM job_order_notices n WHERE n.job_order_id = j.id AND n.kind = 'FINAL') AS final_notice
          FROM job_orders j LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN laundry_settings s ON s.branch_id = j.branch_id
         WHERE j.legal_entity_id = ${entity.id} AND j.status = 'READY' AND j.ready_at + make_interval(days => coalesce(s.unclaimed_days, 30)) <= now()
         ORDER BY j.ready_at`);
      const { rows: [kept] } = await db.execute<Row>(sql`
        SELECT coalesce(-sum(amount), 0)::text AS amount, count(*)::int AS jobs FROM job_order_deposits WHERE legal_entity_id = ${entity.id} AND kind = 'FORFEITED'`);
      const { rows: [gl] } = await db.execute<Row>(sql`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE a.legal_entity_id = ${entity.id} AND a.system_key = 'CUSTOMER_DOWN_PAYMENTS'`);
      const total = held.reduce((a, r) => a.plus(dec(r.held)), new Dec(0));
      const books = dec(gl!.v);
      return {
        legalEntityId: entity.id,
        held: held.map((r) => ({ jobOrderId: r.id, reference: jobRef(r.number), branchId: r.branch_id, status: r.status, customer: r.customer, amountDue: money(r.amount_due as string), held: money(r.held as string) })),
        unclaimed: unclaimed.map((r) => ({
          jobOrderId: r.id, reference: jobRef(r.number), branchId: r.branch_id, customer: r.customer, readyAt: r.ready_at, daysWaiting: r.days_waiting,
          amountDue: money(r.amount_due as string), held: money(r.held as string), finalNoticeSent: r.final_notice,
        })),
        forfeited: { amount: money(kept!.amount as string), entries: kept!.jobs },
        totals: { held: total.toFixed(2), customerDownPaymentsGl: books.toFixed(2), difference: total.minus(books).toFixed(2), unclaimedValue: unclaimed.reduce((a, r) => a.plus(dec(r.amount_due)), new Dec(0)).toFixed(2) },
      };
    });
  }

  /** Pickups and deliveries per day (scheduled day, else the day they were booked): done, failed, cancelled, and delivery fees on claimed jobs. */
  deliveries(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT (coalesce(t.window_start, t.created_at) AT TIME ZONE ${w.tz})::date::text AS day, t.kind,
               count(*)::int AS trips,
               count(*) FILTER (WHERE t.status = 'DONE')::int AS done,
               count(*) FILTER (WHERE t.status = 'FAILED')::int AS failed,
               count(*) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
               count(*) FILTER (WHERE t.status = 'SCHEDULED')::int AS scheduled
          FROM job_order_trips t
         WHERE t.branch_id = ${w.branchId} AND coalesce(t.window_start, t.created_at) >= ${w.start}::timestamptz AND coalesce(t.window_start, t.created_at) < ${w.end}::timestamptz
         GROUP BY 1, 2 ORDER BY 1, 2`);
      const { rows: [fees] } = await db.execute<Row>(sql`
        SELECT coalesce(sum(l.amount_due), 0)::text AS amount, count(DISTINCT j.id)::int AS jobs
          FROM job_orders j JOIN job_order_lines l ON l.job_order_id = j.id JOIN laundry_settings s ON s.branch_id = j.branch_id AND s.delivery_variant_id = l.variant_id
         WHERE j.branch_id = ${w.branchId} AND j.status = 'CLAIMED' AND j.claimed_at >= ${w.start}::timestamptz AND j.claimed_at < ${w.end}::timestamptz`);
      return {
        days: rows.map((r) => ({ day: r.day, kind: r.kind, trips: r.trips, done: r.done, failed: r.failed, cancelled: r.cancelled, scheduled: r.scheduled })),
        totals: {
          trips: rows.reduce((a, r) => a + Number(r.trips), 0), done: rows.reduce((a, r) => a + Number(r.done), 0), failed: rows.reduce((a, r) => a + Number(r.failed), 0),
          deliveryFees: money(fees!.amount as string), deliveredJobsWithFee: fees!.jobs,
        },
      };
    });
  }
}
