import { describe, expect, it } from 'vitest';
import { billDueSoon, planFacts, trialEndingSoon } from './subscription';

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

describe('billDueSoon (ADR-0027)', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const bill = (dueAt: string) => ({ id: 'b', number: 'B-000002', amount: '1499.0000', currency: 'PHP', dueAt });
  it('reminds of an open bill due within a week, or overdue while the business can still write', () => {
    expect(billDueSoon({ access: 'FULL', openBill: bill('2026-11-07T00:00:00Z') }, now)?.number).toBe('B-000002');
    expect(billDueSoon({ access: 'FULL', openBill: bill('2026-10-30T00:00:00Z') }, now)?.number).toBe('B-000002');
  });
  it('says nothing for a bill further off, without a bill, or once read-only (that notice says more)', () => {
    expect(billDueSoon({ access: 'FULL', openBill: bill('2026-11-09T00:00:00Z') }, now)).toBeNull();
    expect(billDueSoon({ access: 'FULL', openBill: null }, now)).toBeNull();
    expect(billDueSoon({ access: 'FULL' }, now)).toBeNull();
    expect(billDueSoon({ access: 'READ_ONLY', openBill: bill('2026-10-30T00:00:00Z') }, now)).toBeNull();
  });
});
