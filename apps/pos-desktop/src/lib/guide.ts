import type { MessageKey } from '../i18n';

/**
 * The counter's user guide: one section per part of the counter, opened from the band's ? button
 * (or F1) at the part the person is on. Copy is `guide.<id>.lede`, `guide.<id>.s1…` (steps) and
 * `guide.<id>.t1…` (good to know) in i18n.tsx; `guide.test.ts` checks every key exists in EN and FIL.
 */
export type GuideTopic = 'start' | 'sell' | 'shift' | 'close' | 'till' | 'trouble';

export interface GuideSection {
  id: GuideTopic;
  title: MessageKey;
  lede: MessageKey;
  steps: MessageKey[];
  tips: MessageKey[];
  /** The extension this part explains (ADR-0026): shown only while the business has it. */
  extension?: string;
}

const keys = (id: GuideTopic, kind: 's' | 't', n: number) => Array.from({ length: n }, (_, i) => `guide.${id}.${kind}${i + 1}` as MessageKey);

const section = (id: GuideTopic, title: MessageKey, steps: number, tips: number): GuideSection => ({
  id,
  title,
  lede: `guide.${id}.lede` as MessageKey,
  steps: keys(id, 's', steps),
  tips: keys(id, 't', tips),
});

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  section('start', 'guide.start.title', 4, 2),
  section('sell', 'nav.sell', 5, 10),
  section('shift', 'nav.history', 4, 4),
  section('close', 'nav.close', 3, 3),
  section('till', 'guide.till.title', 4, 5),
  section('trouble', 'guide.trouble.title', 4, 1),
];

/** The parts for a business with these extensions on: the counter's own, and those of its extensions. */
export const guideSections = (extensions: readonly string[]) => GUIDE_SECTIONS.filter((s) => !s.extension || extensions.includes(s.extension));

