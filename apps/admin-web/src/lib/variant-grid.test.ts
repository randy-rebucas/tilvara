import { describe, expect, it } from 'vitest';
import { combinationCount, combinations, MAX_COMBINATIONS, optionsFrom, sameAttributes, skuFor, SKU_PATTERN, splitValues } from './variant-grid';

describe('sizes and colours', () => {
  it('splits values on commas and lines, without repeats', () => {
    expect(splitValues('S, M,L\nXL, m')).toEqual(['S', 'M', 'L', 'XL']);
    expect(splitValues(' , ')).toEqual([]);
  });

  it('builds SKUs from the base and the values, in the SKU pattern', () => {
    expect(skuFor('tee', ['M', 'Navy blue'])).toBe('TEE-M-NAVY-BLUE');
    expect(skuFor('TEE', ['Ñ+', '2/3'])).toBe('TEE-2/3');
    expect(skuFor('', ['--'])).toBeNull();
    const long = skuFor('X'.repeat(60), ['LONGVALUE']);
    expect(long!.length).toBeLessThanOrEqual(64);
    expect(SKU_PATTERN.test(long!)).toBe(true);
  });

  it('makes every combination, first option slowest', () => {
    const rows = combinations('TEE', [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Black', 'White'] },
      { name: '', values: ['ignored'] },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['S / Black', 'S / White', 'M / Black', 'M / White']);
    expect(rows[2]).toEqual({ sku: 'TEE-M-BLACK', name: 'M / Black', attributes: { Size: 'M', Colour: 'Black' } });
  });

  it('stops at 100 combinations', () => {
    const many = [{ name: 'A', values: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { name: 'B', values: Array.from({ length: 10 }, (_, i) => `b${i}`) }];
    expect(combinationCount(many)).toBe(110);
    expect(() => combinations('X', many)).toThrow();
    expect(combinations('X', [{ name: 'A', values: Array.from({ length: MAX_COMBINATIONS }, (_, i) => `${i}`) }])).toHaveLength(100);
  });

  it('matches attributes regardless of case and order, and reads options back from variants', () => {
    expect(sameAttributes({ Size: 'M', Colour: 'Black' }, { colour: 'black', size: 'm' })).toBe(true);
    expect(sameAttributes({ Size: 'M' }, { Size: 'M', Colour: 'Black' })).toBe(false);
    expect(optionsFrom([{ attributes: { Size: 'S', Colour: 'Red' } }, { attributes: { Size: 'M', Colour: 'red' } }, { attributes: null }])).toEqual([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Red'] },
    ]);
  });
});
