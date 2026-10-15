import { cookies } from 'next/headers';
import { LANG_COOKIE } from '../lib/cookies';
import { translate, type Lang, type MessageKey } from './messages';

export async function getLang(): Promise<Lang> {
  const v = (await cookies()).get(LANG_COOKIE)?.value;
  return v === 'fil' ? 'fil' : 'en';
}

export async function getT() {
  const lang = await getLang();
  return { lang, t: (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars) };
}
