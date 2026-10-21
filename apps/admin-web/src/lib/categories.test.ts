import { describe, expect, it } from 'vitest';
import type { Category } from './api';
import { categoryOptions, categoryTree, subtreeIds } from './categories';

const cat = (id: string, name: string, parentId: string | null = null, extra: Partial<Category> = {}): Category => ({ id, name, parentId, sortOrder: 0, archivedAt: null, ...extra });

describe('product categories', () => {
  const list = [
    cat('d', 'Drinks'),
    cat('h', 'Hot drinks', 'd'),
    cat('c', 'Cold drinks', 'd'),
    cat('s', 'Snacks', null, { sortOrder: 1 }),
    cat('x', 'Old', null, { archivedAt: '2026-01-01T00:00:00Z' }),
    cat('o', 'Orphan', 'x'),
  ];

  it('lists active categories in tree order with depth and path', () => {
    expect(categoryTree(list).map((r) => [r.path, r.depth])).toEqual([
      ['Drinks', 0],
      ['Drinks › Cold drinks', 1],
      ['Drinks › Hot drinks', 1],
      ['Orphan', 0],
      ['Snacks', 0],
    ]);
  });

  it('cuts a loop instead of hanging', () => {
    const loop = [cat('a', 'A', 'b'), cat('b', 'B', 'a'), cat('r', 'Root')];
    expect(categoryTree(loop).map((r) => r.path)).toEqual(['Root']);
  });

  it('finds a category and everything under it', () => {
    expect([...subtreeIds(list, 'd')].sort()).toEqual(['c', 'd', 'h']);
    expect([...subtreeIds(list, 's')]).toEqual(['s']);
  });

  it('offers paths as picker options', () => {
    expect(categoryOptions(list).find((o) => o.id === 'h')?.label).toBe('Drinks › Hot drinks');
    expect(categoryOptions(undefined)).toEqual([]);
  });
});
