import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function tsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsx(p) : e.name.endsWith('.tsx') ? [p] : [];
  });
}

describe('accessible names', () => {
  it('has no aria-label written as a literal English string', () => {
    const literal = /aria-label=("[^"]*[A-Za-z][^"]*"|\{'[^']*[A-Za-z][^']*'\})/;
    expect(tsx(SRC).filter((f) => literal.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('words the a11y names in English and Filipino', () => {
    for (const key of ['a11y.language', 'a11y.counterNav', 'a11y.cart'] as const) {
      expect(messages.en[key]).toBeTruthy();
      expect(messages.fil[key]).toBeTruthy();
    }
  });
});
