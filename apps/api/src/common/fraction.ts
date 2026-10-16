import { toDec } from '@1pos/money';

/** An exact non-negative fraction (bill shares, ADR-0014 §8). Never floats. */
export interface Fraction {
  n: bigint;
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

export function frac(n: bigint | number, d: bigint | number = 1n): Fraction {
  const N = BigInt(n);
  const D = BigInt(d);
  if (D <= 0n) throw new RangeError('denominator must be positive');
  const g = gcd(N, D) || 1n;
  return { n: N / g, d: D / g };
}

export const ZERO_FRACTION = frac(0);
export const ONE_FRACTION = frac(1);

export const addFraction = (a: Fraction, b: Fraction) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const subFraction = (a: Fraction, b: Fraction) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const compareFraction = (a: Fraction, b: Fraction) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

/** `part / whole` of two decimal strings with up to 4 dp, exactly (e.g. "1" of "3" → 1/3). */
export function ratioOf(part: string, whole: string): Fraction {
  const scale = (v: string) => BigInt(toDec(v).times(10_000).toFixed(0));
  return frac(scale(part), scale(whole));
}

/** The fraction as a decimal string for multiplication (enough digits for 4-dp money and quantities). */
export const fractionDec = (f: Fraction) => toDec(f.n.toString()).dividedBy(f.d.toString());
