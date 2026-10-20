'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

/**
 * Section tabs under a page header (off the band, so ink on paper). On narrow screens the row
 * scrolls, fades at the right edge like the band's tabs, and brings the active tab into view.
 * `level={2}` is a row inside a section (Reports → group → report): small toggles, not a second
 * underlined row, so the two levels never read as one.
 */
export function SubNav({
  items,
  active,
  label,
  level = 1,
}: {
  items: { key: string; href: string; label: string }[];
  active: string;
  label: string;
  level?: 1 | 2;
}) {
  const current = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const nested = level === 2;
  return (
    <nav aria-label={label} className={nested ? 'nav-fade flex gap-1 overflow-x-auto py-0.5' : 'nav-fade flex gap-1 overflow-x-auto border-b border-hair pb-px'}>
      {items.map((i) => {
        const on = i.key === active;
        const look = nested
          ? `rounded-[4px] border px-2.5 py-1 text-[0.875rem] ${on ? 'border-hair bg-note font-semibold text-ink shadow-[0_1px_2px_rgb(60_50_20/0.08)]' : 'border-transparent text-muted hover:bg-paper-deep hover:text-ink'}`
          : `-mb-px border-b-2 px-3 py-2 text-[0.9375rem] ${on ? 'border-blue font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'}`;
        return (
          <Link
            key={i.key}
            ref={on ? current : undefined}
            href={i.href}
            aria-current={on ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap transition-colors ${look}`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
