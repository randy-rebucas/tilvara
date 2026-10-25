import type { MessageKey } from '../i18n';

/**
 * The counter's user guide: one section per part of the counter, opened from the band's ? button
 * (or F1) at the part the person is on. Copy is `guide.<id>.lede`, `guide.<id>.s1…` (steps) and
 * `guide.<id>.t1…` (good to know) in i18n.tsx; `guide.test.ts` checks every key exists in EN and FIL.
 */
export type GuideTopic = 'start' | 'sell' | 'appointments' | 'pharmacy' | 'shift' | 'close' | 'till' | 'trouble';

export interface GuideSection {
  id: GuideTopic;
  title: MessageKey;
  lede: MessageKey;
  steps: MessageKey[];
  tips: MessageKey[];
  /** Appointments, staff and packages (ADR-0022): only for a salon or a hybrid business. */
  salon?: true;
  /** Medicines, prescriptions and the pharmacist's approval (ADR-0025): a pharmacy, drugstore or hybrid business. */
  pharmacy?: true;
}

const keys = (id: GuideTopic, kind: 's' | 't', n: number) => Array.from({ length: n }, (_, i) => `guide.${id}.${kind}${i + 1}` as MessageKey);

const section = (id: GuideTopic, title: MessageKey, steps: number, tips: number, only?: 'salon' | 'pharmacy'): GuideSection => ({
  id,
  title,
  lede: `guide.${id}.lede` as MessageKey,
  steps: keys(id, 's', steps),
  tips: keys(id, 't', tips),
  ...(only === 'salon' && { salon: true as const }),
  ...(only === 'pharmacy' && { pharmacy: true as const }),
});

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  section('start', 'guide.start.title', 4, 2),
  section('sell', 'nav.sell', 5, 10),
  section('appointments', 'guide.appointments.title', 5, 6, 'salon'),
  section('pharmacy', 'guide.pharmacy.title', 5, 5, 'pharmacy'),
  section('shift', 'nav.history', 4, 4),
  section('close', 'nav.close', 3, 3),
  section('till', 'guide.till.title', 4, 2),
  section('trouble', 'guide.trouble.title', 4, 1),
];

/** `salon` false leaves out the appointments part, `pharmacy` false the medicines part; unknown (before sign-in) shows everything. */
export const guideSections = (salon = true, pharmacy = true) => GUIDE_SECTIONS.filter((s) => (salon || !s.salon) && (pharmacy || !s.pharmacy));
