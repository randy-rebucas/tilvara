import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  desc,
  discountSchemes,
  eq,
  inArray,
  legalEntities,
  lte,
  products,
  productVariants,
  taxCategories,
  taxProfiles,
  unitsOfMeasure,
  type Database,
} from '@1pos/database';
import { isCurrencyCode, toDec } from '@1pos/money';
import { calculateTax, TaxError, type DiscountScheme, type TaxLineInput } from '@1pos/tax';
import type { CreateTaxProfileInput, TaxQuoteInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { PricingService } from '../catalog/pricing.service.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { dbNow, effectiveNow } from '../common/clock.js';
import { engineProfile, insertProfile, profilesInForce, profileView } from './tax-profiles.js';
import { overridesForCart } from './price-overrides.js';

/** Clock-skew tolerance for "effective now"; the DB trigger allows 5 minutes. */
const BACKDATE_TOLERANCE_MS = 60_000;

export interface LineMeta {
  variantId: string;
  sku: string;
  name: string;
  taxCategoryCode: string;
  vatTreatment: string;
  unitPrice: string;
  quantity: string;
  priceIncludesTax: boolean;
  priceId: string;
  priceListId: string;
  trackInventory: boolean;
  /** The approved price change this line is sold at (session 20), else null. */
  priceOverrideId: string | null;
  /** With an override: the list price it replaced. */
  listUnitPrice?: string;
}

export type CartComputation = Awaited<ReturnType<TaxService['computeCart']>>;

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

@Injectable()
export class TaxService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    tax_profiles_version_unique: ['TAX_PROFILE_EXISTS', 'A tax profile already starts at this moment for this legal entity'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- tax profiles
  listProfiles(auth: AuthContext, legalEntityId: string) {
    return this.read(auth, async (db) => {
      await this.entity(db, legalEntityId);
      this.assertCan(auth, 'org.read', { legalEntityId });
      const rows = await db.select().from(taxProfiles).where(eq(taxProfiles.legalEntityId, legalEntityId)).orderBy(desc(taxProfiles.effectiveFrom));
      const now = (await effectiveNow(db)).getTime();
      const views = rows.map(profileView);
      const inForce = views.find((v) => Date.parse(v.effectiveFrom) <= now)?.id ?? null;
      return { data: views.map((v) => ({ ...v, state: v.id === inForce ? 'IN_FORCE' : Date.parse(v.effectiveFrom) > now ? 'SCHEDULED' : 'SUPERSEDED' })) };
    });
  }

  createProfile(auth: AuthContext, legalEntityId: string, input: CreateTaxProfileInput) {
    return this.mutate(auth, async (db) => {
      const entity = await this.entity(db, legalEntityId);
      this.assertCan(auth, 'tax.manage', { legalEntityId });
      if (entity.archivedAt) throw archived('Legal entity');
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : undefined;
      if (effectiveFrom && effectiveFrom.getTime() < (await dbNow(db)).getTime() - BACKDATE_TOLERANCE_MS) {
        throw unprocessable('TAX_PROFILE_BACKDATED', 'A tax profile can only take effect now or in the future; past sales keep the profile they were made with');
      }
      const profile = await insertProfile(db, {
        tenantId: tenantOf(auth).tenantId,
        legalEntityId,
        vatStatus: input.vatStatus,
        vatRate: input.vatRate,
        percentageTaxRate: input.percentageTaxRate,
        roundingMode: input.roundingMode,
        effectiveFrom,
        note: input.note,
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'tax_profile.created', 'legal_entity', legalEntityId, {
        taxProfileId: profile.id,
        vatStatus: profile.vatStatus,
        vatRate: profile.vatRate,
        effectiveFrom: profile.effectiveFrom,
      });
      return profile;
    });
  }

  // ---------------------------------------------------------------- statutory schemes
  listSchemes(auth: AuthContext) {
    return this.read(auth, async (db) => {
      const rows = await db.select().from(discountSchemes).orderBy(asc(discountSchemes.code), desc(discountSchemes.version));
      return { data: rows.map((r) => ({ ...r, rate: toDec(r.rate).toString() })) };
    });
  }

  // ---------------------------------------------------------------- quote
  /**
   * Server-authoritative prices and taxes for a cart at a branch, right now: the branch's price
   * in force, each item's VAT treatment, the seller's tax profile in force and statutory schemes.
   * Read-only; checkout persists the same computation with its snapshot.
   */
  quote(auth: AuthContext, input: TaxQuoteInput) {
    return this.read(auth, (db) => this.computeCart(db, auth, input));
  }

  /**
   * The single pricing + tax path (quote and checkout). Runs inside the caller's tenant
   * transaction; `branch` may be pre-loaded (and locked) by the caller. `asOf` re-prices a cart as it
   * stood at an earlier instant (an offline sale at its snapshot, ADR-0015 §5); prices and tax profiles
   * are append-only and effective-dated, so the result is what was in force then.
   */
  async computeCart(db: Database, auth: AuthContext, input: TaxQuoteInput, asOf?: Date) {
    const at = asOf ?? (await effectiveNow(db));
    const [branch] = await db.select().from(branches).where(eq(branches.id, input.branchId));
    if (!branch) throw notFound('Branch');
    const scope = { branchId: branch.id, legalEntityId: branch.legalEntityId };
    this.assertCan(auth, 'sales.create', scope);
    if (branch.archivedAt) throw archived('Branch');
    if (input.lines.some((l) => (l.discount && !toDec(l.discount).isZero()) || l.discountRate)) this.assertCan(auth, 'sales.discount', scope);

    const profile = (await profilesInForce(db, [branch.legalEntityId], at)).get(branch.legalEntityId);
    if (!profile) throw new AppError('TAX_PROFILE_MISSING', 'The legal entity has no tax profile in force', HttpStatus.CONFLICT);

    const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
    const items = await db
      .select({
        variantId: productVariants.id,
        sku: productVariants.sku,
        variantName: productVariants.name,
        variantArchivedAt: productVariants.archivedAt,
        productName: products.name,
        productArchivedAt: products.archivedAt,
        soldBy: products.soldBy,
        allowsFraction: unitsOfMeasure.allowsFraction,
        vatTreatment: taxCategories.vatTreatment,
        taxCategoryCode: taxCategories.code,
        trackInventory: products.trackInventory,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(taxCategories, eq(taxCategories.id, products.taxCategoryId))
      .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.uomId))
      .where(inArray(productVariants.id, variantIds));
    const byVariant = new Map(items.map((i) => [i.variantId, i]));

    const schemeCodes = [...new Set(input.lines.flatMap((l) => (l.statutory ? [l.statutory.scheme] : [])))];
    const schemes = await this.schemesInForce(db, schemeCodes, at);

    const prices = await this.pricing.effectivePrices(db, branch.id, variantIds, at);
    // Approved prices replace the list price for their line (an offline re-pricing never carries one).
    const overrides = await overridesForCart(db, auth, branch.id, at, input.lines);

    const meta: LineMeta[] = [];
    let currency: string | undefined;
    const lines: TaxLineInput[] = [];
    for (const [index, l] of input.lines.entries()) {
      const lineId = l.id ?? String(index + 1);
      const item = byVariant.get(l.variantId);
      if (!item || item.variantArchivedAt || item.productArchivedAt) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { line: lineId });
      if (item.soldBy === 'UNIT' && !item.allowsFraction && !toDec(l.quantity).isInteger()) {
        throw unprocessable('QUANTITY_NOT_ALLOWED', 'This item is sold in whole units', { line: lineId });
      }
      const price = prices.get(l.variantId);
      if (!price) throw new AppError('ITEM_NOT_PRICED', 'This item has no price at this branch', HttpStatus.CONFLICT, { line: lineId });
      if (currency && price.currency !== currency) throw unprocessable('MIXED_CURRENCY', 'Items are priced in different currencies', { line: lineId });
      currency = price.currency;

      let statutory: TaxLineInput['statutory'];
      if (l.statutory) {
        const scheme = schemes.get(l.statutory.scheme);
        if (!scheme) throw unprocessable('UNKNOWN_SCHEME', `No discount scheme ${l.statutory.scheme} is in force`, { line: lineId });
        statutory = { scheme, ...(l.statutory.share && { share: l.statutory.share }) };
      }
      const override = l.priceOverrideId ? overrides.get(l.priceOverrideId)! : null;
      const unitPrice = override ? override.unitPrice : price.amount;
      lines.push({
        id: lineId,
        unitPrice,
        quantity: l.quantity,
        priceIncludesTax: price.pricesIncludeTax,
        vatTreatment: item.vatTreatment,
        ...(l.discount && { discount: l.discount }),
        ...(l.discountRate && { discountRate: l.discountRate }),
        ...(statutory && { statutory }),
      });
      meta.push({
        variantId: l.variantId,
        sku: item.sku,
        name: item.variantName ? `${item.productName} — ${item.variantName}` : item.productName,
        taxCategoryCode: item.taxCategoryCode,
        vatTreatment: item.vatTreatment,
        unitPrice: toDec(unitPrice).toString(),
        quantity: l.quantity,
        priceIncludesTax: price.pricesIncludeTax,
        priceId: price.priceId,
        priceListId: price.priceListId,
        trackInventory: item.trackInventory,
        priceOverrideId: override?.id ?? null,
        ...(override && { listUnitPrice: toDec(price.amount).toString() }),
      });
    }
    if (!currency || !isCurrencyCode(currency)) throw unprocessable('UNSUPPORTED_CURRENCY', `Currency ${currency} is not supported`);

    try {
      const result = calculateTax({ currency, profile: engineProfile(profile) }, lines);
      return {
        branchId: branch.id,
        legalEntityId: branch.legalEntityId,
        at: at.toISOString(),
        taxProfile: profile,
        ...result,
        lines: result.lines.map((l, i) => ({ ...(meta[i] as LineMeta), ...l })),
      };
    } catch (e) {
      if (e instanceof TaxError) throw unprocessable(e.code, e.message, e.lineId ? { line: e.lineId } : undefined);
      throw e;
    }
  }

  private async schemesInForce(db: Database, codes: string[], at: Date): Promise<Map<string, DiscountScheme>> {
    if (codes.length === 0) return new Map();
    const rows = await db
      .select()
      .from(discountSchemes)
      .where(and(inArray(discountSchemes.code, codes), lte(discountSchemes.effectiveFrom, at)))
      .orderBy(asc(discountSchemes.code), desc(discountSchemes.effectiveFrom), desc(discountSchemes.version));
    const out = new Map<string, DiscountScheme>();
    for (const r of rows) {
      if (out.has(r.code)) continue;
      out.set(r.code, { code: r.code, version: r.version, rate: toDec(r.rate).toString(), vatExempt: r.vatExempt, base: r.base, reviewStatus: r.reviewStatus });
    }
    return out;
  }

  private async entity(db: Database, id: string) {
    const [row] = await db.select().from(legalEntities).where(eq(legalEntities.id, id));
    if (!row) throw notFound('Legal entity');
    return row;
  }
}
