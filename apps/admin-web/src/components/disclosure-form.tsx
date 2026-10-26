'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Sheet } from './sheet';

/** An "add" (or "edit") button that opens its form in a sheet sliding in from the right. */
export function Disclosure({ label, children, kind = 'add', wide = false }: { label: string; children: (close: () => void) => ReactNode; kind?: 'add' | 'edit'; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = kind === 'edit' ? Pencil : Plus;
  return (
    <>
      <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon aria-hidden className="size-4" /> {label}
      </button>
      <Sheet open={open} title={label} wide={wide} onClose={() => setOpen(false)}>
        {children(() => setOpen(false))}
      </Sheet>
    </>
  );
}
