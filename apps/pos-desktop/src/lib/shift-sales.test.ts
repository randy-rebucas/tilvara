import { describe, expect, it } from 'vitest';
import { shiftSales } from './shift-sales';
import type { SaleSummary } from '../types';

describe('shiftSales (audit 2026-10-27 #15)', () => {
  it('follows nextCursor to the end, so every sale of a busy shift is listed', async () => {
    const asked: string[] = [];
    const pages: Record<string, { data: Partial<SaleSummary>[]; nextCursor: string | null }> = {
      '': { data: [{ id: 'c' }, { id: 'b' }], nextCursor: 'b' },
      b: { data: [], nextCursor: 'x' }, // a short page with a cursor only means "look further"
      x: { data: [{ id: 'a' }], nextCursor: null },
    };
    const get = (async (_m: string, path: string) => {
      asked.push(path);
      return pages[new URL(path, 'http://till').searchParams.get('cursor') ?? '']!;
    }) as never;
    expect((await shiftSales('s1', get)).map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(asked).toEqual([
      '/v1/sales?cashierSessionId=s1&limit=200',
      '/v1/sales?cashierSessionId=s1&limit=200&cursor=b',
      '/v1/sales?cashierSessionId=s1&limit=200&cursor=x',
    ]);
  });

  it('stops after a bounded number of pages', async () => {
    let n = 0;
    const get = (async () => ({ data: [{ id: String(++n) }], nextCursor: 'again' })) as never;
    expect((await shiftSales('s1', get)).length).toBe(100);
  });
});
