import { Dec } from '@1pos/money';
import { describe, expect, it } from 'vitest';
import { calculateTax, serviceCharge, TaxError, type DiscountScheme, type TaxContext, type TaxLineInput, type TaxResult } from '../src/index.js';

const VAT: TaxContext = {
  currency: 'PHP',
  profile: { id: 'tp-vat', effectiveFrom: '2026-01-01T00:00:00Z', vatStatus: 'VAT', vatRate: '0.12', roundingMode: 'HALF_UP' },
};
const NON_VAT: TaxContext = {
  currency: 'PHP',
  profile: { id: 'tp-nv', effectiveFrom: '2026-01-01T00:00:00Z', vatStatus: 'NON_VAT', vatRate: '0', roundingMode: 'HALF_UP' },
};
const SC: DiscountScheme = { code: 'SC', version: 1, rate: '0.20', vatExempt: true, base: 'VAT_EXCLUSIVE', reviewStatus: 'PENDING_PROFESSIONAL_REVIEW' };
const PWD: DiscountScheme = { ...SC, code: 'PWD' };

const line = (over: Partial<TaxLineInput> = {}): TaxLineInput => ({
  id: 'l1',
  unitPrice: '1120.00',
  quantity: '1',
  priceIncludesTax: true,
  vatTreatment: 'VATABLE',
  ...over,
});

function caught(fn: () => unknown): TaxError {
  try {
    fn();
  } catch (e) {
    if (e instanceof TaxError) return e;
    throw e;
  }
  throw new Error('expected a TaxError');
}

describe('golden vectors (PH_COMPLIANCE_ASSUMPTIONS §7.1, RR 5-2017)', () => {
  it('VAT seller, ₱1,120 VAT-inclusive, SC → ₱800 due, ₱1,000 exempt sale, ₱200 discount, ₱120 VAT not billed', () => {
    const r = calculateTax(VAT, [line({ statutory: { scheme: SC } })]);
    expect(r.lines[0]).toMatchObject({
      gross: '1120.00',
      vatExemptSales: '1000.00',
      vatExemptionAmount: '120.00',
      statutoryDiscount: '200.00',
      vatableSales: '0.00',
      vatAmount: '0.00',
      amountDue: '800.00',
    });
    expect(r.statutory).toEqual([{ code: 'SC', version: 1, sales: '1000.00', discount: '200.00', lines: 1 }]);
    expect(r.requiresProfessionalReview).toBe(true);
  });

  it('non-VAT seller, ₱1,120, PWD → 20 % of the full price, ₱896 due (no VAT exemption to apply)', () => {
    const r = calculateTax(NON_VAT, [line({ statutory: { scheme: PWD } })]);
    expect(r.lines[0]).toMatchObject({ statutoryDiscount: '224.00', percentageTaxSales: '1120.00', vatExemptionAmount: '0.00', amountDue: '896.00' });
  });

  it('VAT seller, ₱1,120 VAT-inclusive, no discount → ₱1,000 VATable + ₱120 VAT', () => {
    const r = calculateTax(VAT, [line()]);
    expect(r.lines[0]).toMatchObject({ vatableSales: '1000.00', vatAmount: '120.00', amountDue: '1120.00' });
  });
});

