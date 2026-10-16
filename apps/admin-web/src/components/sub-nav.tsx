'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

/**
 * Section tabs under a page header (off the band, so ink on paper). On narrow screens the row
 * scrolls, fades at the right edge like the band's tabs, and brings the active tab into view.
 */
export function SubNav({ items, active, label }: { items: { key: string; href: string; label: string }[]; active: string; label: string }) {
  const current = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <nav aria-label={label} className="nav-fade -mx-1 flex gap-1 overflow-x-auto border-b border-hair pb-px">
      {items.map((i) => {
        const on = i.key === active;
        return (
          <Link
            key={i.key}
            ref={on ? current : undefined}
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
