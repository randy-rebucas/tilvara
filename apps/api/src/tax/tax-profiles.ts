import { Dec } from '@1pos/money';
import { sql, taxProfiles, type Database } from '@1pos/database';
import type { TaxProfile } from '@1pos/tax';
import { EFFECTIVE_SKEW, effectiveNowSql } from '../common/clock.js';

/** Defaults are configuration, not law (ADR-0008); a tax adviser confirms them per entity. */
export const DEFAULT_VAT_RATE = '0.12';
export const DEFAULT_PERCENTAGE_TAX_RATE = '0.03';

export interface TaxProfileView {
  id: string;
  legalEntityId: string;
  effectiveFrom: string;
  vatStatus: 'VAT' | 'NON_VAT';
  vatRate: string;
  percentageTaxRate: string;
  roundingMode: 'HALF_UP' | 'HALF_EVEN';
  note: string | null;
  createdAt: string;
}

type Row = typeof taxProfiles.$inferSelect;
type RawRow = {
  id: string;
  legal_entity_id: string;
  effective_from: string | Date;
  vat_status: 'VAT' | 'NON_VAT';
  vat_rate: string;
  percentage_tax_rate: string;
  rounding_mode: 'HALF_UP' | 'HALF_EVEN';
  note: string | null;
  created_at: string | Date;
};

const iso = (d: string | Date) => new Date(d).toISOString();
/** "0.120000" → "0.12" */
const rate = (r: string) => new Dec(r).toString();

export function profileView(r: Row | RawRow): TaxProfileView {
  const raw = 'legal_entity_id' in r;
  return raw
    ? {
        id: r.id,
        legalEntityId: r.legal_entity_id,
        effectiveFrom: iso(r.effective_from),
        vatStatus: r.vat_status,
        vatRate: rate(r.vat_rate),
        percentageTaxRate: rate(r.percentage_tax_rate),
        roundingMode: r.rounding_mode,
        note: r.note,
        createdAt: iso(r.created_at),
      }
    : {
        id: r.id,
        legalEntityId: r.legalEntityId,
        effectiveFrom: iso(r.effectiveFrom),
        vatStatus: r.vatStatus,
        vatRate: rate(r.vatRate),
        percentageTaxRate: rate(r.percentageTaxRate),
        roundingMode: r.roundingMode,
        note: r.note,
        createdAt: iso(r.createdAt),
      };
}

const atOrNow = (at?: Date) => (at ? sql`${at.toISOString()}::timestamptz` : effectiveNowSql);

/**
 * The profile in force at `at` (default: DB now) for each entity (latest effective_from <= at). With
 * `knownAt` (an offline sale re-priced as of its snapshot, audit 45 #12a), a profile created after that
 * instant (plus the clock skew allowance) is ignored, like price rows and promotions: a profile
 * back-dated after the till took its snapshot cannot turn the sale into a total mismatch.
 */
export async function profilesInForce(db: Database, legalEntityIds: readonly string[], at?: Date, knownAt?: Date): Promise<Map<string, TaxProfileView>> {
  if (legalEntityIds.length === 0) return new Map();
  const { rows } = await db.execute<RawRow>(sql`
    SELECT DISTINCT ON (legal_entity_id) *
      FROM tax_profiles
     WHERE legal_entity_id IN (${sql.join(legalEntityIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND effective_from <= ${atOrNow(at)}
       ${knownAt ? sql`AND created_at <= ${knownAt.toISOString()}::timestamptz + ${sql.raw(EFFECTIVE_SKEW)}` : sql``}
     ORDER BY legal_entity_id, effective_from DESC`);
  return new Map(rows.map((r) => [r.legal_entity_id, profileView(r)]));
}

/** The next scheduled (future) profile per entity, if any. */
export async function scheduledProfiles(db: Database, legalEntityIds: readonly string[], at?: Date): Promise<Map<string, TaxProfileView>> {
  if (legalEntityIds.length === 0) return new Map();
  const { rows } = await db.execute<RawRow>(sql`
    SELECT DISTINCT ON (legal_entity_id) *
      FROM tax_profiles
     WHERE legal_entity_id IN (${sql.join(legalEntityIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND effective_from > ${atOrNow(at)}
     ORDER BY legal_entity_id, effective_from ASC`);
  return new Map(rows.map((r) => [r.legal_entity_id, profileView(r)]));
}

export interface NewProfile {
  tenantId: string;
  legalEntityId: string;
  vatStatus: 'VAT' | 'NON_VAT';
  vatRate?: string | undefined;
  percentageTaxRate?: string | undefined;
  roundingMode: 'HALF_UP' | 'HALF_EVEN';
  effectiveFrom?: Date | undefined;
  note?: string | null | undefined;
  createdBy: string;
}

export async function insertProfile(db: Database, p: NewProfile): Promise<TaxProfileView> {
  const isVat = p.vatStatus === 'VAT';
  const [row] = await db
    .insert(taxProfiles)
    .values({
      tenantId: p.tenantId,
      legalEntityId: p.legalEntityId,
      vatStatus: p.vatStatus,
      vatRate: isVat ? (p.vatRate ?? DEFAULT_VAT_RATE) : '0',
      percentageTaxRate: isVat ? '0' : (p.percentageTaxRate ?? DEFAULT_PERCENTAGE_TAX_RATE),
      roundingMode: p.roundingMode,
      // Database clock by default, so "now" can never trip the no-backdating trigger.
      effectiveFrom: p.effectiveFrom ?? sql`now()`,
      note: p.note ?? null,
      createdBy: p.createdBy,
    })
    .returning();
  return profileView(row!);
}

/** Engine input for a profile view. */
export const engineProfile = (p: TaxProfileView): TaxProfile => ({
  id: p.id,
  effectiveFrom: p.effectiveFrom,
  vatStatus: p.vatStatus,
  vatRate: p.vatRate,
  roundingMode: p.roundingMode,
});
