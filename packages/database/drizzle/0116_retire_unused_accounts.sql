-- Hand-edited (2026-10-26, retail fit audit of Books): the accounts of the removed industries leave the charts.
-- * Lodging (0111) and laundry (0110) left their accounts in every chart made before them: 1150 Guest ledger,
--   2120 Accommodation tax payable, 2320 Guest deposits, 2330 Customer down payments, 4100 Room revenue,
--   4110 Cancellation fees and 4120 Forfeited down payments. Nothing posts to them any more. Where a chart
--   never posted to one it is deleted; where it did, it is archived, so its balance and history stay in the
--   trial balance and the journal while it leaves the account pickers. It keeps its system key as a record.
-- * 2200 Service charge payable leaves the default chart (@1pos/accounting). It is deleted where a chart never
--   posted to it; where restaurant sales charged one it stays active, since a return of such a sale gives the
--   charge back through it (ADR-0009, 0111).
-- Accounts are append-only and system accounts cannot be archived (triggers), so user triggers are off for
-- these two statements, as in 0113. Run as the migrator under FORCE RLS: both tables read are opened.

ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts DISABLE TRIGGER USER;--> statement-breakpoint
DELETE FROM accounts a
 WHERE a.system_key IN ('GUEST_LEDGER', 'ACCOMMODATION_TAX_PAYABLE', 'GUEST_DEPOSITS', 'CUSTOMER_DOWN_PAYMENTS',
                        'ROOM_REVENUE', 'CANCELLATION_INCOME', 'FORFEITED_DOWN_PAYMENTS', 'SERVICE_CHARGE_PAYABLE')
   AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id);--> statement-breakpoint
UPDATE accounts SET archived_at = now()
 WHERE system_key IN ('GUEST_LEDGER', 'ACCOMMODATION_TAX_PAYABLE', 'GUEST_DEPOSITS', 'CUSTOMER_DOWN_PAYMENTS',
                      'ROOM_REVENUE', 'CANCELLATION_INCOME', 'FORFEITED_DOWN_PAYMENTS')
   AND archived_at IS NULL;--> statement-breakpoint
ALTER TABLE accounts ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
