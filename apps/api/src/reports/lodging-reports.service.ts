import { Inject, Injectable } from '@nestjs/common';
import { legalEntities, eq, sql } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { GuestLedgerQuery } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound } from '../common/tenant-service.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { money, ReportsService, type ReportRange, type Row } from './reports.service.js';

const dec = (v: unknown) => toDec(String((v as string | number | null) ?? '0'));
const ratio = (a: Dec, b: Dec, scale = 2) => (b.isZero() ? null : a.dividedBy(b).toFixed(scale));

/**
 * Lodging reports (ADR-0023 §12), every plan, `reports.read`: occupancy and room revenue per night,
 * the guest ledger and deposits held beside the books, and the local accommodation tax per month.
 * Nights count on their own date (the branch's calendar), reversals on the night they undo.
 */
@Injectable()
export class LodgingReportsService extends ReportsService {
  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /**
   * Per night of the range: rooms available (active, not blocked that night), rooms sold (nights charged,
   * net of reversals), occupancy %, room revenue ex VAT (after SC/PWD), ADR and RevPAR.
   */
  occupancy(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        WITH nights AS (SELECT d::date AS day FROM generate_series(${range.from}::date::timestamp, ${range.to}::date::timestamp, interval '1 day') AS d),
             sold AS (
               SELECT e.night_date AS day,
                      sum(CASE WHEN e.kind = 'ROOM_NIGHT' THEN 1 ELSE -1 END)::int AS rooms,
                      sum(e.vatable_sales + e.vat_exempt_sales + e.zero_rated_sales + e.percentage_tax_sales - e.statutory_discount) AS revenue
                 FROM folio_entries e JOIN folios f ON f.id = e.folio_id
                WHERE f.branch_id = ${w.branchId} AND e.night_date BETWEEN ${range.from}::date AND ${range.to}::date
                  AND (e.kind = 'ROOM_NIGHT' OR (e.kind = 'NIGHT_REVERSAL' AND e.vatable_sales IS NOT NULL))
                GROUP BY 1)
        SELECT n.day::text AS day,
               (SELECT count(*) FROM rooms r WHERE r.branch_id = ${w.branchId} AND r.archived_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM room_blocks b WHERE b.room_id = r.id AND b.starts_on <= n.day AND b.ends_on > n.day))::int AS available,
               coalesce(s.rooms, 0)::int AS sold, coalesce(s.revenue, 0)::text AS revenue
          FROM nights n LEFT JOIN sold s ON s.day = n.day ORDER BY 1`);
      const days = rows.map((r) => {
        const available = new Dec(r.available as number);
        const sold = new Dec(r.sold as number);
        const revenue = dec(r.revenue);
        return {
          day: r.day, roomsAvailable: r.available, roomsSold: r.sold, occupancyPercent: ratio(sold.times(100), available), roomRevenueExVat: money(r.revenue as string),
          adr: ratio(revenue, sold), revpar: ratio(revenue, available),
        };
      });
      const available = rows.reduce((a, r) => a.plus(r.available as number), new Dec(0));
      const sold = rows.reduce((a, r) => a.plus(r.sold as number), new Dec(0));
      const revenue = rows.reduce((a, r) => a.plus(dec(r.revenue)), new Dec(0));
      return {
        days,
        totals: { roomsAvailable: available.toNumber(), roomsSold: sold.toNumber(), occupancyPercent: ratio(sold.times(100), available), roomRevenueExVat: revenue.toFixed(2), adr: ratio(revenue, sold), revpar: ratio(revenue, available) },
      };
    });
  }

  /** Open folios with their balance, and deposits held, per legal entity, beside GL 1150 and GL 2320. */
  guestLedger(auth: AuthContext, q: GuestLedgerQuery) {
    return this.read(auth, async (db) => {
      const [entity] = await db.select().from(legalEntities).where(eq(legalEntities.id, q.legalEntityId));
      if (!entity) throw notFound('Legal entity');
      this.assertCan(auth, 'reports.read', { legalEntityId: entity.id });
      const { rows: open } = await db.execute<Row>(sql`
        SELECT f.id AS folio_id, f.status, s.id AS stay_id, s.status AS stay_status, s.branch_id, r.number AS room_number,
               s.arrival_date::text AS arrival_date, s.departure_date::text AS departure_date,
               coalesce((SELECT g.full_name FROM stay_guests g WHERE g.stay_id = s.id AND g.is_primary), s.guest_name, c.display_name) AS guest_name,
               (SELECT coalesce(sum(e.amount), 0) FROM folio_entries e WHERE e.folio_id = f.id)::text AS balance
          FROM folios f JOIN stays s ON s.id = f.stay_id JOIN rooms r ON r.id = s.room_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE f.legal_entity_id = ${entity.id} AND f.status = 'OPEN'
         ORDER BY r.number`);
      const { rows: held } = await db.execute<Row>(sql`
        SELECT d.stay_id, s.status AS stay_status, r.number AS room_number, s.arrival_date::text AS arrival_date, sum(d.amount)::text AS held
          FROM stay_deposits d JOIN stays s ON s.id = d.stay_id JOIN rooms r ON r.id = s.room_id
         WHERE d.legal_entity_id = ${entity.id} GROUP BY 1, 2, 3, 4 HAVING sum(d.amount) <> 0 ORDER BY 4, 3`);
      const gl = async (key: string) =>
        (await db.execute<{ v: string }>(sql`
          SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
           WHERE a.legal_entity_id = ${entity.id} AND a.system_key = ${key}`)).rows[0]!.v;
      const folioTotal = open.reduce((a, r) => a.plus(dec(r.balance)), new Dec(0));
      const depositTotal = held.reduce((a, r) => a.plus(dec(r.held)), new Dec(0));
      const ledger = dec(await gl('GUEST_LEDGER'));
      const deposits = dec(await gl('GUEST_DEPOSITS')).negated();
      // Settled folios are at zero, so every open balance is all the guest ledger holds.
      return {
        legalEntityId: entity.id,
        folios: open.map((r) => ({
          folioId: r.folio_id, stayId: r.stay_id, stayStatus: r.stay_status, branchId: r.branch_id, roomNumber: r.room_number, guestName: r.guest_name,
          arrivalDate: r.arrival_date, departureDate: r.departure_date, balance: money(r.balance as string),
        })),
        deposits: held.map((r) => ({ stayId: r.stay_id, stayStatus: r.stay_status, roomNumber: r.room_number, arrivalDate: r.arrival_date, held: money(r.held as string) })),
        totals: {
          folios: folioTotal.toFixed(2), guestLedgerGl: ledger.toFixed(2), guestLedgerDifference: folioTotal.minus(ledger).toFixed(2),
          deposits: depositTotal.toFixed(2), guestDepositsGl: deposits.toFixed(2), depositsDifference: depositTotal.minus(deposits).toFixed(2),
        },
      };
    });
  }

  /** The local accommodation tax per month (§10): its base (nights' net ex VAT) and the tax, net of reversals. */
  accommodationTax(auth: AuthContext, range: ReportRange) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Row>(sql`
        SELECT to_char(e.night_date, 'YYYY-MM') AS month, count(*) FILTER (WHERE e.kind = 'ACCOMMODATION_TAX')::int AS nights,
               sum(CASE WHEN e.kind = 'ACCOMMODATION_TAX' THEN (e.tax_snapshot->>'base')::numeric
                        ELSE -(SELECT (t.tax_snapshot->>'base')::numeric FROM folio_entries t WHERE t.id = e.related_entry_id) END)::text AS base,
               sum(e.amount)::text AS tax
          FROM folio_entries e JOIN folios f ON f.id = e.folio_id
         WHERE f.branch_id = ${w.branchId} AND e.night_date BETWEEN ${range.from}::date AND ${range.to}::date
           AND (e.kind = 'ACCOMMODATION_TAX' OR (e.kind = 'NIGHT_REVERSAL' AND EXISTS (SELECT 1 FROM folio_entries t WHERE t.id = e.related_entry_id AND t.kind = 'ACCOMMODATION_TAX')))
         GROUP BY 1 ORDER BY 1`);
      const { rows: [settings] } = await db.execute<Row>(sql`SELECT accommodation_tax_rate::text AS rate FROM lodging_settings WHERE branch_id = ${w.branchId}`);
      return {
        rate: settings?.rate ? toDec(settings.rate as string).toString() : null,
        data: rows.map((r) => ({ month: r.month, nights: r.nights, base: money(r.base as string), tax: money(r.tax as string) })),
        totals: { base: rows.reduce((a, r) => a.plus(dec(r.base)), new Dec(0)).toFixed(2), tax: rows.reduce((a, r) => a.plus(dec(r.tax)), new Dec(0)).toFixed(2) },
      };
    });
  }
}
