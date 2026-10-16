import Link from 'next/link';
import type { ReactNode } from 'react';
import { Serial } from './note';

/** Pick the branch / legal entity a page works on. Plain links: the choice lives in the URL. */
export function ScopePicker({
  label,
  items,
  selected,
  href,
}: {
  label: string;
  items: { id: string; name: string; code?: string }[];
  selected: string | undefined;
  href: (id: string) => string;
}) {
  if (items.length < 2) return null;
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {items.map((i) => {
        const on = i.id === selected;
        return (
          <Link
            key={i.id}
            role="tab"
            aria-selected={on}
            href={href(i.id)}
            className={`note flex items-center gap-2 px-3.5 py-2 ${on ? 'outline-2 outline-blue' : 'hover:bg-white'}`}
          >
            <span className="font-semibold">{i.name}</span>
            {i.code && <Serial>{i.code}</Serial>}
          </Link>
        );
      })}
    </div>
  );
}

/** Section tabs under a page header (off the band, so ink on paper). */
export function SubNav({ items, active, label }: { items: { key: string; href: string; label: string }[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-hair pb-px">
      {items.map((i) => {
        const on = i.key === active;
        return (
          <Link
            key={i.key}
            href={i.href}
            aria-current={on ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[0.9375rem] transition-colors ${
              on ? 'border-blue font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A labelled figure in a summary strip (document totals). */
export function Figure({ label, children, tone }: { label: string; children: ReactNode; tone?: 'red' }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.8125rem] text-muted">{label}</div>
      <div className={`money text-[1.25rem] font-semibold ${tone === 'red' ? 'text-red' : ''}`}>{children}</div>
    </div>
  );
}
