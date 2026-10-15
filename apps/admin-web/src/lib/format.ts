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
  return `${sign}₱${whole}.${c}`;
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

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
