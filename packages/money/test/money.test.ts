import { describe, expect, it } from 'vitest';
import {
  convertQuantity,
  CurrencyMismatchError,
  InvalidDecimalError,
  Money,
  quantity,
  toDec,
} from '../src/index.js';

describe('toDec', () => {
  it('accepts plain decimal strings and bigint', () => {
    expect(toDec('12.50').toString()).toBe('12.5');
    expect(toDec(' -3 ').toString()).toBe('-3');
    expect(toDec(10n).toString()).toBe('10');
  });

  it('rejects numbers, exponent notation and garbage', () => {
    expect(() => toDec(0.1 as unknown as string)).toThrow(InvalidDecimalError);
    expect(() => toDec('1e3')).toThrow(InvalidDecimalError);
    expect(() => toDec('12,50')).toThrow(InvalidDecimalError);
    expect(() => toDec('')).toThrow(InvalidDecimalError);
  });
});

describe('Money', () => {
  it('has no binary floating point drift', () => {
    const total = Money.of('0.1', 'PHP').add(Money.of('0.2', 'PHP'));
    expect(total.toFixed()).toBe('0.30');
    expect(total.equals(Money.of('0.3', 'PHP'))).toBe(true);
  });

  it('keeps intermediate precision until rounded', () => {
    // 3 × 33.335 = 100.005 → rounds once to 100.01 (HALF_UP)
    const line = Money.of('33.335', 'PHP').multiply('3');
    expect(line.amount.toString()).toBe('100.005');
    expect(line.round().toFixed()).toBe('100.01');
    expect(line.round('HALF_EVEN').toFixed()).toBe('100.00');
  });

  it('rounds to currency minor units', () => {
    expect(Money.of('100.5', 'JPY').round().toFixed()).toBe('101');
    expect(Money.of('1.005', 'PHP').round().toFixed()).toBe('1.01');
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of('1', 'PHP').add(Money.of('1', 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('rejects division by zero', () => {
    expect(() => Money.of('1', 'PHP').divide('0')).toThrow(RangeError);
  });

  it('serialises amount as a string, never a number', () => {
    expect(JSON.parse(JSON.stringify(Money.of('19.99', 'PHP')))).toEqual({ amount: '19.99', currency: 'PHP' });
  });
});

describe('Money.allocate', () => {
  it('splits evenly with the remainder going to the earliest parts', () => {
    const parts = Money.of('100', 'PHP').allocate(['1', '1', '1']);
    expect(parts.map((p) => p.toFixed())).toEqual(['33.34', '33.33', '33.33']);
  });

  it('always sums exactly to the rounded total', () => {
    const total = Money.of('1234.57', 'PHP');
    const weights = ['3.1', '7', '0.5', '11.25', '2'];
    const parts = total.allocate(weights);
    expect(Money.sum(parts, 'PHP').toFixed()).toBe('1234.57');
  });

  it('gives the remainder to the part with the largest fractional share', () => {
    // 10 split 1:2 → 3.333… / 6.666… → 3.33 / 6.67
    const parts = Money.of('10', 'PHP').allocate(['1', '2']);
    expect(parts.map((p) => p.toFixed())).toEqual(['3.33', '6.67']);
  });

  it('handles zero weights and negative totals (refund proration)', () => {
    const parts = Money.of('-10', 'PHP').allocate(['1', '0', '2']);
    expect(Money.sum(parts, 'PHP').toFixed()).toBe('-10.00');
    expect(parts[1]!.isZero()).toBe(true);
  });

  it('rejects invalid weights', () => {
    expect(() => Money.of('1', 'PHP').allocate([])).toThrow(RangeError);
    expect(() => Money.of('1', 'PHP').allocate(['0', '0'])).toThrow(RangeError);
    expect(() => Money.of('1', 'PHP').allocate(['-1', '2'])).toThrow(RangeError);
  });
});

describe('quantity', () => {
  it('rounds to 4 decimal places', () => {
    expect(quantity('1.23456').toString()).toBe('1.2346');
  });

  it('converts units', () => {
    expect(convertQuantity('0.25', '1000').toString()).toBe('250');
    expect(() => convertQuantity('1', '0')).toThrow(RangeError);
  });
});
