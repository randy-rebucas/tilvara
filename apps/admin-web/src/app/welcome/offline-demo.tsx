'use client';

import { CloudUpload, WifiOff, Wifi } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';

/**
 * The till queue on the landing page, played as a loop while it is on screen: offline, back online,
 * the waiting sales recorded one by one; the refused one stays for review. Still under reduced motion.
 */

const ROWS = [
  { no: '000117', amount: '₱1,248.00', waits: false, review: false },
  { no: '000118', amount: '₱86.25', waits: true, review: false },
  { no: '000119', amount: '₱412.00', waits: true, review: false },
  { no: '000120', amount: '₱39.00', waits: false, review: true },
];

/** 0 offline · 1 back online, sending · 2 first sent · 3 all sent */
const TIMELINE = [3200, 900, 900, 3200];

export function OfflineDemo() {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    const tick = (s: number) => {
      timer = setTimeout(() => {
        const next = (s + 1) % TIMELINE.length;
        setStep(next);
        if (visible) tick(next);
      }, TIMELINE[s]);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      clearTimeout(timer);
      if (visible) {
        setStep(0);
        tick(0);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const online = step > 0;
  const sent = (n: number) => !ROWS[n]!.waits || step >= 2 + ROWS.slice(0, n).filter((r) => r.waits).length;
  const waiting = ROWS.filter((r, n) => r.waits && !sent(n)).length;

  return (
    <div ref={ref}>
      <p
        className={`mb-2 flex items-center gap-2 rounded-[6px] px-3 py-2 text-[0.8125rem] transition-colors duration-300 ${online ? 'bg-[#e9eff8] text-[#1f3b66]' : 'bg-paper text-muted'}`}
      >
        <span className={`land-pulse size-2 flex-none rounded-full ${online ? 'bg-blue text-blue' : 'bg-orange-soft text-orange-soft'}`} aria-hidden />
        {online ? <Wifi aria-hidden className="size-4 flex-none" /> : <WifiOff aria-hidden className="size-4 flex-none" />}
        <span className="min-w-0">{!online ? t('land.o.q.conn') : waiting ? t('land.o.q.online') : t('land.o.q.done')}</span>
        {online && waiting > 0 && <CloudUpload aria-hidden className="ml-auto size-4 flex-none animate-pulse" />}
      </p>
      <ul>
        {ROWS.map((r, n) => {
          const state = r.review ? 'review' : sent(n) ? 'sent' : 'wait';
          return (
            <li key={r.no} className="grid grid-cols-[1fr_auto_6rem] items-center gap-3 border-b border-hair-soft py-2.5 text-[0.875rem] last:border-0">
              <span className="serial text-[0.8125rem]">S-CBO02-{r.no}</span>
              <span className="money font-semibold">{r.amount}</span>
              <span
                className={`justify-self-end rounded-[4px] px-2 py-0.5 text-[0.75rem] font-semibold transition-colors duration-300 ${
                  state === 'sent' ? 'bg-[#e9eff8] text-blue' : state === 'wait' ? 'bg-amber-bg text-orange' : 'bg-paper text-muted'
                }`}
              >
                {t(state === 'sent' ? 'land.o.q.sent' : state === 'wait' ? 'land.o.q.wait' : 'land.o.q.review')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
