import type { Metadata } from 'next';
import { getLang } from './server';
import { titleFor, type TitleKey } from './titles';

/**
 * A page's browser-tab title in the signed-in language (the language cookie):
 * `export const generateMetadata = pageTitle('products');`. The root layout's template adds " · Tilvara".
 */
export function pageTitle(key: TitleKey) {
  return async function generateMetadata(): Promise<Metadata> {
    return { title: titleFor(await getLang(), key) };
  };
}
