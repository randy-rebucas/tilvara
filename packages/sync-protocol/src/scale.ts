/**
 * Weighing-scale labels (session 16). A scale prints an in-store EAN-13: `2` + a 5-digit item code +
 * the weight in grams (5 digits) + the check digit, e.g. 2 12345 01234 C = item "212345", 1.234 kg.
 * The item is the one with a barcode equal to the label's first six characters (its "scale code").
 * Only weight labels: a price-embedded label would have to be divided back into a quantity, which the
 * server's re-pricing could not reproduce exactly, so such labels are not read as scale labels.
 */
export interface ScaleLabel {
  /** The barcode to look the item up by: the first six characters. */
  key: string;
  /** Kilograms, as an exact decimal string with three places ("1.234"). */
  quantity: string;
}

/** EAN-13 check digit of the first twelve digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** The label's item key and weight, or null when the code is not a valid scale label (or weighs nothing). */
export function parseScaleLabel(code: string): ScaleLabel | null {
  const c = code.trim();
  if (!/^2\d{12}$/.test(c)) return null;
  if (ean13CheckDigit(c.slice(0, 12)) !== Number(c[12])) return null;
  const grams = c.slice(6, 11);
  if (/^0+$/.test(grams)) return null;
  const kg = grams.slice(0, 2).replace(/^0/, '');
  return { key: c.slice(0, 6), quantity: `${kg}.${grams.slice(2)}` };
}
