import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/messages';
import { drugBody, drugClassesFor, genericLabel, needsPrescription } from './pharmacy';

const t = (key: MessageKey) => translate('en', key);

describe('medicines (ADR-0025)', () => {
  it('offers prescription classes only to a pharmacy, keeping a class the product already has', () => {
    expect(drugClassesFor(false)).toEqual(['OTC']);
    expect(drugClassesFor(true)).toEqual(['OTC', 'RX', 'ANTIBIOTIC', 'DANGEROUS']);
    expect(drugClassesFor(false, 'RX')).toEqual(['OTC', 'RX']);
  });

  it('says which classes need a prescription', () => {
    expect(['OTC', 'RX', 'ANTIBIOTIC', 'DANGEROUS', null].map((c) => needsPrescription(c as never))).toEqual([false, true, true, true, false]);
  });

  it('words the generic, strength and form', () => {
    expect(genericLabel(t, { genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET' })).toBe('Paracetamol 500 mg tablet');
    expect(genericLabel(t, { genericName: 'Salbutamol', strength: null, dosageForm: 'INHALER' })).toBe('Salbutamol inhaler');
  });

  it('sends the medicine section, or null when it is off', () => {
    const f = new FormData();
    f.set('drugClass', 'ANTIBIOTIC');
    f.set('genericName', ' Amoxicillin ');
    f.set('strength', '');
    f.set('dosageForm', 'CAPSULE');
    expect(drugBody(f, true)).toEqual({ drugClass: 'ANTIBIOTIC', genericName: 'Amoxicillin', strength: null, dosageForm: 'CAPSULE', fdaRegistrationNo: null });
    expect(drugBody(f, false)).toBeNull();
  });
});
