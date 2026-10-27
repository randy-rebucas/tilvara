import { describe, expect, it } from 'vitest';
import { planFacts, trialEndingSoon } from './subscription';

const now = Date.parse('2026-10-27T12:00:00Z');
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const sub = (status: string, dates: { trialEndsAt?: string; currentPeriodEnd?: string; graceEndsAt?: string } = {}) => ({
  status,
  trialEndsAt: dates.trialEndsAt ?? null,
  currentPeriodEnd: dates.currentPeriodEnd ?? null,
  graceEndsAt: dates.graceEndsAt ?? null,
});

describe('the plan line', () => {
  it('counts a trial’s days, one day in the singular', () => {
    expect(planFacts(sub('TRIALING', { trialEndsAt: at(24 * 5 + 1) }), now)).toEqual([
      { key: 'sub.daysLeft', n: 6 },
      { key: 'sub.trialEnds', date: at(24 * 5 + 1) },
    ]);
    expect(planFacts(sub('TRIALING', { trialEndsAt: at(3) }), now)[0]).toEqual({ key: 'sub.dayLeft' });
  });

  it('says a trial past its end has ended, not 0 days left', () => {
    expect(planFacts(sub('TRIALING', { trialEndsAt: at(-1) }), now)).toEqual([{ key: 'sub.trialEnded', date: at(-1) }]);
  });

  it('shows grace only while past due, and the paid-until date while active', () => {
    expect(planFacts(sub('CANCELED', { graceEndsAt: at(48) }), now)).toEqual([]);
    expect(planFacts(sub('PAST_DUE', { graceEndsAt: at(48) }), now)).toEqual([{ key: 'sub.graceUntil', date: at(48) }]);
    expect(planFacts(sub('ACTIVE', { currentPeriodEnd: at(720) }), now)).toEqual([{ key: 'sub.paidUntil', date: at(720) }]);
  });

  it('warns of a trial ending only in its last three days, while it can still write', () => {
    expect(trialEndingSoon({ status: 'TRIALING', access: 'FULL', trialEndsAt: at(24 * 3) }, now)).toBe(at(24 * 3));
    expect(trialEndingSoon({ status: 'TRIALING', access: 'FULL', trialEndsAt: at(24 * 3 + 1) }, now)).toBeNull();
    expect(trialEndingSoon({ status: 'TRIALING', access: 'READ_ONLY', trialEndsAt: at(-1) }, now)).toBeNull();
    expect(trialEndingSoon({ status: 'ACTIVE', access: 'FULL', trialEndsAt: at(24) }, now)).toBeNull();
  });
});
