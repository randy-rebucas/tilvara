/**
 * ISO 4217 currencies Tilvara currently understands. Extend deliberately: every new
 * currency needs a minor-unit scale and a reviewed cash-rounding policy.
 */
export const CURRENCIES = {
  PHP: { code: 'PHP', minorUnits: 2 },
  USD: { code: 'USD', minorUnits: 2 },
  JPY: { code: 'JPY', minorUnits: 0 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function minorUnits(currency: CurrencyCode): number {
  return CURRENCIES[currency].minorUnits;
}
