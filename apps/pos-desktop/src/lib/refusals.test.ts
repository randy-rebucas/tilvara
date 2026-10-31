import { describe, expect, it } from 'vitest';
import { messages, type MessageKey } from '../i18n';
import { REFUSALS, refusalText } from './refusals';

const en = (k: MessageKey) => messages.en[k];
const fil = (k: MessageKey) => messages.fil[k];

describe('refusals in the cashier’s language (audit 2026-10-27 #29)', () => {
  it('words every listed code in English and Filipino', () => {
    for (const [code, r] of Object.entries(REFUSALS)) {
      expect(messages.en[r.key], code).toBeTruthy();
      expect(messages.fil[r.key], code).toBeTruthy();
      expect(messages.fil[r.key], code).not.toBe(messages.en[r.key]);
    }
  });

  it('covers the refusals a till meets on sales, returns, prices and payments', () => {
    for (const code of [
      'INSUFFICIENT_STOCK', 'RETURN_EXCEEDS_SOLD', 'INSUFFICIENT_DRAWER_CASH', 'PRICE_OVERRIDE_EXPIRED', 'PRICE_OVERRIDE_USED', 'PRICE_OVERRIDE_MISMATCH',
      'PRICE_OVERRIDE_QUANTITY', 'EXCHANGE_STORE_CREDIT', 'TENDER_RETIRED', 'REFUND_CHANGED', 'IDEMPOTENCY_KEY_REUSED', 'EXPIRED_STOCK', 'HELD_CART_CLOSED',
    ]) expect(REFUSALS[code], code).toBeDefined();
  });

  it('covers signing in, choosing a business, approvals and a payment being cancelled (audit 2026-10-31 #5, #26)', () => {
    for (const code of [
      'INVALID_CREDENTIALS', 'TOO_MANY_ATTEMPTS', 'RATE_LIMITED', 'NOT_A_MEMBER', 'APPROVER_INVALID_CREDENTIALS', 'APPROVER_INVALID_CODE', 'APPROVER_CODE_REQUIRED', 'PAYMENT_CANCELLING',
    ]) expect(REFUSALS[code], code).toBeDefined();
    expect(refusalText('INVALID_CREDENTIALS', undefined, fil)).toBe('Mali ang email o password.');
    expect(refusalText('PAYMENT_CANCELLING', {}, en)).toBe('This payment is being cancelled. Wait for it, then take payment again.');
  });

  it('fills in the figures from the error details, as money and quantities from decimal strings', () => {
    expect(refusalText('INSUFFICIENT_STOCK', { lines: [{ name: 'Cola', onHand: '2.0000' }, { name: 'Rice', onHand: '0' }] }, en))
      .toBe('Not enough stock for: Cola (2), Rice (0). Change the quantity or remove the item.');
    expect(refusalText('INSUFFICIENT_DRAWER_CASH', { available: '1250.50' }, fil)).toBe('Kulang ang pera sa drawer na ito para diyan (₱1,250.50 ang laman).');
    expect(refusalText('RETURN_EXCEEDS_SOLD', { remaining: '1.5000' }, en)).toBe('That is more than is left to return on this line (1.5 left).');
    expect(refusalText('PRICE_OVERRIDE_QUANTITY', {}, en)).toBe('This price was approved for —. Ask again for more.');
  });

  it('leaves an unknown code to the API’s message (null), and never reads inherited keys', () => {
    expect(refusalText('SOMETHING_NEW', {}, en)).toBeNull();
    expect(refusalText('constructor', undefined, en)).toBeNull();
    expect(refusalText('TENDER_RETIRED', undefined, fil)).toBe(fil('refusal.tenderRetired'));
  });
});
