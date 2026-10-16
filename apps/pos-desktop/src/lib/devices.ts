import { encodeEscPos, type PaperWidth, type PrintableReceipt } from '@1pos/escpos';

/**
 * Device ports (ADR-0006). Browser mode has no hardware: the printer uses the browser's print
 * dialog and the drawer is a no-op. The Tauri shell (Phase 5 slice 5) supplies the byte channel for
 * ESC/POS printers and drawers.
 *
 * Printing is never part of a sale: the sale is recorded before anything prints, so a printer that
 * fails (paper out, offline, jammed) only means "reprint" (SPEC failure list: printer failure).
 */
export interface ReceiptPrinter {
  readonly kind: 'browser' | 'escpos';
  /** `element` is the on-screen receipt (browser printing); `doc` the same receipt for a thermal printer. */
  print(element: HTMLElement, doc: PrintableReceipt): Promise<void>;
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

/** Sends raw bytes to a printer (USB, serial or network port), rejecting when the device does not take them. */
export type ByteChannel = (bytes: Uint8Array) => Promise<void>;

/** A thermal printer on a byte channel: the receipt as ESC/POS, with a timeout so a dead printer never hangs the till. */
export function escposPrinter(send: ByteChannel, o: { width?: PaperWidth; timeoutMs?: number } = {}): ReceiptPrinter {
  return {
    kind: 'escpos',
    print: (_element, doc) => withTimeout(send(encodeEscPos(doc, { width: o.width ?? 48 })), o.timeoutMs ?? 8_000),
  };
}

/** The drawer wired to the printer's kick-out port: a receipt-less ESC p pulse. */
export function escposDrawer(send: ByteChannel, timeoutMs = 4_000): CashDrawer {
  return {
    available: true,
    open: () => withTimeout(send(Uint8Array.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])), timeoutMs),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The printer did not answer')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}
