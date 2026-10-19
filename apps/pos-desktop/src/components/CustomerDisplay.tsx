import { useT } from '../i18n';
import { useDisplayState } from '../lib/customer-display';
import { Money } from './ui';

/** The customer-facing window: big, calm, nothing to press (session 16). */
export function CustomerDisplay() {
  const { t } = useT();
  const s = useDisplayState();
  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr_auto] bg-paper text-ink" aria-live="polite">
      <header className="band px-8 py-5 text-white">
        <span className="text-[1.75rem] font-bold tracking-[0.04em]">Tilvara</span>
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
            <p className="text-[3rem] font-bold">{t('display.thanks')}</p>
            {s.change && s.change !== '0.00' && (
              <p className="text-[1.75rem]">
                {t('display.change')} <Money value={s.change} className="font-semibold" />
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="grid place-items-center px-8 text-center">
          <p className="text-[2.25rem] text-muted">{t('display.welcome')}</p>
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