describe('VAT seller', () => {
  it('tax-exclusive prices add VAT on top', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '1000.00', priceIncludesTax: false })]);
    expect(r.lines[0]).toMatchObject({ gross: '1000.00', vatableSales: '1000.00', vatAmount: '120.00', amountDue: '1120.00' });
  });

  it('tax-exclusive price with SC: 20 % of the exclusive price, no VAT', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '1000.00', priceIncludesTax: false, statutory: { scheme: SC } })]);
    expect(r.lines[0]).toMatchObject({ vatExemptSales: '1000.00', statutoryDiscount: '200.00', vatAmount: '0.00', amountDue: '800.00' });
  });

  it('exempt and zero-rated items carry no VAT and land in their own buckets', () => {
    const r = calculateTax(VAT, [
      line({ id: 'a', unitPrice: '50.00', vatTreatment: 'VAT_EXEMPT' }),
      line({ id: 'b', unitPrice: '80.00', vatTreatment: 'ZERO_RATED' }),
      line({ id: 'c', unitPrice: '22.40', quantity: '2' }),
    ]);
    expect(r.totals).toMatchObject({
      vatExemptSales: '50.00',
      zeroRatedSales: '80.00',
      vatableSales: '40.00',
      vatAmount: '4.80',
      amountDue: '174.80',
    });
  });

  it('SC on an exempt item: 20 % of the price, stays exempt', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '100.00', vatTreatment: 'VAT_EXEMPT', statutory: { scheme: SC } })]);
    expect(r.lines[0]).toMatchObject({ vatExemptSales: '100.00', statutoryDiscount: '20.00', amountDue: '80.00' });
  });

  it('SC for a share of a line (beneficiary ate one of two meals)', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '560.00', quantity: '2', statutory: { scheme: SC, share: '0.5' } })]);
    // ₱560 for the beneficiary → 500 exempt, 100 discount; ₱560 regular → 500 VATable + 60 VAT.
    expect(r.lines[0]).toMatchObject({
      vatExemptSales: '500.00',
      statutoryDiscount: '100.00',
      vatableSales: '500.00',
      vatAmount: '60.00',
      amountDue: '960.00',
    });
    expect(r.statutory[0]).toMatchObject({ sales: '500.00', discount: '100.00' });
  });

  it('ordinary discount reduces the VAT base on an inclusive price', () => {
    const r = calculateTax(VAT, [line({ discount: '112.00' })]);
    expect(r.lines[0]).toMatchObject({ discount: '112.00', vatableSales: '900.00', vatAmount: '108.00', amountDue: '1008.00' });
  });

  it('rounds per line to centavos and derives VAT by subtraction', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '16.50' })]);
    // 16.50 / 1.12 = 14.7321… → 14.73; VAT = 1.77
    expect(r.lines[0]).toMatchObject({ vatableSales: '14.73', vatAmount: '1.77', amountDue: '16.50' });
  });

  it('weighted quantities (4 dp) are priced then rounded', () => {
    const r = calculateTax(VAT, [line({ unitPrice: '280.00', quantity: '0.3755' })]);
    expect(r.lines[0]!.gross).toBe('105.14');
    expect(r.lines[0]!.amountDue).toBe('105.14');
  });

  it('honours HALF_EVEN rounding from the profile', () => {
    const halfEven = { ...VAT, profile: { ...VAT.profile, roundingMode: 'HALF_EVEN' as const } };
    // 0.125 × 1 → HALF_UP 0.13, HALF_EVEN 0.12
    expect(calculateTax(VAT, [line({ unitPrice: '0.125', vatTreatment: 'VAT_EXEMPT' })]).lines[0]!.gross).toBe('0.13');
    expect(calculateTax(halfEven, [line({ unitPrice: '0.125', vatTreatment: 'VAT_EXEMPT' })]).lines[0]!.gross).toBe('0.12');
  });
});

describe('non-VAT seller', () => {
  it('never charges VAT; exempt items are exempt, the rest is subject to percentage tax', () => {
    const r = calculateTax(NON_VAT, [
      line({ id: 'a', unitPrice: '100.00' }),
      line({ id: 'b', unitPrice: '40.00', vatTreatment: 'VAT_EXEMPT' }),
      line({ id: 'c', unitPrice: '60.00', priceIncludesTax: false }),
    ]);
    expect(r.totals).toMatchObject({ vatAmount: '0.00', vatableSales: '0.00', percentageTaxSales: '160.00', vatExemptSales: '40.00', amountDue: '200.00' });
  });
});

describe('snapshots and flags', () => {
  it('every line records the profile and scheme versions it was computed with', () => {
    const r = calculateTax(VAT, [line({ id: 'a' }), line({ id: 'b', statutory: { scheme: SC, share: '0.25' } })]);
    expect(r.lines[0]!.snapshot).toEqual({
      profileId: 'tp-vat',
      profileEffectiveFrom: '2026-01-01T00:00:00Z',
      vatStatus: 'VAT',
      vatRate: '0.12',
      roundingMode: 'HALF_UP',
      roundingLevel: 'LINE',
    });
    expect(r.lines[1]!.snapshot.scheme).toEqual({ code: 'SC', version: 1, rate: '0.20', vatExempt: true, base: 'VAT_EXCLUSIVE', share: '0.25' });
  });

  it('approved schemes do not require review', () => {
    const r = calculateTax(VAT, [line({ statutory: { scheme: { ...SC, reviewStatus: 'APPROVED' } } })]);
    expect(r.requiresProfessionalReview).toBe(false);
    expect(calculateTax(VAT, [line()]).requiresProfessionalReview).toBe(false);
  });
});

