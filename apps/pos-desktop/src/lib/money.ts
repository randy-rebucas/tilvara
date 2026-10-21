import { toDec } from '@1pos/money';

/** Peso display from a decimal string — never via JS numbers. */
export function peso(amount: string | null | undefined): string {
  if (amount == null) return '—';
  const d = toDec(amount);
  const negative = d.isNegative() && !d.isZero();
  const [whole, cents] = d.abs().toFixed(2).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}₱${grouped}.${cents}`;
}

/** Validated keypad entry → canonical decimal string (or null when not a valid amount). */
export function parseAmount(input: string): string | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null;
  return toDec(s.endsWith('.') ? `${s}0` : s).toFixed(2);
}

export const add = (a: string, b: string) => toDec(a).plus(b).toFixed(2);
export const sub = (a: string, b: string) => toDec(a).minus(b).toFixed(2);
export const gte = (a: string, b: string) => toDec(a).gte(b);
export const isZero = (a: string) => toDec(a).isZero();
export const isPositive = (a: string) => toDec(a).gt(0);

/** Quick-tender suggestions: exact, then the next round peso notes above the total. */
export function quickTenders(due: string): string[] {
  const d = toDec(due);
  const out = new Set<string>([d.toFixed(2)]);
  for (const note of [20, 50, 100, 200, 500, 1000]) {
    const up = d.dividedBy(note).ceil().times(note);
    if (up.gt(d)) out.add(up.toFixed(2));
    if (out.size >= 4) break;
  }
  return [...out];
}

/**
 * An amount split equally into `n` shares to the centavo, the extra centavos going to the first shares
 * (as the server splits a tip, ADR-0022 §7). Decimal strings only; the shares always add up to `amount`.
 */
export function splitEqually(amount: string, n: number): string[] {
  if (n < 1) return [];
  const cents = toDec(amount).times(100).toDecimalPlaces(0);
  const base = cents.dividedBy(n).floor();
  // The centavos left over (fewer than n): one more to each of the first shares.
  const extra = cents.minus(base.times(n));
  return Array.from({ length: n }, (_, i) => (extra.gt(i) ? base.plus(1) : base).dividedBy(100).toFixed(2));
}

/** Sum of decimal strings, to the centavo. */
export const sumAmounts = (xs: readonly string[]) => xs.reduce((a, x) => add(a, x), '0.00');
