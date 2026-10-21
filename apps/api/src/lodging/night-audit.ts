import { HttpStatus } from '@nestjs/common';
import { roomChargePosting } from '@1pos/accounting';
import { and, eq, isNull, lodgingSettings, rooms, roomTypes, sql, stayBeneficiaries, type Database } from '@1pos/database';
import { Dec, roundTo, toDec, type RoundingMode } from '@1pos/money';
import { post } from '../accounting/ledger.js';
import { recordAudit } from '../audit/audit.js';
import { effectiveNow } from '../common/clock.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import type { TaxService } from '../tax/tax.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { folioOfStay, insertEntry, loadStay, lockFolio, openJournalDate, type StayRow } from './folio.js';

/** The tax buckets a folio entry keeps (signed like its amount). */
export const BUCKETS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales',
] as const;
type Bucket = (typeof BUCKETS)[number];
export type Buckets = Record<Bucket | 'amountDue', string>;

export const exVatOf = (b: Pick<Buckets, 'vatableSales' | 'vatExemptSales' | 'zeroRatedSales' | 'percentageTaxSales'>) =>
  toDec(b.vatableSales).plus(b.vatExemptSales).plus(b.zeroRatedSales).plus(b.percentageTaxSales);

export const signedBuckets = (b: Buckets, sign: 1 | -1) =>
  Object.fromEntries(BUCKETS.map((k) => [k, toDec(b[k]).times(sign).toString()])) as Record<Bucket, string>;

export interface PostNightsOptions {
  tenantId: string;
  /** The person posting (check-out, "run now"); null = the scheduled night audit (audit actor SYSTEM). */
  userId: string | null;
  correlationId?: string | null;
  /** DUE: nights whose audit time has passed; DEPARTURE: every night up to the departure date (check-out). */
  through: 'DUE' | 'DEPARTURE';
  /** Statutory discounts stay off in production until signed off (ADR-0008), as at the counter. */
  production: boolean;
}

/**
 * Charge the nights of an in-house stay that are due and not yet on its folio (§7): one ROOM_NIGHT per
 * night (unique per stay and night, so a second run or a catch-up after a lapse posts exactly what is
 * missing), priced through TaxService at the start of the night, SC/PWD for the stay's beneficiaries,
 * the branch's accommodation tax as its own entry, one journal entry per night dated the night (or the
 * first open day after it). Runs in the caller's transaction; takes the stay row and the folio lock.
 */
