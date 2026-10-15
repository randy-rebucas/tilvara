'use client';

import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** An inline "add" panel: the task stays in context instead of a modal. */
export function Disclosure({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Plus aria-hidden className="size-4" /> {label}
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
