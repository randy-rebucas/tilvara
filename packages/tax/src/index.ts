import { Dec, minorUnits, roundTo, toDec, type CurrencyCode, type RoundingMode } from '@1pos/money';

/**
 * Pure tax calculation (ADR-0008). No I/O and no clock: callers load the seller's tax profile in
 * force, each item's VAT treatment and price, and any statutory discount scheme, then persist
 * the result (including its snapshot) verbatim. Rules marked in ADR-0008 as assumptions are
 * pending review by a qualified Philippine tax professional.
 */

export type VatStatus = 'VAT' | 'NON_VAT';
export type VatTreatment = 'VATABLE' | 'VAT_EXEMPT' | 'ZERO_RATED';
export type SchemeBase = 'VAT_EXCLUSIVE' | 'GROSS';
export type ReviewStatus = 'PENDING_PROFESSIONAL_REVIEW' | 'APPROVED';

export interface TaxProfile {
  id: string;
  /** ISO timestamp the profile took effect. */
  effectiveFrom: string;
  vatStatus: VatStatus;
  /** Decimal fraction, e.g. "0.12". Must be "0" for NON_VAT sellers. */
  vatRate: string;
  roundingMode: Extract<RoundingMode, 'HALF_UP' | 'HALF_EVEN'>;
}

export interface DiscountScheme {
  code: string;
  version: number;
  /** Decimal fraction, e.g. "0.20". */
  rate: string;
  /** Beneficiary's purchase is VAT-exempt (VAT removed before the discount for VAT sellers). */
  vatExempt: boolean;
  base: SchemeBase;
  reviewStatus: ReviewStatus;
}

export interface TaxLineInput {
  id: string;
  /** Unit price as stored in the price list (decimal string). */
  unitPrice: string;
  quantity: string;
  /** Whether `unitPrice` already includes VAT (price list setting). */
  priceIncludesTax: boolean;
  vatTreatment: VatTreatment;
  /** Ordinary discount for the whole line, on the same basis as the price. */
  discount?: string;
  /** Statutory discount (SC/PWD…) for `share` of the line (default the whole line). */
  statutory?: { scheme: DiscountScheme; share?: string };
}

export interface TaxContext {
  currency: CurrencyCode;
  profile: TaxProfile;
}

export interface LineSnapshot {
  profileId: string;
  profileEffectiveFrom: string;
  vatStatus: VatStatus;
  vatRate: string;
  roundingMode: TaxProfile['roundingMode'];
  roundingLevel: 'LINE';
  scheme?: { code: string; version: number; rate: string; vatExempt: boolean; base: SchemeBase; share: string };
}

/** All amounts are decimal strings in the currency's minor units. */
export interface TaxLineResult {
  id: string;
  /** unitPrice × quantity, on the price basis. */
  gross: string;
  discount: string;
  statutoryDiscount: string;
  /** VAT contained in an inclusive price that the beneficiary does not pay (shown on the invoice). */
  vatExemptionAmount: string;
  /** Sales buckets; statutory beneficiary sales are recorded before their discount. */
  vatableSales: string;
  vatAmount: string;
  vatExemptSales: string;
  zeroRatedSales: string;
  /** Non-VAT seller sales subject to percentage tax (the tax is reported, not added to the price). */
  percentageTaxSales: string;
  /** vatableSales + vatAmount + vatExemptSales + zeroRatedSales + percentageTaxSales − statutoryDiscount. */
  amountDue: string;
  snapshot: LineSnapshot;
}

export interface SchemeTotal {
  code: string;
  version: number;
  sales: string;
  discount: string;
  lines: number;
}

export interface TaxTotals {
  gross: string;
  discount: string;
  statutoryDiscount: string;
  vatExemptionAmount: string;
  vatableSales: string;
  vatAmount: string;
  vatExemptSales: string;
  zeroRatedSales: string;
  percentageTaxSales: string;
  amountDue: string;
}

export interface TaxResult {
  currency: CurrencyCode;
  lines: TaxLineResult[];
  totals: TaxTotals;
  statutory: SchemeTotal[];
  /** A scheme used here is not yet signed off by a tax professional (ADR-0008 gate). */
  requiresProfessionalReview: boolean;
}

export type TaxErrorCode =
  | 'INVALID_PROFILE'
  | 'INVALID_LINE'
  | 'DISCOUNT_EXCEEDS_LINE'
  | 'DISCOUNT_STACKING_NOT_ALLOWED'
  | 'UNSUPPORTED_SCHEME';

export class TaxError extends Error {
  constructor(
    readonly code: TaxErrorCode,
    message: string,
    readonly lineId?: string,
  ) {
    super(message);
    this.name = 'TaxError';
  }
}

const ZERO = new Dec(0);
const ONE = new Dec(1);

interface Parts {
  vatableSales: Dec;
  vatAmount: Dec;
  vatExemptSales: Dec;
  zeroRatedSales: Dec;
  percentageTaxSales: Dec;
  statutoryDiscount: Dec;
  vatExemptionAmount: Dec;
}

