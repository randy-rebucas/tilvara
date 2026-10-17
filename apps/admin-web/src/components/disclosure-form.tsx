'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** An inline "add" (or "edit") panel: the task stays in context instead of a modal. */
export function Disclosure({ label, children, kind = 'add' }: { label: string; children: (close: () => void) => ReactNode; kind?: 'add' | 'edit' }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    const Icon = kind === 'edit' ? Pencil : Plus;
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon aria-hidden className="size-4" /> {label}
      </button>
    );
  }
  return (
    <div className="w-full rounded-[5px] border border-hair bg-white p-4">
      <p className="mb-3 font-semibold">{label}</p>
      {children(() => setOpen(false))}
    </div>
  );
}
