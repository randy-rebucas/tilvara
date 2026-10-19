import { useEffect, useRef, useState } from 'react';
import { readEvents } from './api';

/**
 * Floor and kitchen push (session 16): follow the branch's stream and call `onChange` whenever an
 * order, item, ticket or bill there changes. Reconnects (the server ends each stream after ten
 * minutes, and connections drop); `live` tells the caller it may slow its polling, which stays as
 * the fallback when the stream cannot be had (an old server, a proxy that buffers).
 */
export function useFloorPush(branchId: string, onChange: () => void, active: boolean): boolean {
  const [live, setLive] = useState(false);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    let failures = 0;
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          await readEvents(`/v1/restaurant/stream?branchId=${encodeURIComponent(branchId)}`, (name) => {
            if (name === 'ready') {
              failures = 0;
              setLive(true);
              latest.current(); // anything missed while reconnecting
            } else if (name === 'changed') latest.current();
          }, ac.signal);
        } catch {
          failures++;
        }
        setLive(false);
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
      }
    })();
    return () => {
      ac.abort();
      setLive(false);
    };
  }, [branchId, active]);
  return live;
}
