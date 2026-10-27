import { useEffect, useState } from 'react';

/**
 * Customer display (session 16): a second browser window facing the customer, fed by the till over a
 * BroadcastChannel (same browser, same origin; nothing goes over the network and the display holds no
 * token). It shows what the till shows: the lines and the total, then the change and a thank-you.
 */
export type DisplayState =
  | { kind: 'idle' }
  | { kind: 'cart'; lines: { name: string; quantity: string; amount: string }[]; total: string }
  | { kind: 'paid'; total: string; change: string | null };

/** The business's look on the display (session 39): object URLs from the till's window, same origin. */
export interface DisplayBrand {
  displayName: string | null;
  brandColor: string | null;
  welcome: string | null;
  thanks: string | null;
  logoUrl: string | null;
  backgroundUrl: string | null;
}

type Message = DisplayState | { kind: 'hello' } | { kind: 'brand'; brand: DisplayBrand | null };

const CHANNEL = 'tilvara-customer-display';

const open = (): BroadcastChannel | null => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
};

/** The till's side: publish `state` whenever it changes, and again when a display window opens. */
export function usePublishDisplay(state: DisplayState): void {
  const key = JSON.stringify(state);
  useEffect(() => {
    const ch = open();
    if (!ch) return;
    ch.postMessage(state);
    ch.onmessage = (e: MessageEvent<Message>) => {
      if (e.data?.kind === 'hello') ch.postMessage(state);
    };
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialized state is the dependency
  }, [key]);
}

/** The till's side: publish the business's look, and again when a display window opens. */
export function usePublishBrand(brand: DisplayBrand | null): void {
  const key = JSON.stringify(brand);
  useEffect(() => {
    const ch = open();
    if (!ch) return;
    const message: Message = { kind: 'brand', brand };
    ch.postMessage(message);
    ch.onmessage = (e: MessageEvent<Message>) => {
      if (e.data?.kind === 'hello') ch.postMessage(message);
    };
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialized brand is the dependency
  }, [key]);
}

/** The display's side: the till's latest state and look (asks for them when the window opens). */
export function useDisplayState(): { state: DisplayState; brand: DisplayBrand | null } {
  const [state, setState] = useState<DisplayState>({ kind: 'idle' });
  const [brand, setBrand] = useState<DisplayBrand | null>(null);
  useEffect(() => {
    const ch = open();
    if (!ch) return;
    ch.onmessage = (e: MessageEvent<Message>) => {
      if (!e.data || e.data.kind === 'hello') return;
      if (e.data.kind === 'brand') setBrand(e.data.brand);
      else setState(e.data);
    };
    ch.postMessage({ kind: 'hello' } satisfies Message);
    return () => ch.close();
  }, []);
  return { state, brand };
}

/** Open (or bring forward) the customer display window. */
export function openCustomerDisplay(): void {
  window.open(`${location.pathname}?display=customer`, 'tilvara-customer-display', 'popup,width=1024,height=640');
}
