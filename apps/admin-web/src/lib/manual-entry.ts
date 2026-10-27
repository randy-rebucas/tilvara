/**
 * The system (control) accounts a manual journal entry may post to (audit 2026-10-27 #11): cash on hand,
 * the bank and money moved between them. Every other system account (stock, goods received not invoiced,
 * payables, store credit, VAT, sales, cost of sales...) is kept by its own documents, so the API refuses
 * it in a manual entry (`SYSTEM_ACCOUNT_NOT_ALLOWED`) and the picker does not offer it. The API says so
 * per account (`manualAllowed`); this list is the fallback and mirrors `MANUAL_SYSTEM_ACCOUNTS` in the API.
 */
export const MANUAL_ENTRY_SYSTEM_KEYS: ReadonlySet<string> = new Set(['CASH_ON_HAND', 'CASH_IN_BANK', 'CASH_TRANSFERS']);

/** Whether a manual entry may name this account: open, and either the business's own or an allowed system account. */
export function manualEntryAccount(a: { systemKey: string | null; archivedAt: string | null; manualAllowed?: boolean }): boolean {
  if (a.archivedAt) return false;
  if (a.manualAllowed !== undefined) return a.manualAllowed;
  return !a.systemKey || MANUAL_ENTRY_SYSTEM_KEYS.has(a.systemKey);
}
