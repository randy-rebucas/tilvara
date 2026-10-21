import { CircleHelp, LogOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { GuideTopic } from '../lib/guide';
import { useTill } from '../lib/till';
import { Guide } from './Guide';
import { TillSettings, TillStatus } from './Till';

export function LangToggle() {
  const { t, lang, setLang } = useT();
  return (
    <div className="flex gap-1" role="group" aria-label={t('a11y.language')} data-testid="language">
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

/**
 * Which part of the user guide the ? button (and F1) opens; `restaurant` false leaves out tables and the
 * kitchen, `salon` false the appointments part, `lodging` false the rooms part, `laundry` false the
 * laundry part.
 */
export interface HelpContext {
  topic: GuideTopic;
  restaurant?: boolean;
  salon?: boolean;
  lodging?: boolean;
  laundry?: boolean;
  /** A pharmacy, drugstore or hybrid business (ADR-0025): the medicines part. */
  pharmacy?: boolean;
}

/** The blue band: wordmark, where you are (branch · register · shift), till status, help, language, sign-out. */
export function Shell({ context, nav, onSignOut, help = { topic: 'start' }, children }: { context?: ReactNode; nav?: ReactNode; onSignOut?: () => void; help?: HelpContext; children: ReactNode }) {
  const { t } = useT();
  const till = useTill();
  // Till settings and the guide open over the current screen, which stays mounted (a cart survives a look).
  const [overlay, setOverlay] = useState<'till' | 'guide' | null>(null);
  const tillOpen = overlay === 'till' && till.mode === 'ready';
  const guideOpen = overlay === 'guide';
  const mode = till.mode === 'browser' ? t('app.browserMode') : till.mode === 'ready' ? t('till.desktopMode') : t('till.desktopNoTerminal');

  // F1 opens the guide from anywhere (and never the browser's own help page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1' || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      setOverlay('guide');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="band sticky top-0 z-10 text-white">
        <div className="flex h-16 items-center gap-4 px-4 sm:px-6">
          <span className="shrink-0 text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>
          {context && <div className="min-w-0 flex-1 truncate text-blue-ink">{context}</div>}
          {!context && <div className="flex-1" />}
          {nav && <div className="hidden lg:block">{nav}</div>}
          <TillStatus onOpen={() => setOverlay('till')} />
          <button
            type="button"
            onClick={() => setOverlay(guideOpen ? null : 'guide')}
            title={`${t('guide.help')} (F1)`}
            aria-pressed={guideOpen}
            className={`grid size-10 shrink-0 place-items-center rounded ${guideOpen ? 'bg-white/20 text-white' : 'text-blue-ink hover:bg-white/10'}`}
          >
            <CircleHelp className="size-5" aria-hidden />
            <span className="sr-only">{t('guide.help')}</span>
          </button>
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
      {tillOpen && <TillSettings onBack={() => setOverlay(null)} />}
      {guideOpen && <Guide topic={help.topic} restaurant={help.restaurant ?? true} salon={help.salon ?? true} lodging={help.lodging ?? true} laundry={help.laundry ?? true} pharmacy={help.pharmacy ?? true} onBack={() => setOverlay(null)} />}
      <main className="flex-1" hidden={tillOpen || guideOpen}>{children}</main>
    </div>
  );
}
