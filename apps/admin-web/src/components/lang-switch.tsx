'use client';

import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/client';
import { send } from '@/lib/client-api';

/** EN / FIL toggle. Stored in a cookie; the whole UI re-renders server-side in the chosen language. */
export function LangSwitch({ onBand = false }: { onBand?: boolean }) {
  const { lang, t } = useT();
  const router = useRouter();
  async function choose(next: 'en' | 'fil') {
    if (next === lang) return;
    await send('POST', '/api/auth/lang', { lang: next });
    router.refresh();
  }
  const base = 'h-7 px-2 text-[0.8125rem] font-semibold rounded-[4px] serial';
  const on = onBand ? 'bg-white/20 text-white' : 'bg-blue text-white';
  const off = onBand ? 'text-blue-ink hover:bg-white/10' : 'text-muted hover:bg-paper-deep';
  return (
    <div role="group" aria-label={t('lang.label')} className="flex gap-1">
      <button type="button" className={`${base} ${lang === 'en' ? on : off}`} aria-pressed={lang === 'en'} onClick={() => choose('en')}>
        EN
      </button>
      <button type="button" className={`${base} ${lang === 'fil' ? on : off}`} aria-pressed={lang === 'fil'} onClick={() => choose('fil')}>
        FIL
      </button>
    </div>
  );
}
