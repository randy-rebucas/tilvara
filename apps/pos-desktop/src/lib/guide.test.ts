import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';
import { GUIDE_SECTIONS, guideSections } from './guide';

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

  it('shows a retail shop the counter parts only', () => {
    expect(guideSections(false, false).map((s) => s.id)).toEqual(['start', 'sell', 'shift', 'close', 'till', 'trouble']);
    expect(guideSections().map((s) => s.id)).toEqual(GUIDE_SECTIONS.map((s) => s.id));
  });

  it('shows the appointments part to a salon or hybrid business only', () => {
    expect(guideSections(true, false).map((s) => s.id)).toEqual(['start', 'sell', 'appointments', 'shift', 'close', 'till', 'trouble']);
    expect(guideSections(false).map((s) => s.id)).not.toContain('appointments');
  });

  it('shows the medicines part to a pharmacy, drugstore or hybrid business only', () => {
    expect(guideSections(false, true).map((s) => s.id)).toEqual(['start', 'sell', 'pharmacy', 'shift', 'close', 'till', 'trouble']);
    expect(guideSections(true, false).map((s) => s.id)).not.toContain('pharmacy');
  });
});
