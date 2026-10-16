import { describe, expect, it } from 'vitest';
import { peso, percentFromRate, qty, rateFromPercent, signOf, sumDecimal } from './format';

describe('percentFromRate / rateFromPercent', () => {
  it('moves the decimal point in the string, both ways', () => {
    expect(['0.1', '0.125', '0.05', '0', '0.100000', '1'].map(percentFromRate)).toEqual(['10', '12.5', '5', '0', '10', '100']);
    expect(['10', '12.5', '5', '0', '0.5', '100'].map(rateFromPercent)).toEqual(['0.1', '0.125', '0.05', '0', '0.005', '1']);
  });
  it('refuses what is not a percentage', () => {
    expect(['', '-1', '101', '100.5', '1e2', '12.34567', 'ten'].map(rateFromPercent)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('peso', () => {
  it('rounds half-up on the digits and groups thousands', () => {
    expect(peso('49.7500')).toBe('₱49.75');
    expect(peso('1234567.005')).toBe('₱1,234,567.01');
    expect(peso('0.0049')).toBe('₱0.00');
  });
  it('prints negatives with a true minus sign, and never a negative zero', () => {
    expect(peso('-852.00')).toBe('−₱852.00');
    expect(peso('-0.0001')).toBe('₱0.00');
  });
});

describe('qty', () => {
  it('drops trailing zeros and groups thousands', () => {
    expect(qty('12.000')).toBe('12');
    expect(qty('0.250')).toBe('0.25');
    expect(qty('100.500')).toBe('100.5');
    expect(qty('120')).toBe('120');
    expect(qty('-1500.0000')).toBe('-1,500');
  });
});

describe('sumDecimal / signOf', () => {
  it('adds decimal strings exactly (no float drift)', () => {
    expect(sumDecimal(['0.10', '0.20'])).toBe('0.3000');
    expect(sumDecimal(Array.from({ length: 1000 }, () => '0.01'))).toBe('10.0000');
    expect(sumDecimal(['754.00', '60.00', '-814.00'])).toBe('0.0000');
    expect(sumDecimal(['-23.0000', '1.5'])).toBe('-21.5000');
    expect(sumDecimal([])).toBe('0.0000');
  });
  it('reads the sign of a decimal string', () => {
    expect(signOf('-0.0001')).toBe(-1);
    expect(signOf('0.000')).toBe(0);
    expect(signOf('-0')).toBe(0);
    expect(signOf('4')).toBe(1);
  });
  it('refuses something that is not a decimal', () => {
    expect(() => sumDecimal(['1e3'])).toThrow();
  });
});
