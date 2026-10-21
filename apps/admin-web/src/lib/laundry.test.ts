import { describe, expect, it } from 'vitest';
import { billedQuantity, jobIsOpen, loadsFor, minimumApplies, nextSteps } from './laundry';

describe('laundry quantities (ADR-0024 §2)', () => {
  it('suggests loads from a weight, rounding up', () => {
    expect(loadsFor('8', '8')).toBe('1');
    expect(loadsFor('8.001', '8')).toBe('2');
    expect(loadsFor('17.5', '8')).toBe('3');
    expect(loadsFor('0.1', '7.5')).toBe('1');
    expect(loadsFor('', '8')).toBeNull();
    expect(loadsFor('5', null)).toBeNull();
    expect(loadsFor('0', '8')).toBeNull();
  });

  it('bills the minimum when the measured quantity is below it, without floats', () => {
    expect(billedQuantity('2.4', '3')).toBe('3');
    expect(billedQuantity('3.25', '3')).toBe('3.25');
    expect(billedQuantity('0.3', null)).toBe('0.3');
    expect(billedQuantity('1.100', '1.1')).toBe('1.1');
    expect(minimumApplies('2.4', '3')).toBe(true);
    expect(minimumApplies('3.25', '3.25')).toBe(false);
  });

  it('moves a job forward only, READY back to folding', () => {
    expect(nextSteps('RECEIVED')).toEqual(['WASHING', 'DRYING', 'FOLDING', 'READY']);
    expect(nextSteps('DRYING')).toEqual(['FOLDING', 'READY']);
    expect(nextSteps('READY')).toEqual(['FOLDING']);
    expect(nextSteps('CLAIMED')).toEqual([]);
    expect(jobIsOpen('OUT_FOR_DELIVERY')).toBe(true);
    expect(jobIsOpen('DISPOSED')).toBe(false);
  });
});