const emptyParts = (): Parts => ({
  vatableSales: ZERO,
  vatAmount: ZERO,
  vatExemptSales: ZERO,
  zeroRatedSales: ZERO,
  percentageTaxSales: ZERO,
  statutoryDiscount: ZERO,
  vatExemptionAmount: ZERO,
});

function nonNegative(value: string, what: string, lineId: string): Dec {
  let d: Dec;
  try {
    d = toDec(value);
  } catch {
    throw new TaxError('INVALID_LINE', `${what} must be a decimal string`, lineId);
  }
  if (d.isNegative()) throw new TaxError('INVALID_LINE', `${what} must not be negative`, lineId);
  return d;
}

function validateProfile(p: TaxProfile): Dec {
  let rate: Dec;
  try {
    rate = toDec(p.vatRate);
  } catch {
    throw new TaxError('INVALID_PROFILE', 'vatRate must be a decimal string');
  }
  if (p.vatStatus === 'VAT' && (rate.lte(0) || rate.gte(1))) throw new TaxError('INVALID_PROFILE', 'VAT sellers need 0 < vatRate < 1');
  if (p.vatStatus === 'NON_VAT' && !rate.isZero()) throw new TaxError('INVALID_PROFILE', 'Non-VAT sellers must have vatRate 0');
  return rate;
}

