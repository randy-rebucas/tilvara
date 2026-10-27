import type { CashDrawer } from './devices';

/**
 * Open the cash drawer after cash changed hands (a sale or refund already recorded). Best effort and
 * never awaited: a drawer that does not answer never holds up the counter (it is opened by hand then).
 */
export function openDrawerFor(drawer: CashDrawer, cashMoved: boolean): void {
  if (!cashMoved || !drawer.available) return;
  void drawer.open().catch(() => undefined);
}
