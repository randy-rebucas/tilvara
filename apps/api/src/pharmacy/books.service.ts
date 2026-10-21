import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { branches, eq, sql, type Database } from '@1pos/database';
import { toDec } from '@1pos/money';
import type { ReportRangeQuery } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { piecesPerUnit } from './drugs.js';

interface Window {
  branchId: string;
  tz: string;
  start: string;
  end: string;
}

const qty = (v: string | null) => toDec(v ?? '0').toString();

/**
 * The pharmacy's books (ADR-0025 §10), for printing and filing: every dispensing against a prescription,
 * and the dangerous drugs register (opening, in, out, closing per drug, with each dispensing's yellow
 * form). Health data: `pharmacy.read` at the branch, not `reports.read`.
 */
@Injectable()
export class PharmacyBooksService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  /** Every fill (and give-back) in the period, oldest first. */
  prescriptionBook(auth: AuthContext, range: ReportRangeQuery) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Record<string, string | number | boolean | null>>(sql`
        SELECT f.created_at, (f.created_at AT TIME ZONE ${w.tz})::date::text AS day, r.code || '-' || lpad(s.sale_number::text, 6, '0') AS sale_reference, f.sale_id,
               p.id AS prescription_id, p.patient_name, p.prescriber_name, p.prescriber_license_no, p.prescriber_s2_no, p.yellow_form_no, p.issued_on::text,
               i.generic_name, i.strength, i.dosage_form, i.drug_class, concat_ws(' ', pr.name, v.name) AS brand, f.quantity::text,
               f.sale_return_line_id IS NOT NULL AS returned, f.needs_review, u.display_name AS pharmacist
          FROM prescription_fills f
          JOIN prescriptions p ON p.id = f.prescription_id
          JOIN prescription_items i ON i.id = f.prescription_item_id
          JOIN sales s ON s.id = f.sale_id JOIN registers r ON r.id = s.register_id
          JOIN product_variants v ON v.id = f.variant_id JOIN products pr ON pr.id = v.product_id
          LEFT JOIN users u ON u.id = f.dispensed_by
         WHERE f.branch_id = ${w.branchId} AND f.created_at >= ${w.start} AND f.created_at < ${w.end}
         ORDER BY f.created_at, f.id`);
      return {
        data: rows.map((r) => ({
          day: r.day, saleReference: r.sale_reference, saleId: r.sale_id, prescriptionId: r.prescription_id, patientName: r.patient_name,
          prescriberName: r.prescriber_name, prescriberLicenseNo: r.prescriber_license_no, prescriberS2No: r.prescriber_s2_no, yellowFormNo: r.yellow_form_no,
          issuedOn: r.issued_on, genericName: r.generic_name, strength: r.strength, dosageForm: r.dosage_form, drugClass: r.drug_class, brand: r.brand,
          quantity: qty(r.quantity as string), returned: r.returned, needsReview: r.needs_review, pharmacist: r.pharmacist,
        })),
      };
    });
  }

  /**
   * Dangerous drugs register: for each item now classed DANGEROUS, the branch's stock at the start, what
   * came in, was dispensed, came back, was written off or otherwise moved, and the closing stock (= the
   * stock ledger); and each dispensing with its yellow form, patient and prescriber.
   */
  dangerousDrugs(auth: AuthContext, range: ReportRangeQuery) {
    return this.run(auth, range, async (db, w) => {
      const { rows } = await db.execute<Record<string, string | null>>(sql`
        WITH dd AS (
          SELECT v.id, v.sku, concat_ws(' ', p.name, v.name) AS name, p.generic_name, p.strength, p.dosage_form
            FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.drug_class = 'DANGEROUS'),
        -- A sale's movements are dated when the sale was rung (an offline sale is delivered later).
        dm AS (
          SELECT m.variant_id, m.type, m.quantity,
                 CASE WHEN m.type IN ('SALE', 'CONSUMPTION', 'UNPACK_OUT', 'UNPACK_IN') THEN coalesce(s.completed_at, m.created_at) ELSE m.created_at END AS at
            FROM stock_movements m LEFT JOIN sales s ON s.id = m.sale_id
           WHERE m.branch_id = ${w.branchId} AND m.variant_id IN (SELECT id FROM dd)),
        mv AS (
          SELECT m.variant_id,
                 sum(m.quantity) FILTER (WHERE m.at < ${w.start}) AS opening,
                 sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type IN ('RECEIPT', 'TRANSFER_IN', 'UNPACK_IN')) AS received,
                 -sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type = 'SALE') AS dispensed,
                 sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type = 'RETURN') AS returned,
                 -sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type = 'WASTE') AS written_off,
                 sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type IN ('ADJUSTMENT', 'COUNT')) AS adjusted,
                 sum(m.quantity) FILTER (WHERE m.at >= ${w.start} AND m.at < ${w.end} AND m.type IN ('SUPPLIER_RETURN', 'TRANSFER_OUT', 'UNPACK_OUT', 'CONSUMPTION')) AS other_out,
                 sum(m.quantity) FILTER (WHERE m.at < ${w.end}) AS closing
            FROM dm m
           GROUP BY 1)
        SELECT dd.id AS variant_id, dd.sku, dd.name, dd.generic_name, dd.strength, dd.dosage_form,
               mv.opening::text, mv.received::text, mv.dispensed::text, mv.returned::text, mv.written_off::text, mv.adjusted::text, mv.other_out::text, mv.closing::text
          FROM dd LEFT JOIN mv ON mv.variant_id = dd.id
         ORDER BY dd.generic_name, dd.name`);
      // A fill is dated by its sale (an offline sale's fills are written when it is delivered); a give-back by its return.
      const { rows: dispensings } = await db.execute<Record<string, string | null>>(sql`
        SELECT (x.at AT TIME ZONE ${w.tz})::date::text AS day, x.variant_id, x.sale_reference, x.quantity::text, x.yellow_form_no, x.patient_name, x.patient_address,
               x.prescriber_name, x.prescriber_license_no, x.prescriber_s2_no, x.pharmacist
          FROM (
            SELECT CASE WHEN f.sale_return_line_id IS NULL THEN s.completed_at ELSE f.created_at END AS at, f.id, f.variant_id,
                   r.code || '-' || lpad(s.sale_number::text, 6, '0') AS sale_reference, f.quantity, p.yellow_form_no, p.patient_name, p.patient_address,
                   p.prescriber_name, p.prescriber_license_no, p.prescriber_s2_no, u.display_name AS pharmacist
              FROM prescription_fills f
              JOIN prescription_items i ON i.id = f.prescription_item_id AND i.drug_class = 'DANGEROUS'
              JOIN prescriptions p ON p.id = f.prescription_id
              JOIN sales s ON s.id = f.sale_id JOIN registers r ON r.id = s.register_id
              LEFT JOIN users u ON u.id = f.dispensed_by
             WHERE f.branch_id = ${w.branchId}) x
         WHERE x.at >= ${w.start} AND x.at < ${w.end}
         ORDER BY x.at, x.id`);
      // The register counts pieces (tablets, ampoules), as the prescriptions and their fills do: a box's
      // stock and movements are its units times the pieces per unit (its pack chain, ADR-0025 §6).
      const per = await piecesPerUnit(db, rows.map((r) => r.variant_id!));
      const pcs = (variantId: string, v: string | null) => toDec(v ?? '0').times(per.get(variantId) ?? 1).toString();
      return {
        unit: 'PIECE' as const,
        data: rows.map((r) => ({
          variantId: r.variant_id, sku: r.sku, name: r.name, genericName: r.generic_name, strength: r.strength, dosageForm: r.dosage_form,
          piecesPerUnit: (per.get(r.variant_id!) ?? toDec('1')).toString(),
          opening: pcs(r.variant_id!, r.opening ?? null), received: pcs(r.variant_id!, r.received ?? null), dispensed: pcs(r.variant_id!, r.dispensed ?? null),
          returned: pcs(r.variant_id!, r.returned ?? null), writtenOff: pcs(r.variant_id!, r.written_off ?? null), adjusted: pcs(r.variant_id!, r.adjusted ?? null),
          otherOut: pcs(r.variant_id!, r.other_out ?? null), closing: pcs(r.variant_id!, r.closing ?? null),
          dispensings: dispensings.filter((d) => d.variant_id === r.variant_id).map((d) => ({
            day: d.day, saleReference: d.sale_reference, quantity: qty(d.quantity ?? null), yellowFormNo: d.yellow_form_no, patientName: d.patient_name,
            patientAddress: d.patient_address, prescriberName: d.prescriber_name, prescriberLicenseNo: d.prescriber_license_no, prescriberS2No: d.prescriber_s2_no,
            pharmacist: d.pharmacist,
          })),
        })),
      };
    });
  }

  private run<T>(auth: AuthContext, range: ReportRangeQuery, fn: (db: Database, w: Window) => Promise<T>) {
    return this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, range.branchId));
      if (!branch) throw notFound('Branch');
      this.assertCan(auth, 'pharmacy.read', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      if (range.from > range.to) throw new AppError('VALIDATION_FAILED', '"from" must not be after "to"', HttpStatus.BAD_REQUEST);
      const { rows } = await db.execute<{ start: string; end: string }>(sql`
        SELECT (${range.from}::date::timestamp AT TIME ZONE ${branch.timezone})::text AS start,
               ((${range.to}::date + 1)::timestamp AT TIME ZONE ${branch.timezone})::text AS end`);
      const result = await fn(db, { branchId: branch.id, tz: branch.timezone, start: rows[0]!.start, end: rows[0]!.end });
      return { branchId: branch.id, timezone: branch.timezone, from: range.from, to: range.to, ...result };
    });
  }
}
