import { describe, expect, it } from 'vitest';
import { splitEqually, sumAmounts } from './money';

describe('splitEqually', () => {
  it('splits to the centavo, the extra centavos to the first shares', () => {
    expect(splitEqually('100.00', 3)).toEqual(['33.34', '33.33', '33.33']);
    expect(splitEqually('0.05', 2)).toEqual(['0.03', '0.02']);
    expect(splitEqually('50', 2)).toEqual(['25.00', '25.00']);
  });

  it('always adds up to the amount', () => {
    for (const [amount, n] of [['99.99', 7], ['1.00', 3], ['250.50', 4]] as const) {
      expect(sumAmounts(splitEqually(amount, n))).toBe(amount);
    }
  });

  it('gives nothing for no one', () => {
    expect(splitEqually('10.00', 0)).toEqual([]);
  });
});
