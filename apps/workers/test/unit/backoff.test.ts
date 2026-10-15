import { describe, expect, it } from 'vitest';
import { defaultRetryDelay } from '../../src/outbox-processor.js';

describe('defaultRetryDelay', () => {
  it('grows exponentially from ~5s with ±20% jitter', () => {
    for (let i = 0; i < 50; i++) {
      expect(defaultRetryDelay(1)).toBeGreaterThanOrEqual(4);
      expect(defaultRetryDelay(1)).toBeLessThanOrEqual(6);
      expect(defaultRetryDelay(4)).toBeGreaterThanOrEqual(32);
      expect(defaultRetryDelay(4)).toBeLessThanOrEqual(48);
    }
  });

  it('caps at one hour (+jitter)', () => {
    for (let i = 0; i < 50; i++) expect(defaultRetryDelay(40)).toBeLessThanOrEqual(4320);
  });
});
