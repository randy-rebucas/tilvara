import { CircleHelp, LogOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { GuideTopic } from '../lib/guide';
import { useBrand } from '../lib/brand';
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

/** Which part of the user guide the ? button (and F1) opens. */
export interface HelpContext {
  topic: GuideTopic;
  /** The business's usable extensions: their parts of the guide show (ADR-0026). */
  extensions?: string[];
}

/**
 * The band: the business's logo or name (else the wordmark), where you are (branch · register · shift),
 * till status, help, language, sign-out. `backdrop`: the business's background image behind the
 * screens before the counter (sign-in, business, register).
 */
export function Shell({ context, nav, onSignOut, help = { topic: 'start' }, backdrop = false, readOnly = false, children }: { context?: ReactNode; nav?: ReactNode; onSignOut?: () => void; help?: HelpContext; backdrop?: boolean; readOnly?: boolean; children: ReactNode }) {
  const { t } = useT();
  const till = useTill();
  const { brand } = useBrand();
  const background = backdrop && brand?.backgroundUrl ? brand.backgroundUrl : null;
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
          <BandMark name={brand?.displayName ?? null} logoUrl={brand?.logoUrl ?? null} />
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
      {/* The business cannot record sales (`/me` at sign-in, or the till's latest snapshot). A desktop till's offline sales
          then wait for review; a till in a browser is refused outright. */}
      {(readOnly || (till.mode === 'ready' && till.status?.snapshot?.businessWritable === false)) && (
        <p role="alert" data-testid="read-only-banner" className="border-b border-hair bg-[#fbeceb] px-4 py-2 text-[0.9375rem] font-semibold text-red sm:px-6">{t(till.mode === 'ready' ? 'till.readOnlyBanner' : 'till.readOnlyBannerOnline')}</p>
      )}
      {till.mode === 'ready' && !till.online && (
        <p role="status" className="border-b border-hair bg-amber-bg px-4 py-2 text-[0.9375rem] font-semibold sm:px-6">{t('till.offlineBanner')}</p>
      )}
      {tillOpen && <TillSettings onBack={() => setOverlay(null)} />}
      {guideOpen && <Guide topic={help.topic} extensions={help.extensions ?? []} onBack={() => setOverlay(null)} />}
      <main
        className={`flex-1 ${background ? 'bg-cover bg-center' : ''}`}
        // A paper wash over the photo: the screens' text stays readable on any picture.
        style={background ? { backgroundImage: `linear-gradient(rgb(244 241 232 / 0.8), rgb(244 241 232 / 0.8)), url(${background})` } : undefined}
        data-testid={background ? 'brand-backdrop' : undefined}
        hidden={tillOpen || guideOpen}
      >
        {children}
      </main>
    </div>
  );
}

/** The business's logo (on a white mat, so it reads on any colour), else its short name, else the wordmark. */
function BandMark({ name, logoUrl }: { name: string | null; logoUrl: string | null }) {
  if (logoUrl) return <img src={logoUrl} alt={name ?? ''} data-testid="brand-logo" className="h-10 w-auto max-w-[120px] shrink-0 rounded-[3px] bg-white object-contain p-[3px]" />;
  if (name) return <span className="max-w-[16rem] shrink-0 truncate text-[1.375rem] font-bold tracking-[0.02em]">{name}</span>;
  return <span className="shrink-0 text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>;
}
