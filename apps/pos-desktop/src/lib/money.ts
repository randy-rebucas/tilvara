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
