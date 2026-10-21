import { describe, expect, it } from 'vitest';
import { toDec } from '@1pos/money';
import { allocate, applyPromotions, PromotionError, type Promotion, type PromotionLine } from '../src/index.js';

const R = { scale: 2, mode: 'HALF_UP' as const };
const line = (id: string, variantId: string, unitPrice: string, quantity: string, eligible = true): PromotionLine => ({ id, variantId, unitPrice, quantity, eligible });
const promo = (p: Partial<Promotion> & Pick<Promotion, 'id' | 'kind' | 'variantIds'>): Promotion => ({ name: p.id, startsAt: '2026-10-01T00:00:00.000Z', ...p });

describe('allocate', () => {
  it('splits exactly by largest remainder', () => {
    const parts = allocate(toDec('10.00'), [toDec('1'), toDec('1'), toDec('1')], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['3.34', '3.33', '3.33']);
  });
  it('gives everything to the first part when there is no weight', () => {
    expect(allocate(toDec('1.00'), [toDec('0'), toDec('0')], 2).map((p) => p.toFixed(2))).toEqual(['1.00', '0.00']);
  });
});

describe('MULTI_BUY', () => {
  const p = promo({ id: 'p3', kind: 'MULTI_BUY', variantIds: ['a', 'b'], quantity: 3, price: '100' });

  it('prices groups of N at the set price, leftovers at list price', () => {
    const [r] = applyPromotions([line('1', 'a', '40', '4')], [p], R);
    // 3 × 40 = 120 → 100: 20 off; the fourth unit pays full price.
    expect(r).toEqual({ id: '1', promotionId: 'p3', discount: '20.00' });
  });

  it('mixes and matches across items, dearest first, split in proportion', () => {
    const res = applyPromotions([line('1', 'a', '50', '1'), line('2', 'b', '30', '2'), line('3', 'b', '10', '1')], [p], R);
    // Units: 50, 30, 30 | 10. Group 110 → 100: 10 off over 50 and 60.
    expect(res.map((r) => r.discount)).toEqual(['4.55', '5.45', null]);
    expect(res[2]!.promotionId).toBeNull();
  });

  it('gives nothing when the set price is above the regular price', () => {
    expect(applyPromotions([line('1', 'a', '20', '3')], [p], R)[0]!.discount).toBeNull();
  });

  it('counts whole units only and skips ineligible lines', () => {
    const res = applyPromotions([line('1', 'a', '40', '2.5'), line('2', 'a', '40', '3', false)], [p], R);
    expect(res.map((r) => r.discount)).toEqual([null, null]);
  });

  it('handles large quantities without walking unit by unit', () => {
    const [r] = applyPromotions([line('1', 'a', '40', '30000')], [p], R);
    expect(r!.discount).toBe('200000.00');
  });
});

describe('BUY_X_GET_Y', () => {
  const p = promo({ id: 'b1g1', kind: 'BUY_X_GET_Y', variantIds: ['a', 'b'], buyQuantity: 1, getQuantity: 1, getRate: '1' });

  it('gives the cheaper unit of each pair free', () => {
    const res = applyPromotions([line('1', 'a', '500', '1'), line('2', 'b', '300', '1')], [p], R);
    expect(res).toEqual([
      { id: '1', promotionId: 'b1g1', discount: '0.00' },
      { id: '2', promotionId: 'b1g1', discount: '300.00' },
    ]);
  });

  it('applies a partial rate and repeats per group', () => {
    const half = promo({ id: 'b2g1', kind: 'BUY_X_GET_Y', variantIds: ['a'], buyQuantity: 2, getQuantity: 1, getRate: '0.5' });
    // 7 units: two groups of 3 → 2 units at half price; one left over.
    expect(applyPromotions([line('1', 'a', '99.99', '7')], [half], R)[0]!.discount).toBe('99.99');
  });
});

