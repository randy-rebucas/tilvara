import { useEffect } from 'react';

/** Re-run `fn` every `ms` while `active` (the floor and tickets change on other tablets and in the kitchen). */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return;
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms, active]);
}
