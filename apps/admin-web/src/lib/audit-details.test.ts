import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/messages';
import { auditDetails } from './audit-details';

const tr = (lang: 'en' | 'fil') => (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);

describe('auditDetails', () => {
  it('names changed fields and common details in words, never values', () => {
    expect(auditDetails(tr('en'), { fields: ['phone', 'displayName'] })).toBe('Changed: phone, name');
    expect(auditDetails(tr('fil'), { fields: ['phone'] })).toBe('Binago: telepono');
    expect(auditDetails(tr('en'), { source: 'COUNTER', marketingConsent: true })).toBe(`How: ${translate('en', 'cust.source.COUNTER')} · Offers: Yes`);
  });

  it('counts other lists in the reader’s language and keeps unknown keys and the removed trades’ fields as stored', () => {
    expect(auditDetails(tr('fil'), { roles: ['a', 'b'] })).toBe('roles: 2 item');
    expect(auditDetails(tr('en'), { fields: ['patientName'], variantId: 'x', nested: { a: 1 }, gone: null })).toBe('Changed: patientName · variantId: x · nested: … · gone: —');
  });
});
