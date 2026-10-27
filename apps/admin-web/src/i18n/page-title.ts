import type { Metadata } from 'next';
import { getLang } from './server';
import { titleFor, type TitleKey } from './titles';

/**
 * A page's browser-tab title in the signed-in language (the language cookie):
 * `export const generateMetadata = pageTitle('products');`. The root layout's template adds " · Tilvara".
 * `extra` adds other metadata, e.g. letting search engines index the public landing page.
 */
export function pageTitle(key: TitleKey, extra: Metadata = {}) {
  return async function generateMetadata(): Promise<Metadata> {
    return { ...extra, title: titleFor(await getLang(), key) };
  };
}
