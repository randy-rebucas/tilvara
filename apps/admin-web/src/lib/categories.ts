import type { Category } from './api';

export interface CategoryRow {
  category: Category;
  depth: number;
  /** "Drinks › Hot drinks": the names from the top of the tree down to this one. */
  path: string;
}

/**
 * Active categories in tree order (each followed by its sub-categories, by sort order then name),
 * with their depth and full path. A category whose parent is archived or missing shows at the top,
 * so nothing active is hidden; a loop in the data (never made by these screens) is cut.
 */
export function categoryTree(categories: readonly Category[]): CategoryRow[] {
  const live = categories.filter((c) => !c.archivedAt);
  const ids = new Set(live.map((c) => c.id));
  const byParent = new Map<string | null, Category[]>();
  for (const c of live) {
    const parent = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  const order = (a: Category, b: Category) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const rows: CategoryRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, prefix: string) => {
    for (const c of [...(byParent.get(parent) ?? [])].sort(order)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const path = prefix ? `${prefix} › ${c.name}` : c.name;
      rows.push({ category: c, depth, path });
      walk(c.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return rows;
}

/** This category and every category under it (a category cannot move under one of these). */
export function subtreeIds(categories: readonly Category[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Picker options for a product's category: every active category by its full path. */
export const categoryOptions = (categories: readonly Category[] | undefined) =>
  categoryTree(categories ?? []).map((r) => ({ id: r.category.id, label: r.path }));
