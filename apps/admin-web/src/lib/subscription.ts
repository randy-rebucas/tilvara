import type { MessageKey } from '../i18n/messages';
import type { Subscription } from './api';

/** One part of the plan's line under its name: a copy key with its count or date. */
export interface PlanFact {
  key: MessageKey;
  n?: number;
  date?: string;
}

const DAY = 86_400_000;
/** The last days of a trial, when the owner is told it is ending. */
export const TRIAL_WARNING_DAYS = 3;

/**
 * What to say about the subscription's dates. A trial past its end keeps the status TRIALING (nothing
 * changes it until billing exists), so it reads "trial ended", not "0 days left"; grace only while past due.
 */
export function planFacts(sub: Pick<Subscription, 'status' | 'trialEndsAt' | 'currentPeriodEnd' | 'graceEndsAt'>, now = Date.now()): PlanFact[] {
  switch (sub.status) {
    case 'TRIALING': {
      if (!sub.trialEndsAt) return [];
      const left = new Date(sub.trialEndsAt).getTime() - now;
      if (left <= 0) return [{ key: 'sub.trialEnded', date: sub.trialEndsAt }];
      const n = Math.ceil(left / DAY);
      return [n === 1 ? { key: 'sub.dayLeft' } : { key: 'sub.daysLeft', n }, { key: 'sub.trialEnds', date: sub.trialEndsAt }];
    }
    case 'ACTIVE':
      return sub.currentPeriodEnd ? [{ key: 'sub.paidUntil', date: sub.currentPeriodEnd }] : [];
    case 'PAST_DUE':
      return sub.graceEndsAt ? [{ key: 'sub.graceUntil', date: sub.graceEndsAt }] : [];
    default:
      return [];
  }
}

/** The trial's end when it is within its last days and the business can still write; else null. */
export function trialEndingSoon(sub: Pick<Subscription, 'status' | 'access' | 'trialEndsAt'>, now = Date.now()): string | null {
  if (sub.status !== 'TRIALING' || sub.access !== 'FULL' || !sub.trialEndsAt) return null;
  const left = new Date(sub.trialEndsAt).getTime() - now;
  return left > 0 && left <= TRIAL_WARNING_DAYS * DAY ? sub.trialEndsAt : null;
}
