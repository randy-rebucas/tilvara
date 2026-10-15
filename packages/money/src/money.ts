import { CurrencyCode, minorUnits } from './currency.js';
import { Dec, DecimalInput, RoundingMode, roundTo, toDec } from './decimal.js';

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Immutable monetary amount. Internally unrounded so multi-step calculations
 * (line × qty − discount → tax) do not accumulate rounding error; call
 * `round()` at the policy-defined points only.
 */
export class Money {
  private constructor(
    readonly amount: Dec,
    readonly currency: CurrencyCode,
  ) {}

  static of(amount: DecimalInput, currency: CurrencyCode): Money {
    return new Money(toDec(amount), currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(new Dec(0), currency);
  }

  static sum(items: readonly Money[], currency: CurrencyCode): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  multiply(factor: DecimalInput): Money {
    return new Money(this.amount.times(toDec(factor)), this.currency);
  }

  divide(divisor: DecimalInput): Money {
    const d = toDec(divisor);
    if (d.isZero()) throw new RangeError('Division by zero');
    return new Money(this.amount.dividedBy(d), this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  /** Round to the currency's minor units (e.g. centavos for PHP). */
  round(mode: RoundingMode = 'HALF_UP'): Money {
    return new Money(roundTo(this.amount, minorUnits(this.currency), mode), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /**
   * Split into parts proportional to `weights`, rounded to minor units, with the
   * remainder distributed largest-remainder first so the parts always sum exactly
   * to the rounded total. Used for split bills, discount proration, and tender allocation.
   */
  allocate(weights: readonly DecimalInput[], mode: RoundingMode = 'HALF_UP'): Money[] {
    if (weights.length === 0) throw new RangeError('allocate requires at least one weight');
    const w = weights.map(toDec);
    if (w.some((x) => x.isNegative())) throw new RangeError('Weights must be non-negative');
    const totalWeight = w.reduce((a, b) => a.plus(b), new Dec(0));
    if (totalWeight.isZero()) throw new RangeError('Weights must not all be zero');

    const scale = minorUnits(this.currency);
    const unit = new Dec(10).pow(-scale);
    const total = roundTo(this.amount, scale, mode);
    const raw = w.map((x) => total.times(x).dividedBy(totalWeight));
    const floored = raw.map((x) => x.toDecimalPlaces(scale, Dec.ROUND_FLOOR));
    let remainderUnits = total
      .minus(floored.reduce((a, b) => a.plus(b), new Dec(0)))
      .dividedBy(unit)
      .toNumber();

    const order = raw
      .map((x, i) => ({ i, frac: x.minus(floored[i]!) }))
      .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
    const result = [...floored];
    for (let k = 0; remainderUnits > 0; k = (k + 1) % order.length, remainderUnits--) {
      const idx = order[k]!.i;
      result[idx] = result[idx]!.plus(unit);
    }
    return result.map((x) => new Money(x, this.currency));
  }

  /** Fixed-scale string for persistence in NUMERIC columns and API payloads. */
  toFixed(scale = minorUnits(this.currency)): string {
    return this.amount.toFixed(scale);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
