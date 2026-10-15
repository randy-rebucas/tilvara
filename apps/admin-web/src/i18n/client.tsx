'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { translate, type Lang, type MessageKey } from './messages';

const LangContext = createContext<Lang>('en');

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useT() {
  const lang = useContext(LangContext);
  return { lang, t: (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars) };
}
