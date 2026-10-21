import type { MessageKey } from '@/i18n/messages';
import type { DosageForm, DrugClass } from './api';

/** ADR-0025 §2. Over the counter everywhere; the prescription classes only for a pharmacy (the API refuses them otherwise). */
export const DRUG_CLASSES: readonly DrugClass[] = ['OTC', 'RX', 'ANTIBIOTIC', 'DANGEROUS'];
export const DOSAGE_FORMS: readonly DosageForm[] = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'DROPS', 'CREAM', 'OINTMENT', 'INJECTION', 'INHALER', 'SACHET', 'OTHER'];

/** Classes a sale line needs a prescription for (ADR-0025 §6). */
export const needsPrescription = (c: DrugClass | null | undefined) => c === 'RX' || c === 'ANTIBIOTIC' || c === 'DANGEROUS';

/** The classes the product form offers: OTC only unless the business serves a pharmacy (keeping a class the product already has). */
export const drugClassesFor = (pharmacy: boolean, current?: DrugClass | null): DrugClass[] =>
  DRUG_CLASSES.filter((c) => c === 'OTC' || pharmacy || c === current);

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** "Paracetamol 500 mg tablet": the generic, strength and form in the viewer's words. */
export function genericLabel(t: T, d: { genericName?: string | null; strength?: string | null; dosageForm?: DosageForm | null }): string {
  return [d.genericName, d.strength, d.dosageForm ? t(`drug.form.${d.dosageForm}` as MessageKey).toLowerCase() : null].filter(Boolean).join(' ');
}

/** What the product form sends as `drug`: null when the section is off (not a medicine). */
export function drugBody(f: FormData, on: boolean) {
  if (!on) return null;
  const s = (k: string) => String(f.get(k) ?? '').trim();
  return {
    drugClass: s('drugClass') || 'OTC',
    genericName: s('genericName'),
    strength: s('strength') || null,
    dosageForm: s('dosageForm') || 'TABLET',
    fdaRegistrationNo: s('fdaRegistrationNo') || null,
  };
}
