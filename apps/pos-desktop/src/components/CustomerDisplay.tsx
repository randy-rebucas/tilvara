import { useT } from '../i18n';
import { useEffect } from 'react';
import { applyBrandColor } from '../lib/brand';
import { useDisplayState } from '../lib/customer-display';
import { Money } from './ui';

/** The customer-facing window: big, calm, nothing to press (session 16). */
export function CustomerDisplay() {
  const { t } = useT();
  const { state: s, brand } = useDisplayState();
  useEffect(() => applyBrandColor(brand?.brandColor), [brand?.brandColor]);
  // The business's background behind the welcome and the thank-you, under a paper wash so the words read.
  const backdrop = s.kind !== 'cart' && brand?.backgroundUrl
    ? { backgroundImage: `linear-gradient(rgb(244 241 232 / 0.75), rgb(244 241 232 / 0.75)), url(${brand.backgroundUrl})` }
    : undefined;
  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr_auto] bg-paper bg-cover bg-center text-ink" style={backdrop} aria-live="polite">
      <header className="band flex items-center gap-4 px-8 py-4 text-white">
        {brand?.logoUrl && <img src={brand.logoUrl} alt="" className="h-14 w-auto max-w-[200px] rounded-[3px] bg-white object-contain p-1" />}
        <span className="truncate text-[1.75rem] font-bold tracking-[0.04em]">{brand?.displayName ?? (brand?.logoUrl ? '' : 'Tilvara')}</span>
      </header>
      {s.kind === 'cart' ? (
        <section className="overflow-hidden px-8 py-6">
          <ul className="grid gap-3 text-[1.5rem]" data-testid="display-lines">
            {s.lines.slice(-8).map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-6 border-b border-hair-soft pb-2">
                <span className="min-w-0 truncate">
                  <span className="money text-muted">{l.quantity}×</span> {l.name}
                </span>
                <Money value={l.amount} />
              </li>
            ))}
          </ul>
        </section>
      ) : s.kind === 'paid' ? (
        <section className="grid place-items-center px-8 text-center">
          <div className="grid gap-4">
            <p className="text-[3rem] font-bold">{brand?.thanks ?? t('display.thanks')}</p>
            {s.change && s.change !== '0.00' && (
              <p className="text-[1.75rem]">
                {t('display.change')} <Money value={s.change} className="font-semibold" />
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="grid place-items-center px-8 text-center">
          <p className="text-[2.25rem] text-muted">{brand?.welcome ?? t('display.welcome')}</p>
        </section>
      )}
      {s.kind !== 'idle' && (
        <footer className="flex items-baseline justify-between gap-6 border-t border-hair bg-white px-8 py-6">
          <span className="text-[1.75rem] font-semibold">{t('display.total')}</span>
          <Money value={s.total} className="text-[3.5rem] font-bold" />
        </footer>
      )}
    </main>
  );
}