export function calculateTax(ctx: TaxContext, inputs: readonly TaxLineInput[]): TaxResult {
  const scale = minorUnits(ctx.currency);
  const mode = ctx.profile.roundingMode;
  const r = (d: Dec) => roundTo(d, scale, mode);
  const fmt = (d: Dec) => d.toFixed(scale);
  const vatRate = validateProfile(ctx.profile);
  const isVatSeller = ctx.profile.vatStatus === 'VAT';
  const ids = new Set<string>();

  /** Ordinary (non-beneficiary) treatment of an amount on the price basis. */
  function regular(amount: Dec, line: TaxLineInput, parts: Parts) {
    if (!isVatSeller) {
      if (line.vatTreatment === 'VAT_EXEMPT') parts.vatExemptSales = parts.vatExemptSales.plus(amount);
      else parts.percentageTaxSales = parts.percentageTaxSales.plus(amount);
      return;
    }
    if (line.vatTreatment === 'VAT_EXEMPT') parts.vatExemptSales = parts.vatExemptSales.plus(amount);
    else if (line.vatTreatment === 'ZERO_RATED') parts.zeroRatedSales = parts.zeroRatedSales.plus(amount);
    else if (line.priceIncludesTax) {
      // VAT by subtraction so base + VAT equals exactly what the customer pays.
      const base = r(amount.dividedBy(ONE.plus(vatRate)));
      parts.vatableSales = parts.vatableSales.plus(base);
      parts.vatAmount = parts.vatAmount.plus(amount.minus(base));
    } else {
      parts.vatableSales = parts.vatableSales.plus(amount);
      parts.vatAmount = parts.vatAmount.plus(r(amount.times(vatRate)));
    }
  }

  /** The beneficiary's portion under a statutory scheme. */
  function beneficiary(amount: Dec, line: TaxLineInput, scheme: DiscountScheme, parts: Parts) {
    const rate = toDec(scheme.rate);
    if (rate.lte(0) || rate.gt(1)) throw new TaxError('UNSUPPORTED_SCHEME', `Scheme ${scheme.code} has an invalid rate`, line.id);
    const bucket = (sales: Dec) => {
      if (!isVatSeller) {
        if (line.vatTreatment === 'VAT_EXEMPT') parts.vatExemptSales = parts.vatExemptSales.plus(sales);
        else parts.percentageTaxSales = parts.percentageTaxSales.plus(sales);
      } else if (line.vatTreatment === 'ZERO_RATED') parts.zeroRatedSales = parts.zeroRatedSales.plus(sales);
      else parts.vatExemptSales = parts.vatExemptSales.plus(sales);
    };

    if (isVatSeller && line.vatTreatment === 'VATABLE') {
      // Discounts that keep VAT (e.g. 5 % BNPC) have unverified tax-base rules: refuse rather than guess.
      if (!scheme.vatExempt) throw new TaxError('UNSUPPORTED_SCHEME', `Scheme ${scheme.code} on VATable items is not supported yet`, line.id);
      const exclusive = line.priceIncludesTax ? r(amount.dividedBy(ONE.plus(vatRate))) : amount;
      parts.vatExemptionAmount = parts.vatExemptionAmount.plus(amount.minus(exclusive));
      const discountBase = scheme.base === 'VAT_EXCLUSIVE' ? exclusive : amount;
      parts.statutoryDiscount = parts.statutoryDiscount.plus(r(discountBase.times(rate)));
      parts.vatExemptSales = parts.vatExemptSales.plus(exclusive);
      return;
    }
    // No VAT inside the price (exempt/zero-rated item, or a non-VAT seller): the rate applies to the price.
    parts.statutoryDiscount = parts.statutoryDiscount.plus(r(amount.times(rate)));
    bucket(amount);
  }

  const lines = inputs.map((line): TaxLineResult => {
    if (!line.id || ids.has(line.id)) throw new TaxError('INVALID_LINE', 'Line ids must be present and unique', line.id);
    ids.add(line.id);
    const unitPrice = nonNegative(line.unitPrice, 'unitPrice', line.id);
    const quantity = nonNegative(line.quantity, 'quantity', line.id);
    if (quantity.isZero()) throw new TaxError('INVALID_LINE', 'quantity must be positive', line.id);
    const gross = r(unitPrice.times(quantity));
    const discount = r(nonNegative(line.discount ?? '0', 'discount', line.id));
    if (discount.gt(gross)) throw new TaxError('DISCOUNT_EXCEEDS_LINE', 'Discount exceeds the line amount', line.id);
    if (line.statutory && !discount.isZero()) {
      throw new TaxError('DISCOUNT_STACKING_NOT_ALLOWED', 'A statutory discount cannot be combined with another discount on the same line', line.id);
    }
    const net = gross.minus(discount);
    const parts = emptyParts();
    let schemeSnapshot: LineSnapshot['scheme'];

    if (line.statutory) {
      const share = nonNegative(line.statutory.share ?? '1', 'share', line.id);
      if (share.isZero() || share.gt(1)) throw new TaxError('INVALID_LINE', 'share must be in (0, 1]', line.id);
      const portion = r(net.times(share));
      beneficiary(portion, line, line.statutory.scheme, parts);
      if (net.gt(portion)) regular(net.minus(portion), line, parts);
      const s = line.statutory.scheme;
      schemeSnapshot = { code: s.code, version: s.version, rate: s.rate, vatExempt: s.vatExempt, base: s.base, share: share.toString() };
    } else {
      regular(net, line, parts);
    }

    const amountDue = parts.vatableSales
      .plus(parts.vatAmount)
      .plus(parts.vatExemptSales)
      .plus(parts.zeroRatedSales)
      .plus(parts.percentageTaxSales)
      .minus(parts.statutoryDiscount);

    return {
      id: line.id,
      gross: fmt(gross),
      discount: fmt(discount),
      statutoryDiscount: fmt(parts.statutoryDiscount),
      vatExemptionAmount: fmt(parts.vatExemptionAmount),
      vatableSales: fmt(parts.vatableSales),
      vatAmount: fmt(parts.vatAmount),
      vatExemptSales: fmt(parts.vatExemptSales),
      zeroRatedSales: fmt(parts.zeroRatedSales),
      percentageTaxSales: fmt(parts.percentageTaxSales),
      amountDue: fmt(amountDue),
      snapshot: {
        profileId: ctx.profile.id,
        profileEffectiveFrom: ctx.profile.effectiveFrom,
        vatStatus: ctx.profile.vatStatus,
        vatRate: vatRate.toString(),
        roundingMode: mode,
        roundingLevel: 'LINE',
        ...(schemeSnapshot && { scheme: schemeSnapshot }),
      },
    };
  });

  const sum = (key: keyof TaxTotals) => fmt(lines.reduce((acc, l) => acc.plus(l[key]), ZERO));
  const totals: TaxTotals = {
    gross: sum('gross'),
    discount: sum('discount'),
    statutoryDiscount: sum('statutoryDiscount'),
    vatExemptionAmount: sum('vatExemptionAmount'),
    vatableSales: sum('vatableSales'),
    vatAmount: sum('vatAmount'),
    vatExemptSales: sum('vatExemptSales'),
    zeroRatedSales: sum('zeroRatedSales'),
    percentageTaxSales: sum('percentageTaxSales'),
    amountDue: sum('amountDue'),
  };

  const byScheme = new Map<string, { code: string; version: number; sales: Dec; discount: Dec; lines: number }>();
  for (const [i, l] of lines.entries()) {
    const s = l.snapshot.scheme;
    if (!s) continue;
    const key = `${s.code}@${s.version}`;
    const acc = byScheme.get(key) ?? { code: s.code, version: s.version, sales: ZERO, discount: ZERO, lines: 0 };
    // Beneficiary sales = the portion the discount was computed on (VAT-exclusive where VAT was removed).
    const input = inputs[i]!;
    const portion = r(toDec(l.gross).minus(l.discount).times(s.share));
    const sales = isVatSeller && input.vatTreatment === 'VATABLE' && input.priceIncludesTax ? portion.minus(l.vatExemptionAmount) : portion;
    acc.sales = acc.sales.plus(sales);
    acc.discount = acc.discount.plus(l.statutoryDiscount);
    acc.lines += 1;
    byScheme.set(key, acc);
  }

  return {
    currency: ctx.currency,
    lines,
    totals,
    statutory: [...byScheme.values()].map((s) => ({ code: s.code, version: s.version, sales: fmt(s.sales), discount: fmt(s.discount), lines: s.lines })),
    requiresProfessionalReview: inputs.some((l) => l.statutory && l.statutory.scheme.reviewStatus !== 'APPROVED'),
  };
}
