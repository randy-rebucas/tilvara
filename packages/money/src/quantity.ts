import { Dec, DecimalInput, RoundingMode, roundTo, toDec } from './decimal.js';

/** Persisted quantity scale: NUMERIC(18,4) supports weighed goods (kg to 0.1 g) and fractional units. */
export const QUANTITY_SCALE = 4;

export function quantity(value: DecimalInput, mode: RoundingMode = 'HALF_UP'): Dec {
  return roundTo(toDec(value), QUANTITY_SCALE, mode);
}

/**
 * Convert between units of measure using a factor expressed as
 * "1 `from` = factor `to`" (e.g. 1 kg = 1000 g).
 */
export function convertQuantity(value: DecimalInput, factor: DecimalInput): Dec {
  const f = toDec(factor);
  if (f.lessThanOrEqualTo(0)) throw new RangeError('Conversion factor must be positive');
  return toDec(value).times(f);
}
