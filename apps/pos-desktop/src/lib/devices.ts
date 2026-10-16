/**
 * Device ports (ADR-0006). Browser mode has no hardware: the printer uses the browser's print
 * dialog and the drawer is a no-op. The Tauri shell (Phase 5) provides ESC/POS and drawer adapters.
 */
export interface ReceiptPrinter {
  readonly kind: 'browser' | 'escpos';
  print(element: HTMLElement): Promise<void>;
}

export interface CashDrawer {
  readonly available: boolean;
  open(): Promise<void>;
}

export const browserPrinter: ReceiptPrinter = {
  kind: 'browser',
  async print() {
    window.print();
  },
};

export const noDrawer: CashDrawer = {
  available: false,
  async open() {
    // Browser mode: no drawer kick. The UI tells the cashier to open the drawer manually.
  },
};
