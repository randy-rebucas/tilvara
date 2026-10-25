import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';
import { GUIDE_SECTIONS } from './guide';

describe('counter user guide', () => {
  it('words every section, step and tip in English and Filipino', () => {
    for (const dict of [messages.en, messages.fil]) {
      for (const s of GUIDE_SECTIONS) {
        for (const key of [s.title, s.lede, ...s.steps, ...s.tips]) expect(dict[key], key).toBeTruthy();
      }
    }
  });

  it('has no guide copy that no section shows', () => {
    const used = new Set<string>(GUIDE_SECTIONS.flatMap((s) => [s.lede, ...s.steps, ...s.tips]));
    expect(Object.keys(messages.en).filter((k) => /^guide\.[a-z]+\.(lede|s\d+|t\d+)$/.test(k) && !used.has(k))).toEqual([]);
  });

  it('has the counter parts only', () => {
    expect(GUIDE_SECTIONS.map((s) => s.id)).toEqual(['start', 'sell', 'shift', 'close', 'till', 'trouble']);
  });
});
