import Link from 'next/link';
import type { ReactNode } from 'react';
import { Serial } from './note';

/** Pick the branch / legal entity a page works on. Plain links: the choice lives in the URL. */
export function ScopePicker({
  label,
  items,
  selected,
  href,
  archivedLabel,
}: {
  label: string;
  /** `archived`: kept in the picker for its history, marked with `archivedLabel`. */
  items: { id: string; name: string; code?: string; archived?: boolean }[];
  selected: string | undefined;
  href: (id: string) => string;
  archivedLabel?: string;
}) {
  if (items.length < 2) return null;
  // Plain links in a labelled nav (not ARIA tabs): they navigate, and the choice lives in the URL.
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {items.map((i) => {
        const on = i.id === selected;
        return (
          <Link
            key={i.id}
            aria-current={on ? 'page' : undefined}
            href={href(i.id)}
            className={`note flex items-center gap-2 px-3.5 py-2 ${on ? 'outline-2 outline-blue' : 'hover:bg-white'}`}
          >
            <span className="font-semibold">{i.name}</span>
            {i.code && <Serial>{i.code}</Serial>}
            {i.archived && archivedLabel && <span className="tag">{archivedLabel}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export { SubNav } from './sub-nav';

/** A labelled figure in a summary strip (document totals). */
export function Figure({ label, children, tone }: { label: string; children: ReactNode; tone?: 'red' }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.8125rem] text-muted">{label}</div>
      <div className={`money text-[1.25rem] font-semibold ${tone === 'red' ? 'text-red' : ''}`}>{children}</div>
    </div>
  );
}
