import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extraEn, extraFil, titleFor, titlesEn, titlesFil, type TitleKey } from './titles';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, test) : test(e.name) ? [p] : [];
  });
}

const pages = files(join(SRC, 'app'), (n) => n === 'page.tsx');

describe('browser-tab titles', () => {
  it('words every title in English and Filipino', () => {
    for (const key of Object.keys(titlesEn) as TitleKey[]) {
      expect(titlesEn[key], key).toBeTruthy();
      expect(titlesFil[key], key).toBeTruthy();
    }
    expect(Object.keys(titlesFil).sort()).toEqual(Object.keys(titlesEn).sort());
    expect(titleFor('fil', 'products')).toBe('Mga produkto');
    expect(titleFor('en', 'products')).toBe('Products');
  });

  it('gives every page a title through pageTitle(), never a literal English one', () => {
    expect(pages.length).toBeGreaterThan(80);
    const missing: string[] = [];
    const unknown: string[] = [];
    for (const page of pages) {
      const src = readFileSync(page, 'utf8');
      // A page that only redirects renders nothing to title.
      if (/\bredirect\(/.test(src) && !/return \(/.test(src)) continue;
      const m = src.match(/export const generateMetadata = pageTitle\('([^']+)'[,)]/);
      if (!m || /export const metadata\b/.test(src)) {
        missing.push(page.slice(SRC.length));
        continue;
      }
      if (!m[1] || !(m[1] in titlesEn)) unknown.push(`${page.slice(SRC.length)}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('words every accessible name and example in English and Filipino', () => {
    expect(Object.keys(extraFil).sort()).toEqual(Object.keys(extraEn).sort());
    for (const v of Object.values(extraFil)) expect(v).toBeTruthy();
  });

  it('has no aria-label written as a literal English string', () => {
    const literal = /aria-label=("[^"]*[A-Za-z][^"]*"|\{'[^']*[A-Za-z][^']*'\})/;
    const found = files(SRC, (n) => n.endsWith('.tsx')).filter((f) => literal.test(readFileSync(f, 'utf8')));
    expect(found.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});
