import { describe, expect, it } from 'vitest';
import { openDrawerFor } from './drawer';

describe('the cash drawer after a sale or refund', () => {
  it('opens only when cash changed hands and a drawer is wired, and a failing drawer never throws', async () => {
    let opened = 0;
    const drawer = { available: true, open: async () => void opened++ };
    openDrawerFor(drawer, false);
    openDrawerFor(drawer, true);
    openDrawerFor({ available: false, open: async () => void opened++ }, true);
    openDrawerFor({ available: true, open: () => Promise.reject(new Error('The printer did not answer')) }, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe(1);
  });
});
