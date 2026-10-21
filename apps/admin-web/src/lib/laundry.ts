/**
 * Laundry quantities on the job form (ADR-0024 §2), as decimal strings (never through a float):
 * kilos have up to 3 decimals, so they are compared and divided as whole grams.
 */
const KILOS = /^\d{1,6}(\.\d{1,3})?$/;

export const isKilos = (s: string) => KILOS.test(s.trim());

/** "5.25" → 5250n grams; null when not a quantity. */
function grams(s: string): bigint | null {
  const v = s.trim();
  if (!KILOS.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole!) * 1000n + BigInt(frac.padEnd(3, '0'));
}

const fromGrams = (g: bigint) => {
  const whole = g / 1000n;
  const frac = (g % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/** Loads for a weight: ⌈weight ÷ kilos per load⌉, at least one; null when either is missing or zero. */
export function loadsFor(weight: string, kgPerLoad: string | null | undefined): string | null {
  const w = grams(weight);
  const per = kgPerLoad ? grams(kgPerLoad) : null;
  if (w === null || per === null || w === 0n || per === 0n) return null;
  return String((w + per - 1n) / per);
}

/** What a job line bills: the measured quantity, or the service's minimum when it is more. */
export function billedQuantity(measured: string, min: string | null | undefined): string {
  const m = grams(measured);
  const floor = min ? grams(min) : null;
  if (m === null) return measured;
  return floor !== null && floor > m ? fromGrams(floor) : fromGrams(m);
}

/** Whether a line bills more than was measured (the minimum applied). */
export const minimumApplies = (measured: string, billed: string) => {
  const a = grams(measured);
  const b = grams(billed);
  return a !== null && b !== null && b > a;
};

/** The processing steps a job is moved through by hand (§3), in order. */
export const JOB_STEPS = ['WASHING', 'DRYING', 'FOLDING', 'READY'] as const;
const ORDER = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY'] as const;

/** Steps forward from a status (skipping is allowed); READY may go back to FOLDING with a note. */
export function nextSteps(status: string): (typeof JOB_STEPS)[number][] {
  const at = (ORDER as readonly string[]).indexOf(status);
  if (at < 0) return [];
  if (status === 'READY') return ['FOLDING'];
  return JOB_STEPS.filter((s) => ORDER.indexOf(s) > at);
}

/** Still at the shop or out with a rider: not claimed, cancelled or disposed. */
export const jobIsOpen = (status: string) => !['CLAIMED', 'CANCELLED', 'DISPOSED'].includes(status);
