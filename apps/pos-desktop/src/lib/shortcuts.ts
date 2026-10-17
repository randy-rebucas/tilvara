import { useEffect, useRef } from 'react';

export type ShortcutKey = 'F2' | 'F4' | 'F8' | 'F9';

/**
 * Counter keys for a keyboard-and-scanner till: F-keys work while typing in a field (a scanner
 * types too), and their browser defaults (search, address bar) are suppressed only when handled.
 */
export function useShortcuts(active: boolean, handlers: Partial<Record<ShortcutKey, () => void>>) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const run = latest.current[e.key as ShortcutKey];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

/** Click a control if it is enabled and visible (the Sell view stays mounted, hidden, behind other tabs). */
export function pressIfEnabled(id: string): boolean {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (!el || el.disabled || el.getClientRects().length === 0) return false;
  el.click();
  return true;
}
