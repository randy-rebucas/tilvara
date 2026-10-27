import { toDec } from '@1pos/money';
import type { MessageKey } from '../i18n';
import { peso } from './money';

/**
 * Refusals the till can meet, in the cashier's language (audit 2026-10-27 #29): the API words them in
 * English only. Each maps the error code to till copy (EN and FIL in `i18n.tsx`), with the figures it
 * needs from the error's details. A code not listed here shows the API's own message.
 */
type Details = Record<string, unknown>;
type Refusal = { key: MessageKey; vars?: (d: Details) => Record<string, string> };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const amount = (v: unknown) => (typeof v === 'string' && v ? peso(v) : '—');
const quantity = (v: unknown) => (typeof v === 'string' && v ? toDec(v).toString() : '—');

export const REFUSALS: Readonly<Record<string, Refusal>> = {
  SUBSCRIPTION_READ_ONLY: { key: 'refusal.readOnly' },
  TENANT_SUSPENDED: { key: 'refusal.suspended' },
  FORBIDDEN: { key: 'refusal.forbidden' },
  INSUFFICIENT_STOCK: {
    key: 'refusal.insufficientStock',
    vars: (d) => ({
      items: (Array.isArray(d.lines) ? (d.lines as { name?: unknown; onHand?: unknown }[]) : []).map((l) => `${str(l.name)} (${quantity(l.onHand)})`).join(', '),
    }),
  },
  EXPIRED_STOCK: { key: 'refusal.expiredStock' },
  ITEM_NOT_PRICED: { key: 'refusal.itemNotPriced' },
  RETURN_EXCEEDS_SOLD: { key: 'refusal.returnExceedsSold', vars: (d) => ({ n: quantity(d.remaining) }) },
  NOT_RESTOCKABLE: { key: 'refusal.notRestockable' },
  ALREADY_RETURNED: { key: 'refusal.alreadyReturned' },
  VOID_OUTSIDE_SESSION: { key: 'refusal.voidOutsideSession' },
  REFUND_CHANGED: { key: 'refusal.refundChanged' },
  TENDER_RETIRED: { key: 'refusal.tenderRetired' },
  INSUFFICIENT_DRAWER_CASH: { key: 'refusal.drawerCash', vars: (d) => ({ amount: amount(d.available) }) },
  EXCHANGE_STORE_CREDIT: { key: 'refusal.exchangeStoreCredit' },
  EXCHANGE_IN_CASH: { key: 'refusal.exchangeInCash' },
  ALREADY_EXCHANGED: { key: 'refusal.alreadyExchanged' },
  CREDIT_GOES_TO_PAYER: { key: 'refusal.creditGoesToPayer' },
  CUSTOMER_REQUIRED: { key: 'refusal.customerRequired' },
  STORE_CREDIT_NEEDS_CUSTOMER: { key: 'refusal.customerRequired' },
  INSUFFICIENT_STORE_CREDIT: { key: 'refusal.storeCredit', vars: (d) => ({ amount: amount(d.balance) }) },
  CUSTOMER_ANONYMISED: { key: 'refusal.customerAnonymised' },
  PRICE_OVERRIDE_EXPIRED: { key: 'refusal.overrideExpired' },
  PRICE_OVERRIDE_USED: { key: 'refusal.overrideUsed' },
  PRICE_OVERRIDE_MISMATCH: { key: 'refusal.overrideMismatch' },
  PRICE_OVERRIDE_QUANTITY: { key: 'refusal.overrideQuantity', vars: (d) => ({ n: quantity(d.approvedQuantity) }) },
  PRICE_OVERRIDE_REPEATED: { key: 'refusal.overrideRepeated' },
  APPROVER_NOT_ALLOWED: { key: 'refusal.approverNotAllowed' },
  APPROVAL_REQUIRED: { key: 'refusal.approvalRequired' },
  SELF_APPROVAL: { key: 'refusal.selfApproval' },
  INSUFFICIENT_TENDER: { key: 'refusal.insufficientTender' },
  DUPLICATE_TENDER: { key: 'refusal.duplicateTender' },
  PAYMENT_IN_PROGRESS: { key: 'refusal.paymentInProgress' },
  PAYMENT_NOT_SUCCEEDED: { key: 'refusal.paymentNotSucceeded' },
  SESSION_NOT_OPEN: { key: 'refusal.sessionNotOpen' },
  NOT_SESSION_OWNER: { key: 'refusal.notSessionOwner' },
  SESSION_ALREADY_OPEN: { key: 'refusal.sessionAlreadyOpen' },
  WRONG_REGISTER: { key: 'refusal.wrongRegister' },
  HELD_CART_CLOSED: { key: 'refusal.heldCartClosed' },
  IDEMPOTENCY_KEY_REUSED: { key: 'refusal.keyReused' },
  PERIOD_CLOSED: { key: 'refusal.periodClosed' },
};

/**
 * The till's words for a refusal, or null when the code is not one the till words itself (the caller
 * then shows the API's message). `tr` is the language on screen (`translate`, or a component's `t`).
 */
export function refusalText(code: string, details: Details | undefined, tr: (key: MessageKey) => string): string | null {
  const r = Object.prototype.hasOwnProperty.call(REFUSALS, code) ? REFUSALS[code] : undefined;
  if (!r) return null;
  let s = tr(r.key);
  if (r.vars) for (const [k, v] of Object.entries(r.vars(details ?? {}))) s = s.replaceAll(`{${k}}`, v);
  return s;
}
