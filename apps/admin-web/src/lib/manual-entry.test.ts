import { describe, expect, it } from 'vitest';
import { manualEntryAccount } from './manual-entry';

describe('manual entry account picker', () => {
  it('offers the business’s own open accounts and the cash/bank/transfer system accounts', () => {
    expect(manualEntryAccount({ systemKey: null, archivedAt: null })).toBe(true);
    for (const key of ['CASH_ON_HAND', 'CASH_IN_BANK', 'CASH_TRANSFERS']) expect(manualEntryAccount({ systemKey: key, archivedAt: null }), key).toBe(true);
  });

  it('does not offer control accounts kept by documents, nor archived ones', () => {
    for (const key of ['INVENTORY', 'INVENTORY_IN_TRANSIT', 'GRNI', 'ACCOUNTS_PAYABLE', 'CUSTOMER_STORE_CREDIT', 'OUTPUT_VAT', 'COGS', 'SALES']) {
      expect(manualEntryAccount({ systemKey: key, archivedAt: null }), key).toBe(false);
    }
    expect(manualEntryAccount({ systemKey: null, archivedAt: '2026-10-01T00:00:00Z' })).toBe(false);
  });

  it('follows the API’s manualAllowed when it is given', () => {
    expect(manualEntryAccount({ systemKey: 'INVENTORY', archivedAt: null, manualAllowed: true })).toBe(true);
    expect(manualEntryAccount({ systemKey: null, archivedAt: null, manualAllowed: false })).toBe(false);
    expect(manualEntryAccount({ systemKey: null, archivedAt: '2026-10-01T00:00:00Z', manualAllowed: true })).toBe(false);
  });
});