describe('QUANTITY_BREAK', () => {
  const p = promo({
    id: 'qb', kind: 'QUANTITY_BREAK', variantIds: ['a', 'b'],
    tiers: [{ minQuantity: '6', rate: '0.05' }, { minQuantity: '12', rate: '0.1' }],
  });

  it('applies the highest tier reached by the whole set, decimals allowed', () => {
    const res = applyPromotions([line('1', 'a', '10', '10'), line('2', 'b', '33.33', '2.5')], [p], R);
    // 12.5 units → 10 %: 100 → 10.00; 83.33 (83.325 rounded) → 8.33
    expect(res.map((r) => r.discount)).toEqual(['10.00', '8.33']);
  });

  it('applies nothing below the first tier', () => {
    expect(applyPromotions([line('1', 'a', '10', '5')], [p], R)[0]!.discount).toBeNull();
  });
});

describe('choosing between promotions', () => {
  it('gives each line the best promotion once, then the rest to what remains', () => {
    const three = promo({ id: 'm', kind: 'MULTI_BUY', variantIds: ['a', 'b'], quantity: 3, price: '100' });
    const bogo = promo({ id: 'g', kind: 'BUY_X_GET_Y', variantIds: ['b', 'c'], buyQuantity: 1, getQuantity: 1, getRate: '1' });
    const res = applyPromotions([line('1', 'a', '50', '3'), line('2', 'b', '40', '2'), line('3', 'c', '40', '2')], [three, bogo], R);
    // Multi-buy on a+b: units 50,50,50 | 40,40 → one group, 50 off, claims line 1 only (b took no part).
    // BOGO on b+c: 4 units at 40 → 2 free: 80 off. BOGO wins first (80 > 50) and claims b and c; then multi-buy on a: 50 off.
    expect(res.map((r) => [r.promotionId, r.discount])).toEqual([['m', '50.00'], ['g', '40.00'], ['g', '40.00']]);
  });

  it('breaks a tie by the earlier start, then the id', () => {
    const a = promo({ id: 'z', kind: 'QUANTITY_BREAK', variantIds: ['a'], startsAt: '2026-09-01T00:00:00.000Z', tiers: [{ minQuantity: '1', rate: '0.1' }] });
    const b = promo({ id: 'y', kind: 'QUANTITY_BREAK', variantIds: ['a'], tiers: [{ minQuantity: '1', rate: '0.1' }] });
    expect(applyPromotions([line('1', 'a', '10', '1')], [b, a], R)[0]!.promotionId).toBe('z');
  });

  it('is independent of the order promotions are given in', () => {
    const p1 = promo({ id: 'p1', kind: 'MULTI_BUY', variantIds: ['a'], quantity: 2, price: '15' });
    const p2 = promo({ id: 'p2', kind: 'QUANTITY_BREAK', variantIds: ['a'], tiers: [{ minQuantity: '2', rate: '0.2' }] });
    const lines = [line('1', 'a', '10', '2')];
    expect(applyPromotions(lines, [p1, p2], R)).toEqual(applyPromotions(lines, [p2, p1], R));
    expect(applyPromotions(lines, [p1, p2], R)[0]!.promotionId).toBe('p1');
  });
});

describe('invalid definitions', () => {
  it('refuses a multi-buy without a whole quantity', () => {
    const bad = promo({ id: 'x', kind: 'MULTI_BUY', variantIds: ['a'], quantity: 1.5, price: '10' });
    expect(() => applyPromotions([line('1', 'a', '10', '2')], [bad], R)).toThrow(PromotionError);
  });
  it('refuses a rate above 1', () => {
    const bad = promo({ id: 'x', kind: 'QUANTITY_BREAK', variantIds: ['a'], tiers: [{ minQuantity: '1', rate: '1.5' }] });
    expect(() => applyPromotions([line('1', 'a', '10', '2')], [bad], R)).toThrow(PromotionError);
  });
});