describe('refusals', () => {
  it.each([
    ['statutory + ordinary discount on one line', () => calculateTax(VAT, [line({ discount: '1.00', statutory: { scheme: SC } })]), 'DISCOUNT_STACKING_NOT_ALLOWED'],
    ['discount above the line', () => calculateTax(VAT, [line({ discount: '1120.01' })]), 'DISCOUNT_EXCEEDS_LINE'],
    ['zero quantity', () => calculateTax(VAT, [line({ quantity: '0' })]), 'INVALID_LINE'],
    ['negative price', () => calculateTax(VAT, [line({ unitPrice: '-1' })]), 'INVALID_LINE'],
    ['float-ish garbage', () => calculateTax(VAT, [line({ unitPrice: '1e3' })]), 'INVALID_LINE'],
    ['share above 1', () => calculateTax(VAT, [line({ statutory: { scheme: SC, share: '1.5' } })]), 'INVALID_LINE'],
    ['duplicate line ids', () => calculateTax(VAT, [line(), line()]), 'INVALID_LINE'],
    ['VAT-keeping scheme on VATable item (unverified base rules)', () => calculateTax(VAT, [line({ statutory: { scheme: { ...SC, code: 'BNPC5', rate: '0.05', vatExempt: false } } })]), 'UNSUPPORTED_SCHEME'],
    ['non-VAT profile with a VAT rate', () => calculateTax({ ...NON_VAT, profile: { ...NON_VAT.profile, vatRate: '0.12' } }, [line()]), 'INVALID_PROFILE'],
    ['VAT profile without a rate', () => calculateTax({ ...VAT, profile: { ...VAT.profile, vatRate: '0' } }, [line()]), 'INVALID_PROFILE'],
  ])('%s', (_name, fn, code) => {
    expect(caught(fn).code).toBe(code);
  });
});

