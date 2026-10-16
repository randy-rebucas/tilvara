/**
 * Exact shares of a bill line (ADR-0014 §8) for "split what is left evenly". Integer fractions only;
 * the server prices every share, the till only says which share each check pays.
 */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** "n/d" (paid so far) → what is left of the whole line, as [num, den]. */
export function remainingShare(paid: string): [number, number] {
  const [n, d] = paid.split('/').map(Number) as [number, number];
  const g = gcd(d - n, d) || 1;
  return [(d - n) / g, d / g];
}

/** One of `ways` equal parts of what is left, or null when the API's 999 denominator limit is exceeded. */
export function partOfRest(paid: string, ways: number): { num: number; den: number } | null {
  const [n, d] = remainingShare(paid);
  if (n === 0) return null;
  const den = d * ways;
  const g = gcd(n, den);
  const share = { num: n / g, den: den / g };
  return share.den > 999 ? null : share;
}
