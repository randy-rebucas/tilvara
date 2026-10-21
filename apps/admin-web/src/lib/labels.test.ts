import { describe, expect, it } from 'vitest';
import { expandCopies, LAYOUTS, paginate, perPage, slotPosition } from './labels';

describe('label layouts', () => {
  it('fit their sheets', () => {
    for (const l of Object.values(LAYOUTS)) {
      const last = slotPosition(l, perPage(l) - 1);
      expect(last.x + l.w, l.key).toBeLessThanOrEqual(l.pageW + 0.01);
      expect(last.y + l.h, l.key).toBeLessThanOrEqual(l.pageH + 0.01);
    }
    expect(perPage(LAYOUTS.a4_21)).toBe(21);
    expect(perPage(LAYOUTS.a4_40)).toBe(40);
    expect(perPage(LAYOUTS.roll)).toBe(1);
  });

  it('repeats items by copies and fills pages, skipping used labels on the first sheet', () => {
    const labels = expandCopies([{ id: 'a', copies: 20 }, { id: 'b', copies: 3 }, { id: 'c', copies: 0 }]);
    expect(labels).toHaveLength(23);
    const pages = paginate(labels, LAYOUTS.a4_21, 2);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slice(0, 3)).toEqual([null, null, { id: 'a', copies: 20 }]);
    expect(pages[1]).toHaveLength(4);
    expect(paginate(labels, LAYOUTS.roll, 5)).toHaveLength(23);
    expect(paginate([], LAYOUTS.a4_40)).toEqual([]);
  });
});
