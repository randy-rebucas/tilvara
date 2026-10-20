import type { MessageKey } from '../i18n';

/**
 * The counter's user guide: one section per part of the counter, opened from the band's ? button
 * (or F1) at the part the person is on. Copy is `guide.<id>.lede`, `guide.<id>.s1…` (steps) and
 * `guide.<id>.t1…` (good to know) in i18n.tsx; `guide.test.ts` checks every key exists in EN and FIL.
 */
export type GuideTopic = 'start' | 'sell' | 'shift' | 'close' | 'tables' | 'kitchen' | 'till' | 'trouble';

export interface GuideSection {
  id: GuideTopic;
  title: MessageKey;
  lede: MessageKey;
  steps: MessageKey[];
  tips: MessageKey[];
  /** Table service and the kitchen: left out for a retail shop. */
  restaurant?: true;
}

const keys = (id: GuideTopic, kind: 's' | 't', n: number) => Array.from({ length: n }, (_, i) => `guide.${id}.${kind}${i + 1}` as MessageKey);

const section = (id: GuideTopic, title: MessageKey, steps: number, tips: number, restaurant?: true): GuideSection => ({
  id,
  title,
  lede: `guide.${id}.lede` as MessageKey,
  steps: keys(id, 's', steps),
  tips: keys(id, 't', tips),
  ...(restaurant && { restaurant }),
});

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  section('start', 'guide.start.title', 4, 2),
  section('sell', 'nav.sell', 5, 7),
  section('shift', 'nav.history', 4, 4),
  section('close', 'nav.close', 3, 4),
  section('tables', 'nav.tables', 5, 4, true),
  section('kitchen', 'kds.entryTitle', 3, 3, true),
  section('till', 'guide.till.title', 4, 2),
  section('trouble', 'guide.trouble.title', 4, 1),
];

/** `restaurant` false (a retail shop) leaves out table service and the kitchen; unknown (before sign-in) shows everything. */
export const guideSections = (restaurant: boolean) => GUIDE_SECTIONS.filter((s) => restaurant || !s.restaurant);
