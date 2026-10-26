import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';
import { GUIDE_SECTIONS, guideSections } from './guide';
import { TABS, tabsFor } from './tabs';

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

  it('extensions (ADR-0026): their tabs and guide parts show only while the business has them', () => {
    const withExtension = TABS.filter((x) => x.extension);
    expect(tabsFor([]).map((x) => x.key)).toEqual(TABS.filter((x) => !x.extension).map((x) => x.key));
    expect(tabsFor(withExtension.map((x) => x.extension!))).toEqual(TABS);
    expect(tabsFor([]).map((x) => x.key).slice(0, 3)).toEqual(['sell', 'history', 'close']);
    expect(guideSections([])).toEqual(GUIDE_SECTIONS.filter((s) => !s.extension));
    for (const tab of TABS) expect(GUIDE_SECTIONS.map((s) => s.id)).toContain(tab.topic);
  });

  it('has the counter parts only', () => {
    expect(GUIDE_SECTIONS.map((s) => s.id)).toEqual(['start', 'sell', 'shift', 'close', 'till', 'trouble']);
  });
});
