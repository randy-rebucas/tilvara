/**
 * Money arrives as exact decimal strings ("49.7500"). Format without ever going through a
 * float: split the string, round half-up to centavos on the digits themselves.
 */
export function peso(amount: string | null | undefined): string {
  if (amount == null) return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return amount;
  const [, sign, int, frac = ''] = m;
  let cents = BigInt(int! + (frac + '00').slice(0, 2));
  if ((frac[2] ?? '0') >= '5') cents += 1n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const c = (cents % 100n).toString().padStart(2, '0');
  // A true minus sign (U+2212): a hyphen reads as a dash in tabular money columns.
  return `${sign && cents > 0n ? '−' : ''}₱${whole}.${c}`;
}

export function formatTin(tin: string | null): string {
  if (!tin) return '—';
  return tin.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1-$2-$3');
}

export function formatDateTime(iso: string | null | undefined, lang: 'en' | 'fil'): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(lang === 'fil' ? 'fil-PH' : 'en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  }).format(new Date(iso));
}

const SCALE = 10_000n;
function toUnits(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{0,4}))?\d*$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal: ${value}`);
  const units = BigInt(m[2]!) * SCALE + BigInt((m[3] ?? '').padEnd(4, '0'));
  return m[1] ? -units : units;
}

/** Exact sum of decimal strings (4 places, never through floats) → decimal string. */
export function sumDecimal(values: string[]): string {
  const total = values.reduce((a, v) => a + toUnits(v), 0n);
  const abs = total < 0n ? -total : total;
  return `${total < 0n ? '-' : ''}${abs / SCALE}.${(abs % SCALE).toString().padStart(4, '0')}`;
}

/** -1, 0 or 1 for a decimal string. */
export function signOf(value: string): -1 | 0 | 1 {
  const u = toUnits(value);
  return u < 0n ? -1 : u > 0n ? 1 : 0;
}

/** A change shown with its sign spelled out: "+2", "−2", "0" (never colour alone). */
export function signed(value: string, fmt: (s: string) => string = qty): string {
  const s = signOf(value);
  return s < 0 ? `−${fmt(value.trim().slice(1))}` : s > 0 ? `+${fmt(value)}` : fmt(value);
}

/** Quantities arrive as decimal strings ("12.000"): drop trailing zeros, group thousands. */
export function qty(value: string | null | undefined): string {
  if (value == null) return '—';
  const m = /^(-?)(\d+)(?:\.(\d*?))?0*$/.exec(value.trim());
  if (!m) return value;
  const [, sign, int, frac] = m;
  return `${sign}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

/** A plain YYYY-MM-DD (a local business date, no time zone) for display. */
export function formatDate(date: string | null | undefined, lang: 'en' | 'fil'): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'fil' ? 'fil-PH' : 'en-PH', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Today's date in Manila as YYYY-MM-DD (default report ranges; the API judges the real local day). */
export function todayManila(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
