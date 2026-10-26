'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '@/i18n/client';

/**
 * A form panel that slides in from the right edge over a dimmed page. Built on the native
 * <dialog> (showModal): focus stays inside, the page behind is inert, Esc and a click on the
 * dimmed page close it. Children mount only while open, so each opening starts a fresh form
 * (and `useFormKey` pins a fresh Idempotency-Key).
 */
export function Sheet({ open, title, onClose, wide = false, children }: { open: boolean; title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    opener.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    // Start on the first field (the browser would pick the close button, first in the panel).
    dialog.querySelector<HTMLElement>('.sheet-body :is(input:not([type=hidden]), select, textarea):not(:disabled)')?.focus();
    return () => {
      // Back to the button that opened it (unless the save re-rendered it away).
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`sheet ${wide ? 'sheet-wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // The dialog box is the panel itself; a press outside its rect landed on the backdrop.
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-hair px-5 py-4">
          <h2 className="text-[1.0625rem] font-semibold">{title}</h2>
          <button type="button" className="btn -my-1 -mr-2 px-2" aria-label={t('common.close')} onClick={onClose}>
            <X aria-hidden className="size-4" />
          </button>
        </header>
        <div className="sheet-body @container min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </dialog>
  );
}
