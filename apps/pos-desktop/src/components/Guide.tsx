import { useEffect } from 'react';
import { useT } from '../i18n';
import { GUIDE_SECTIONS as sections, type GuideTopic } from '../lib/guide';
import { Note } from './ui';

const scrollTo = (id: GuideTopic) => document.getElementById(`guide-${id}`)?.scrollIntoView({ block: 'start' });

/**
 * The counter's user guide. It opens over the current screen (which stays mounted, so a cart
 * survives a look) at the part the person is on; Esc or Back returns.
 */
export function Guide({ topic, onBack }: { topic: GuideTopic; onBack: () => void }) {
  const { t } = useT();

  // A block body: newer browsers return a Promise from scrollIntoView, which React would call as the cleanup.
  useEffect(() => {
    scrollTo(topic);
  }, [topic]);
  useEffect(() => {
    // Capture phase: the hidden Sell view's F-keys (cash, exact cash…) must not act behind the guide.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      } else if (/^F([2-9]|1[0-2])$/.test(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack]);

  return (
    <div className="mx-auto grid max-w-[820px] gap-4 px-4 py-6" role="region" aria-labelledby="guide-title">
      <div className="flex items-center justify-between gap-3">
        <h1 id="guide-title" className="text-[1.5rem] font-bold">{t('guide.title')}</h1>
        <button type="button" className="btn" autoFocus onClick={onBack}>
          {t('common.back')} <kbd className="kbd">Esc</kbd>
        </button>
      </div>
      <p className="max-w-[68ch] text-muted">{t('guide.lede')}</p>
      <nav aria-label={t('guide.contents')} className="flex flex-wrap gap-2">
        {sections.map((s) => (
          <button key={s.id} type="button" className={`btn h-9 ${s.id === topic ? 'border-blue font-semibold' : ''}`} onClick={() => scrollTo(s.id)}>
            {t(s.title)}
          </button>
        ))}
      </nav>
      {sections.map((s) => (
        <Note key={s.id} id={`guide-${s.id}`} className="grid scroll-mt-32 gap-2 p-5" aria-labelledby={`guide-${s.id}-title`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`guide-${s.id}-title`} className="text-[1.125rem] font-semibold">{t(s.title)}</h2>
            {s.id === topic && <span className="tag">{t('guide.here')}</span>}
          </div>
          <p className="max-w-[68ch] text-muted">{t(s.lede)}</p>
          <ol className="grid max-w-[72ch] list-decimal gap-1.5 pl-5 marker:font-semibold marker:text-muted">
            {s.steps.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ol>
          {s.tips.length > 0 && (
            <>
              <h3 className="mt-2 text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-muted">{t('guide.tips')}</h3>
              <ul className="grid max-w-[72ch] list-disc gap-1 pl-5 text-[0.9375rem] marker:text-muted">
                {s.tips.map((k) => (
                  <li key={k}>{t(k)}</li>
                ))}
              </ul>
            </>
          )}
        </Note>
      ))}
    </div>
  );
}