describe('invariants over generated carts', () => {
  // Deterministic PRNG so failures are reproducible.
  let seed = 20261015;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const money = () => (Math.floor(rand() * 500_000) / 100).toFixed(2);

  function cart(): [TaxContext, TaxLineInput[]] {
    const ctx = pick([VAT, NON_VAT]);
    const n = 1 + Math.floor(rand() * 8);
    const lines = Array.from({ length: n }, (_, i): TaxLineInput => {
      const base = line({
        id: `l${i}`,
        unitPrice: money(),
        quantity: pick(['1', '2', '3', '0.25', '1.5', '0.3755']),
        priceIncludesTax: rand() < 0.8,
        vatTreatment: pick(['VATABLE', 'VATABLE', 'VAT_EXEMPT', 'ZERO_RATED'] as const),
      });
      const roll = rand();
      if (roll < 0.25) return { ...base, statutory: { scheme: pick([SC, PWD]), share: pick(['1', '0.5', '0.3333']) } };
      if (roll < 0.45) return { ...base, discount: (Number(money()) % 1).toFixed(2) };
      return base;
    });
    return [ctx, lines];
  }

  const D = (s: string | number) => new Dec(s);
  const check = (r: TaxResult, inputs: TaxLineInput[], ctx: TaxContext) => {
    for (const [i, l] of r.lines.entries()) {
      const input = inputs[i]!;
      const buckets = D(l.vatableSales).plus(l.vatAmount).plus(l.vatExemptSales).plus(l.zeroRatedSales).plus(l.percentageTaxSales);
      expect(D(l.amountDue).equals(buckets.minus(l.statutoryDiscount))).toBe(true);
      // Everything the customer would have paid is accounted for exactly once.
      const net = D(l.gross).minus(l.discount);
      const vatOnTop = input.priceIncludesTax ? D(0) : D(l.vatAmount);
      expect(net.plus(vatOnTop).minus(l.vatExemptionAmount).minus(l.statutoryDiscount).equals(D(l.amountDue))).toBe(true);
      expect(D(l.amountDue).isNegative()).toBe(false);
      if (ctx.profile.vatStatus === 'NON_VAT') expect(l.vatAmount).toBe('0.00');
      for (const v of [l.gross, l.amountDue, l.vatAmount, l.vatableSales]) expect(v).toMatch(/^\d+\.\d{2}$/);
    }
    for (const key of ['gross', 'discount', 'statutoryDiscount', 'vatAmount', 'vatableSales', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue'] as const) {
      const sum = r.lines.reduce((a, l) => a.plus(l[key]), D(0));
      expect(sum.equals(D(r.totals[key]))).toBe(true);
    }
    const schemeDiscounts = r.statutory.reduce((a, s) => a.plus(s.discount), D(0));
    expect(schemeDiscounts.equals(D(r.totals.statutoryDiscount))).toBe(true);
  };

  it('holds for 2,000 random carts', () => {
    for (let i = 0; i < 2000; i++) {
      const [ctx, inputs] = cart();
      check(calculateTax(ctx, inputs), inputs, ctx);
    }
  });

  it('is deterministic and does not mutate inputs', () => {
    const [ctx, inputs] = cart();
    const copy = structuredClone(inputs);
    expect(calculateTax(ctx, inputs)).toEqual(calculateTax(ctx, inputs));
    expect(inputs).toEqual(copy);
  });
});

describe('service charge (ADR-0014 §9)', () => {
  const items = (ctx: TaxContext, lines: TaxLineInput[]) => calculateTax(ctx, lines).lines;

  it('VAT seller: 10 % of the items ex VAT, then VAT on the charge (₱1,120 → ₱100 + ₱12)', () => {
    const sc = serviceCharge(VAT, items(VAT, [line()]), { rate: '0.10', vatTreatment: 'VATABLE' })!;
    expect(sc).toMatchObject({ base: '1000.00', rate: '0.1', gross: '100.00', vatableSales: '100.00', vatAmount: '12.00', amountDue: '112.00' });
  });

  it("a SC diner's share is charged on the discounted, VAT-exempt amount (₱1,120 → base ₱800)", () => {
    const sc = serviceCharge(VAT, items(VAT, [line({ statutory: { scheme: SC } })]), { rate: '0.10', vatTreatment: 'VATABLE' })!;
    expect(sc).toMatchObject({ base: '800.00', vatableSales: '80.00', vatAmount: '9.60', amountDue: '89.60' });
    const exempt = serviceCharge(VAT, items(VAT, [line({ statutory: { scheme: SC } })]), { rate: '0.10', vatTreatment: 'VAT_EXEMPT' })!;
    expect(exempt).toMatchObject({ vatExemptSales: '80.00', vatAmount: '0.00', amountDue: '80.00' });
  });

  it('mixed table, non-VAT seller, rounding, and nothing to charge', () => {
    const mixed = serviceCharge(VAT, items(VAT, [line(), line({ id: 'l2', statutory: { scheme: PWD } })]), { rate: '0.10', vatTreatment: 'VATABLE' })!;
    expect(mixed).toMatchObject({ base: '1800.00', vatableSales: '180.00', vatAmount: '21.60', amountDue: '201.60' });
    const nv = serviceCharge(NON_VAT, items(NON_VAT, [line()]), { rate: '0.10', vatTreatment: 'VATABLE' })!;
    expect(nv).toMatchObject({ base: '1120.00', percentageTaxSales: '112.00', vatAmount: '0.00', amountDue: '112.00' });
    const odd = serviceCharge(VAT, items(VAT, [line({ unitPrice: '333.33', priceIncludesTax: false })]), { rate: '0.10', vatTreatment: 'VATABLE' })!;
    expect(odd).toMatchObject({ base: '333.33', gross: '33.33', vatAmount: '4.00' });
    expect(serviceCharge(VAT, items(VAT, [line()]), { rate: '0', vatTreatment: 'VATABLE' })).toBeNull();
    expect(caught(() => serviceCharge(VAT, [], { rate: '1.5', vatTreatment: 'VATABLE' })).code).toBe('INVALID_LINE');
  });
});
