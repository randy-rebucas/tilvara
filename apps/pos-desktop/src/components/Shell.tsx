import { LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useTill } from '../lib/till';
import { TillSettings, TillStatus } from './Till';

export function LangToggle() {
  const { lang, setLang } = useT();
  return (
    <div className="flex gap-1" role="group" aria-label="Language">
      {(['en', 'fil'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`serial h-8 rounded px-2 text-[0.75rem] font-semibold ${lang === l ? 'bg-white/20 text-white' : 'text-blue-ink hover:bg-white/10'}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** The blue band: wordmark, where you are (branch · register · shift), till status, language, sign-out. */
export function Shell({ context, nav, onSignOut, children }: { context?: ReactNode; nav?: ReactNode; onSignOut?: () => void; children: ReactNode }) {
  const { t } = useT();
  const till = useTill();
  // Till settings open over the current screen, which stays mounted (a cart survives a look).
  const [tillOpen, setTillOpen] = useState(false);
  const mode = till.mode === 'browser' ? t('app.browserMode') : till.mode === 'ready' ? t('till.desktopMode') : t('till.desktopNoTerminal');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="band sticky top-0 z-10 text-white">
        <div className="flex h-16 items-center gap-4 px-4 sm:px-6">
          <span className="shrink-0 text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>
          {context && <div className="min-w-0 flex-1 truncate text-blue-ink">{context}</div>}
          {!context && <div className="flex-1" />}
          {nav && <div className="hidden lg:block">{nav}</div>}
          <TillStatus onOpen={() => setTillOpen(true)} />
          <LangToggle />
          {onSignOut && (
            <button type="button" onClick={onSignOut} title={t('common.signOut')} className="grid size-10 place-items-center rounded text-blue-ink hover:bg-white/10">
              <LogOut className="size-5" aria-hidden />
              <span className="sr-only">{t('common.signOut')}</span>
            </button>
          )}
        </div>
        {/* Below lg the tabs get their own scrolling row, so the band never overflows. */}
        {nav && <div className="overflow-x-auto px-3 pb-2 lg:hidden">{nav}</div>}
      </header>
      <p className="serial border-b border-hair bg-paper-deep px-4 py-1 text-[0.6875rem] text-muted sm:px-6">{mode}</p>
      {till.mode === 'ready' && !till.online && (
        <p role="status" className="border-b border-hair bg-amber-bg px-4 py-2 text-[0.9375rem] font-semibold sm:px-6">{t('till.offlineBanner')}</p>
      )}
      {tillOpen && till.mode === 'ready' && <TillSettings onBack={() => setTillOpen(false)} />}
      <main className="flex-1" hidden={tillOpen && till.mode === 'ready'}>{children}</main>
    </div>
  );
}
