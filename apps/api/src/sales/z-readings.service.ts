import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, branches, cashierSessions, desc, eq, sql, zReadings, Z_READING_NOTE, type Database, type ZReadingRow } from '@1pos/database';
import { toDec } from '@1pos/money';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';
import { refundParts } from '../reports/refund-parts.js';
import { registerScope } from './cash.service.js';

const BUCKETS = ['gross', 'discount', 'statutory_discount', 'vat_exemption_amount', 'vatable_sales', 'vat_amount', 'vat_exempt_sales', 'zero_rated_sales', 'percentage_tax_sales', 'amount_due'] as const;
const money = (v: string | null | undefined) => toDec(v ?? '0').toFixed(2);

/**
 * Z-readings (session 16; fiscal gate G2 — **not BIR-accredited**): the end-of-day reading of one
 * register for one local business day, once, in day order, numbered per register, with the
 * accumulated grand total carried forward (previous + the day's net; never reset). Taken when no
 * shift is open on the register, so the day cannot change under it.
 */
@Injectable()
export class ZReadingsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    z_readings_day_unique: ['Z_READING_EXISTS', 'This register already has its Z-reading for that day'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  create(auth: AuthContext, registerId: string, day: string) {
    return this.mutate(auth, async (db) => {
      const { register, scope } = await registerScope(db, registerId);
      this.assertCan(auth, 'cash.reconcile', scope);
      // One reading at a time per register: the number and the grand total follow the last one.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`z-reading:${register.id}`}, 0))`);
      const [branch] = await db.select({ timezone: branches.timezone }).from(branches).where(eq(branches.id, register.branchId));
      const { rows: [w] } = await db.execute<{ start: string; end: string; today: string }>(sql`
        SELECT (${day}::date::timestamp AT TIME ZONE ${branch!.timezone})::text AS start,
               ((${day}::date + 1)::timestamp AT TIME ZONE ${branch!.timezone})::text AS end,
               (now() AT TIME ZONE ${branch!.timezone})::date::text AS today`);
      if (day > w!.today) throw unprocessable('DAY_NOT_STARTED', 'That day has not started yet', { today: w!.today });
      const [open] = await db.select({ id: cashierSessions.id }).from(cashierSessions).where(and(eq(cashierSessions.registerId, register.id), eq(cashierSessions.status, 'OPEN')));
      if (open) throw new AppError('SHIFT_OPEN', 'Close the open shift on this register before its Z-reading', HttpStatus.CONFLICT, { cashierSessionId: open.id });
      const [last] = await db.select().from(zReadings).where(eq(zReadings.registerId, register.id)).orderBy(desc(zReadings.zNumber)).limit(1);
      if (last && String(last.businessDay) >= day) {
        throw new AppError('Z_READING_ORDER', last.businessDay === day ? 'This register already has its Z-reading for that day' : `This register's last Z-reading is for ${last.businessDay}; readings go forward`, HttpStatus.CONFLICT, { lastDay: last.businessDay, id: last.id });
      }

      const { rows: [s] } = await db.execute<Record<string, string | number | null>>(sql`
        SELECT count(*)::int AS sales_count, min(sale_number)::bigint AS first_number, max(sale_number)::bigint AS last_number,
               ${sql.join(BUCKETS.map((b) => sql`coalesce(sum(${sql.identifier(b)}), 0)::text AS ${sql.identifier(b)}`), sql`, `)}
          FROM sales WHERE register_id = ${register.id} AND completed_at >= ${w!.start}::timestamptz AND completed_at < ${w!.end}::timestamptz`);
      const { rows: [r] } = await db.execute<{ returns_count: number; returns: string; voids_count: number; voids: string }>(sql`
        SELECT count(*) FILTER (WHERE kind = 'RETURN')::int AS returns_count, coalesce(sum(amount_due) FILTER (WHERE kind = 'RETURN'), 0)::text AS returns,
               count(*) FILTER (WHERE kind = 'VOID')::int AS voids_count, coalesce(sum(amount_due) FILTER (WHERE kind = 'VOID'), 0)::text AS voids
          FROM sale_returns WHERE register_id = ${register.id} AND created_at >= ${w!.start}::timestamptz AND created_at < ${w!.end}::timestamptz`);
      const { rows: tenders } = await db.execute<{ method: string; amount: string }>(sql`
        SELECT method, sum(amount)::text AS amount FROM (
          SELECT t.method, t.amount FROM sale_tenders t JOIN sales x ON x.id = t.sale_id
           WHERE x.register_id = ${register.id} AND x.completed_at >= ${w!.start}::timestamptz AND x.completed_at < ${w!.end}::timestamptz
          UNION ALL
          SELECT method, -amount FROM (${refundParts(sql`r.register_id = ${register.id} AND r.created_at >= ${w!.start}::timestamptz AND r.created_at < ${w!.end}::timestamptz`)}) rp) m
         GROUP BY method ORDER BY method`);
      const { rows: schemes } = await db.execute<{ scheme: string; discount: string }>(sql`
        SELECT scheme, sum(discount)::text AS discount FROM (
          SELECT b.scheme_code AS scheme, l.statutory_discount AS discount
            FROM sale_lines l JOIN sale_beneficiaries b ON b.id = l.beneficiary_id JOIN sales x ON x.id = l.sale_id
           WHERE x.register_id = ${register.id} AND x.completed_at >= ${w!.start}::timestamptz AND x.completed_at < ${w!.end}::timestamptz
          UNION ALL
          SELECT b.scheme_code, -rl.statutory_discount
            FROM sale_return_lines rl JOIN sale_returns rr ON rr.id = rl.sale_return_id JOIN sale_lines l ON l.id = rl.sale_line_id
            JOIN sale_beneficiaries b ON b.id = l.beneficiary_id
           WHERE rr.register_id = ${register.id} AND rr.created_at >= ${w!.start}::timestamptz AND rr.created_at < ${w!.end}::timestamptz) d
         GROUP BY scheme ORDER BY scheme`);

      const net = toDec(s!.amount_due as string).minus(r!.returns).minus(r!.voids);
      const previous = toDec(last?.grandTotal ?? '0');
      const [row] = await db
        .insert(zReadings)
        .values({
          tenantId: tenantOf(auth).tenantId, branchId: register.branchId, registerId: register.id, businessDay: day, zNumber: (last?.zNumber ?? 0) + 1,
          firstSaleNumber: s!.first_number === null ? null : Number(s!.first_number), lastSaleNumber: s!.last_number === null ? null : Number(s!.last_number),
          salesCount: s!.sales_count as number,
          gross: s!.gross as string, discount: s!.discount as string, statutoryDiscount: s!.statutory_discount as string,
          vatExemptionAmount: s!.vat_exemption_amount as string, vatableSales: s!.vatable_sales as string, vatAmount: s!.vat_amount as string,
          vatExemptSales: s!.vat_exempt_sales as string, zeroRatedSales: s!.zero_rated_sales as string, percentageTaxSales: s!.percentage_tax_sales as string,
          salesAmount: s!.amount_due as string, returnsCount: r!.returns_count, returnsAmount: r!.returns, voidsCount: r!.voids_count, voidsAmount: r!.voids,
          netAmount: net.toString(), previousGrandTotal: previous.toString(), grandTotal: previous.plus(net).toString(),
          tenders: Object.fromEntries(tenders.map((x) => [x.method, x.amount])), statutory: Object.fromEntries(schemes.map((x) => [x.scheme, x.discount])),
          createdBy: auth.userId,
        })
        .returning();
      await this.audit(db, auth, 'z_reading.taken', 'z_reading', row!.id, { registerId: register.id, day, zNumber: row!.zNumber, grandTotal: money(row!.grandTotal) });
      await emitEvent(db, { tenantId: row!.tenantId, topic: 'z_reading.taken', payload: { zReadingId: row!.id, registerId: register.id, day }, correlationId: auth.correlationId });
      return this.view(row!);
    });
  }

  list(auth: AuthContext, registerId: string) {
    return this.read(auth, async (db) => {
      const { register, scope } = await registerScope(db, registerId);
      if (!this.can(auth, 'cash.reconcile', scope)) this.assertCan(auth, 'reports.read', scope);
      const rows = await db.select().from(zReadings).where(eq(zReadings.registerId, register.id)).orderBy(desc(zReadings.zNumber)).limit(400);
      return { data: rows.map((x) => this.view(x)) };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db: Database) => {
      const [row] = await db.select().from(zReadings).where(eq(zReadings.id, id));
      if (!row) throw notFound('Z-reading');
      const { register, scope } = await registerScope(db, row.registerId);
      if (!this.can(auth, 'cash.reconcile', scope)) this.assertCan(auth, 'reports.read', scope);
      return { ...this.view(row), register: { id: register.id, code: register.code, name: register.name } };
    });
  }

  private view(z: ZReadingRow) {
    const m = (v: string) => money(v);
    return {
      id: z.id, branchId: z.branchId, registerId: z.registerId, businessDay: String(z.businessDay), zNumber: z.zNumber, resetCounter: z.resetCounter,
      firstSaleNumber: z.firstSaleNumber, lastSaleNumber: z.lastSaleNumber, salesCount: z.salesCount,
      gross: m(z.gross), discount: m(z.discount), statutoryDiscount: m(z.statutoryDiscount), vatExemptionAmount: m(z.vatExemptionAmount),
      vatableSales: m(z.vatableSales), vatAmount: m(z.vatAmount), vatExemptSales: m(z.vatExemptSales), zeroRatedSales: m(z.zeroRatedSales),
      percentageTaxSales: m(z.percentageTaxSales), salesAmount: m(z.salesAmount),
      returnsCount: z.returnsCount, returnsAmount: m(z.returnsAmount), voidsCount: z.voidsCount, voidsAmount: m(z.voidsAmount),
      netAmount: m(z.netAmount), previousGrandTotal: m(z.previousGrandTotal), grandTotal: m(z.grandTotal),
      tenders: Object.fromEntries(Object.entries(z.tenders).map(([k, v]) => [k, m(v)])),
      statutory: Object.fromEntries(Object.entries(z.statutory).map(([k, v]) => [k, m(v)])),
      createdBy: z.createdBy, createdAt: z.createdAt.toISOString(),
      note: Z_READING_NOTE,
    };
  }
}