export async function postDueNights(db: Database, tax: TaxService, stayId: string, o: PostNightsOptions): Promise<string[]> {
  const stay = await loadStay(db, stayId, true);
  if (stay.status !== 'IN_HOUSE') return [];
  const folio = await folioOfStay(db, stay.id);
  if (!folio || folio.status !== 'OPEN') return [];
  await lockFolio(db, folio.id);

  const { rows: missing } = await db.execute<{ night: string; starts: string; tz: string }>(sql`
    WITH b AS (SELECT b.timezone AS tz, coalesce(ls.night_audit_time, time '03:00') AS audit_time
                 FROM branches b LEFT JOIN lodging_settings ls ON ls.branch_id = b.id WHERE b.id = ${stay.branchId}),
         last AS (SELECT CASE WHEN ${o.through} = 'DEPARTURE' THEN ${stay.departureDate}::date - 1
                              ELSE least(${stay.departureDate}::date - 1, ((now() AT TIME ZONE b.tz) - b.audit_time)::date - 1) END AS d,
                         b.tz FROM b)
    SELECT d.night::date::text AS night, (d.night AT TIME ZONE last.tz)::text AS starts, last.tz
      FROM last, generate_series(${stay.arrivalDate}::date::timestamp, last.d::timestamp, interval '1 day') AS d(night)
     WHERE NOT EXISTS (SELECT 1 FROM folio_entries e WHERE e.stay_id = ${stay.id} AND e.kind = 'ROOM_NIGHT' AND e.night_date = d.night::date)
     ORDER BY 1`);
  if (!missing.length) return [];

  const [[room], [type], [settings], beneficiaries] = [
    await db.select({ number: rooms.number }).from(rooms).where(eq(rooms.id, stay.roomId)),
    await db.select().from(roomTypes).where(eq(roomTypes.id, stay.roomTypeId)),
    await db.select().from(lodgingSettings).where(eq(lodgingSettings.branchId, stay.branchId)),
    await db.select().from(stayBeneficiaries).where(and(eq(stayBeneficiaries.stayId, stay.id), isNull(stayBeneficiaries.removedAt))),
  ];
  const guests = stay.adults + stay.children;
  const shares = beneficiaries.map((b) => ({ id: b.id, schemeCode: b.schemeCode, share: b.share ? toDec(b.share).toString() : new Dec(1).dividedBy(guests).toDecimalPlaces(6).toString() }));
  const rate = settings?.accommodationTaxRate ? toDec(settings.accommodationTaxRate) : new Dec(0);
  const now = await effectiveNow(db);
  const posted: string[] = [];
  for (const m of missing) {
    const charge = await tax.computeRoomCharge(db, {
      branchId: stay.branchId,
      variantId: type!.nightVariantId,
      at: new Date(m.starts),
      fallbackAt: now,
      unitPrice: stay.nightlyRate,
      beneficiaries: shares,
    });
    if (charge.requiresProfessionalReview && o.production) {
      throw unprocessable('SCHEME_PENDING_REVIEW', 'Statutory discounts are disabled until a tax professional signs off the computation (ADR-0008)');
    }
    const t = charge.totals;
    const journalDate = await openJournalDate(db, stay.legalEntityId, m.night);
    const description = `Room ${room!.number} — night of ${m.night}`;
    const night = await insertEntry(db, {
      tenantId: stay.tenantId,
      folioId: folio.id,
      stayId: stay.id,
      kind: 'ROOM_NIGHT',
      amount: t.amountDue,
      nightDate: m.night,
      description,
      ...Object.fromEntries(BUCKETS.map((k) => [k, t[k]])),
      unitPrice: charge.unitPrice,
      variantId: type!.nightVariantId,
      taxCategoryCode: charge.taxCategoryCode,
      vatTreatment: charge.vatTreatment,
      taxProfileId: charge.taxProfile.id,
      taxSnapshot: {
        vatStatus: charge.taxProfile.vatStatus, vatRate: charge.taxProfile.vatRate, roundingMode: charge.taxProfile.roundingMode,
        pricedAt: charge.at, priceId: charge.priceId, agreedRate: stay.nightlyRate !== null, priceIncludesTax: charge.priceIncludesTax,
        lines: charge.lines.map((l) => ({ id: l.id, gross: l.gross, scheme: l.snapshot.scheme ?? null, statutoryDiscount: l.statutoryDiscount, amountDue: l.amountDue })),
        beneficiaries: shares,
      },
      journalDate,
      createdBy: o.userId,
    }, o.correlationId);
    const mode = (charge.taxProfile.roundingMode ?? 'HALF_UP') as RoundingMode;
    const accommodationTax = rate.gt(0) ? roundTo(toDec(t.amountDue).minus(t.vatAmount).times(rate), 2, mode) : new Dec(0);
    if (accommodationTax.gt(0)) {
      await insertEntry(db, {
        tenantId: stay.tenantId, folioId: folio.id, stayId: stay.id, kind: 'ACCOMMODATION_TAX', amount: accommodationTax.toString(), nightDate: m.night,
        description: `Accommodation tax — night of ${m.night}`, relatedEntryId: night.id, journalDate, createdBy: o.userId,
        taxSnapshot: { rate: rate.toString(), base: toDec(t.amountDue).minus(t.vatAmount).toString() },
      }, o.correlationId);
    }
    await post(db, {
      tenantId: stay.tenantId,
      legalEntityId: stay.legalEntityId,
      branchId: stay.branchId,
      entryDate: journalDate,
      sourceType: 'FOLIO_ENTRY',
      sourceId: night.id,
      memo: description,
      lines: roomChargePosting({ exVat: exVatOf(t), vatAmount: t.vatAmount, statutoryDiscount: t.statutoryDiscount, accommodationTax }, stay.branchId),
      createdBy: o.userId ?? stay.checkedInBy ?? stay.createdBy,
    });
    posted.push(m.night);
  }
  await recordAudit(db, {
    tenantId: stay.tenantId,
    actorType: o.userId ? 'USER' : 'SYSTEM',
    actorUserId: o.userId,
    action: 'stay.nights_posted',
    resourceType: 'stay',
    resourceId: stay.id,
    correlationId: o.correlationId ?? null,
    metadata: { folioId: folio.id, nights: posted },
  });
  return posted;
}

/** In-house stays of a branch (or every branch) whose nights may be due: the night audit's work list. */
export async function inHouseStays(db: Database, branchId?: string): Promise<Pick<StayRow, 'id' | 'branchId'>[]> {
  const { rows } = await db.execute<{ id: string; branch_id: string }>(sql`
    SELECT id, branch_id FROM stays WHERE status = 'IN_HOUSE' ${branchId ? sql`AND branch_id = ${branchId}` : sql``} ORDER BY id`);
  return rows.map((r) => ({ id: r.id, branchId: r.branch_id }));
}

export const nightAuditBusy = () => new AppError('NIGHT_AUDIT_BUSY', 'The night audit is running; try again in a moment', HttpStatus.CONFLICT);
