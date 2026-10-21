/**
 * Label layouts (ADR-0021 §4), in millimetres. Sheets are A4 with the labels on a grid; the roll
 * prints one label per page of its own size.
 */
export type LayoutKey = 'a4_21' | 'a4_40' | 'roll' | 'shelf';

export interface Layout {
  key: LayoutKey;
  /** CSS @page size. */
  page: string;
  pageW: number;
  pageH: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  left: number;
  top: number;
  gapX: number;
  gapY: number;
  /** Shelf-edge strip: the price is the biggest thing on it. */
  shelf?: true;
}

export const LAYOUTS: Record<LayoutKey, Layout> = {
  // 3 × 7 of 63.5 × 38.1 mm (the common 21-up sheet).
  a4_21: { key: 'a4_21', page: 'A4', pageW: 210, pageH: 297, w: 63.5, h: 38.1, cols: 3, rows: 7, left: 7.2, top: 15.15, gapX: 2.5, gapY: 0 },
  // 4 × 10 of 48.5 × 25.4 mm.
  a4_40: { key: 'a4_40', page: 'A4', pageW: 210, pageH: 297, w: 48.5, h: 25.4, cols: 4, rows: 10, left: 8, top: 21.5, gapX: 0, gapY: 0 },
  // A 50 × 30 mm roll on a label printer: one label per page.
  roll: { key: 'roll', page: '50mm 30mm', pageW: 50, pageH: 30, w: 50, h: 30, cols: 1, rows: 1, left: 0, top: 0, gapX: 0, gapY: 0 },
  // Shelf-edge strips 70 × 30 mm, 2 × 9 on A4, cut apart.
  shelf: { key: 'shelf', page: 'A4', pageW: 210, pageH: 297, w: 70, h: 30, cols: 2, rows: 9, left: 35, top: 13.5, gapX: 0, gapY: 0, shelf: true },
};

export const perPage = (l: Layout) => l.cols * l.rows;

/** Where label `i` of a page sits (row by row). */
export function slotPosition(l: Layout, i: number): { x: number; y: number } {
  const col = i % l.cols;
  const row = Math.floor(i / l.cols);
  return { x: l.left + col * (l.w + l.gapX), y: l.top + row * (l.h + l.gapY) };
}

/**
 * Items × copies laid out on pages; `skip` leaves the first labels of the first sheet blank (a sheet
 * already partly used). Blank slots are null.
 */
export function paginate<T>(labels: T[], layout: Layout, skip = 0): (T | null)[][] {
  const n = perPage(layout);
  const lead = layout.key === 'roll' ? 0 : Math.max(0, Math.min(skip, n - 1));
  const all: (T | null)[] = [...Array<null>(lead).fill(null), ...labels];
  const pages: (T | null)[][] = [];
  for (let i = 0; i < all.length; i += n) pages.push(all.slice(i, i + n));
  return labels.length ? pages : [];
}

/** Each item repeated by its copies (whole numbers 1–500), in the order picked. */
export function expandCopies<T extends { copies: number }>(items: T[]): T[] {
  return items.flatMap((i) => Array<T>(Math.max(0, Math.min(500, Math.floor(i.copies)))).fill(i));
}
