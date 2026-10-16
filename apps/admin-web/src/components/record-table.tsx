import type { ReactNode } from 'react';

export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-aligned numeric column (money, quantities). */
  num?: boolean;
}

/**
 * A table on desktop that becomes a stacked list below md (the Stacked Row Rule): each row keeps
 * its identity on the left and its key figure on the right, so the figure never scrolls away.
 */
export function RecordTable<T>({
  rows,
  columns,
  rowKey,
  stacked,
  foot,
  dimmed,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  stacked: { title: (row: T) => ReactNode; meta?: (row: T) => ReactNode; figure?: (row: T) => ReactNode };
  /** Totals row: one cell per column on desktop; title + figure when stacked. */
  foot?: { cells: ReactNode[]; title: ReactNode; figure?: ReactNode };
  dimmed?: (row: T) => boolean;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="tbl">
          <thead>
            <tr>{columns.map((c, i) => <th key={i} className={c.num ? 'num' : undefined}>{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className={dimmed?.(r) ? 'text-muted' : undefined}>
                {columns.map((c, i) => <td key={i} className={c.num ? 'num' : undefined}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
          {foot && (
            <tfoot>
              <tr className="font-semibold">
                {foot.cells.map((cell, i) => (
                  <td key={i} className={`border-t border-hair ${columns[i]?.num ? 'num' : ''}`}>{cell}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ul className="md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={`flex items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-b-0 ${dimmed?.(r) ? 'text-muted' : ''}`}>
            <div className="min-w-0">
              <div className="font-semibold">{stacked.title(r)}</div>
              {stacked.meta && <div className="mt-0.5 text-[0.8125rem] text-muted">{stacked.meta(r)}</div>}
            </div>
            {stacked.figure && <div className="shrink-0 text-right">{stacked.figure(r)}</div>}
          </li>
        ))}
        {foot && (
          <li className="flex items-start justify-between gap-3 border-t border-hair px-4 py-3 font-semibold">
            <div>{foot.title}</div>
            {foot.figure && <div className="text-right">{foot.figure}</div>}
          </li>
        )}
      </ul>
    </>
  );
}
