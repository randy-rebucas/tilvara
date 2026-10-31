import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/messages';
import { auditDetails } from './audit-details';
import { formatDateTime } from './format';

const tr = (lang: 'en' | 'fil') => (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);

describe('auditDetails', () => {
  it('names changed fields and common details in words, never values', () => {
    expect(auditDetails(tr('en'), { fields: ['phone', 'displayName'] })).toBe('Changed: phone, name');
    expect(auditDetails(tr('fil'), { fields: ['phone'] })).toBe('Binago: telepono');
    expect(auditDetails(tr('en'), { source: 'COUNTER', marketingConsent: true })).toBe(`How: ${translate('en', 'cust.source.COUNTER')} · Offers: Yes`);
  });

  it('counts other lists in the reader’s language and keeps unknown keys and the removed trades’ fields as stored', () => {
    expect(auditDetails(tr('fil'), { roles: ['a', 'b'] })).toBe('roles: 2 item');
    expect(auditDetails(tr('en'), { fields: ['patientName'], variantId: 'x', nested: { a: 1 }, gone: null })).toBe('Changed: patientName · variantId: x · nested: …');
  });

  it('words billing and subscription rows: plans, statuses, reason codes, who, dates and sizes', () => {
    const row = {
      fromPlan: 'starter', fromStatus: 'TRIALING', plan: 'growth', status: 'PAST_DUE', trialEndsAt: null,
      periodEnd: '2026-11-30T16:00:00+00:00', graceEndsAt: '2026-12-07T16:00:00+00:00', actor: 'billing', reason: 'PAID_UNTIL_REACHED',
    };
    const when = (iso: string) => formatDateTime(new Date(iso).toISOString(), 'en');
    expect(auditDetails(tr('en'), row, 'en')).toBe(
      `Plan before: Starter · Status before: Trial · Plan: Growth · Status: Past due · Paid until: ${when(row.periodEnd)} · Grace ends: ${when(row.graceEndsAt)} · By: Automatic billing · Reason: Paid-until date reached`,
    );
    expect(auditDetails(tr('fil'), { actor: 'support', reason: 'CHANGED_BY_SUPPORT' }, 'fil')).toBe('Ni: Suporta ng Tilvara · Dahilan: Binago ng suporta ng Tilvara');
    // Older rows: English reasons as written, ops' login never shown.
    expect(auditDetails(tr('en'), { number: 'B-1', reason: 'ops:jdoe: disputed (ticket SUP-9)', by: 'ops:jdoe' })).toBe('Number: B-1 · Reason: Tilvara support · By: Tilvara support');
    expect(auditDetails(tr('en'), { reason: 'Paid-until date reached', by: 'paymongo', method: 'GCASH', provider: 'PAYMONGO' })).toBe('Reason: Paid-until date reached · By: PayMongo · Method: GCash · Paid through: PayMongo');
    expect(auditDetails(tr('en'), { sizeBytes: 2_621_440, limit: 'maxBranches', scheduledPlan: 'starter' })).toBe('Size: 2.5 MB · Over the limit for: Branches · Next plan: Starter');
  });
});
