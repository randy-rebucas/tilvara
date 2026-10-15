import { Decimal as DecimalJs } from 'decimal.js';

/**
 * Isolated Decimal constructor so configuration never leaks into (or from) other
 * decimal.js users. 40 significant digits comfortably covers NUMERIC(20,4)
 * intermediate products (price × quantity × rate).
 */
export const Dec = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

export type Dec = InstanceType<typeof Dec>;

/** Values accepted at module boundaries. `number` is deliberately excluded to avoid float drift. */
export type DecimalInput = string | bigint | Dec;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function toDec(value: DecimalInput): Dec {
  if (value instanceof Dec) return value;
  if (typeof value === 'bigint') return new Dec(value.toString());
  if (typeof value !== 'string' || !DECIMAL_STRING.test(value.trim())) {
    throw new InvalidDecimalError(String(value));
  }
  return new Dec(value.trim());
}

export class InvalidDecimalError extends Error {
  constructor(value: string) {
    super(`Invalid decimal value: "${value}". Use a plain decimal string such as "12.50".`);
    this.name = 'InvalidDecimalError';
  }
}

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

export function roundingConstant(mode: RoundingMode): DecimalJs.Rounding {
  switch (mode) {
    case 'HALF_UP':
      return DecimalJs.ROUND_HALF_UP;
    case 'HALF_EVEN':
      return DecimalJs.ROUND_HALF_EVEN;
    case 'DOWN':
      return DecimalJs.ROUND_DOWN;
    case 'UP':
      return DecimalJs.ROUND_UP;
  }
}

export function roundTo(value: Dec, scale: number, mode: RoundingMode = 'HALF_UP'): Dec {
  return value.toDecimalPlaces(scale, roundingConstant(mode));
}
