-- Hand-edited (2026-10-25): tips and prepaid service packages leave no history behind. 0112 kept them as
-- append-only evidence; the user then chose to drop it too (there is no pilot data yet; the dev database
-- was backed up before 0112). The books are rewritten as if neither had existed:
-- * Tips: a sale's tip line (Tips payable) goes and its cash or card line loses the tip; a void's cash tip
--   given back goes the same way; the entries of tip pay-outs from the drawer and of card tips given back
--   after a void are deleted with their documents. The tip drawer movements (TIP, TIP_REFUND, TIP_PAYOUT),
--   the tips' card charges and their payment events, `sale_tips`, `sale_tip_refunds` and
--   `sale_returns.tip_refund` are deleted. Drawer counts closed before keep the expected cash and variance
--   recorded at the time (and their CASH_VARIANCE entries).
-- * Packages: every line on Prepaid service packages is moved to Sales (or Sales returns for a return), so
--   a package counts as sold when it was sold and the sessions used net to nothing;
--   `sale_lines.package_value` is dropped; archived PACKAGE products become SERVICE.
-- * The accounts 2210 Tips payable and 2310 Prepaid service packages are deleted from every chart.
-- Every journal entry is checked to balance afterwards. `FEATURE_RETIRED` goes with the rows it guarded.

ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_tips NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_tip_refunds NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_returns NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_movements NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_intents NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_events NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE products NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_entries DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE journal_lines DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE accounts DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE cash_movements DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE payment_intents DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE payment_events DISABLE TRIGGER USER;--> statement-breakpoint
-- A cash or card line that held only a tip drops to zero before it is deleted.
ALTER TABLE journal_lines DROP CONSTRAINT journal_lines_amount_check;--> statement-breakpoint

-- Tips: the sale's cash or card line without the tip; a void's cash line without the cash tip it gave back.
UPDATE journal_lines l SET debit = l.debit - t.amount
  FROM sale_tips t, journal_entries e, accounts a
 WHERE e.source_type = 'SALE' AND e.source_id = t.sale_id AND e.tenant_id = t.tenant_id
   AND l.journal_entry_id = e.id AND a.id = l.account_id
   AND a.system_key = CASE WHEN t.method = 'CASH' THEN 'CASH_ON_HAND' ELSE 'PAYMENT_CLEARING' END;--> statement-breakpoint
UPDATE journal_lines l SET credit = l.credit - r.tip_refund
  FROM sale_returns r, journal_entries e, accounts a
 WHERE r.tip_refund <> 0 AND e.source_type = 'SALE_RETURN' AND e.source_id = r.id AND e.tenant_id = r.tenant_id
   AND l.journal_entry_id = e.id AND a.id = l.account_id AND a.system_key = 'CASH_ON_HAND';--> statement-breakpoint
CREATE TEMPORARY TABLE removed_entries_0113 ON COMMIT DROP AS
  SELECT DISTINCT e.id FROM journal_entries e
    JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
   WHERE a.system_key = 'TIPS_PAYABLE' AND e.source_type IN ('SALE_TIP_REFUND', 'CASH_MOVEMENT');--> statement-breakpoint
DELETE FROM journal_lines l USING removed_entries_0113 x WHERE l.journal_entry_id = x.id;--> statement-breakpoint
DELETE FROM journal_entries e USING removed_entries_0113 x WHERE e.id = x.id;--> statement-breakpoint
DELETE FROM journal_lines l USING accounts a WHERE a.id = l.account_id AND a.system_key = 'TIPS_PAYABLE' AND l.journal_entry_id IN (
  SELECT id FROM journal_entries WHERE source_type IN ('SALE', 'SALE_RETURN'));--> statement-breakpoint
DELETE FROM journal_lines WHERE debit = 0 AND credit = 0;--> statement-breakpoint
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_amount_check CHECK (debit >= 0::numeric AND credit >= 0::numeric AND (debit = 0::numeric) <> (credit = 0::numeric));--> statement-breakpoint

-- Packages: what was owed is Sales (Sales returns on a return).
UPDATE journal_lines l SET account_id = s.id
  FROM accounts a, accounts s, journal_entries e
 WHERE a.id = l.account_id AND a.system_key = 'PREPAID_SERVICES' AND e.id = l.journal_entry_id
   AND s.tenant_id = a.tenant_id AND s.legal_entity_id = a.legal_entity_id
   AND s.system_key = CASE WHEN e.source_type = 'SALE_RETURN' THEN 'SALES_RETURNS' ELSE 'SALES' END;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key IN ('TIPS_PAYABLE', 'PREPAID_SERVICES')) THEN
    RAISE EXCEPTION '0113: journal lines are still booked on tips or prepaid packages';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries e LEFT JOIN journal_lines l ON l.journal_entry_id = e.id
              GROUP BY e.id HAVING count(l.id) < 2 OR coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)) THEN
    RAISE EXCEPTION '0113: a journal entry no longer balances';
  END IF;
END $$;--> statement-breakpoint
DELETE FROM accounts WHERE system_key IN ('TIPS_PAYABLE', 'PREPAID_SERVICES');--> statement-breakpoint

DELETE FROM cash_movements WHERE type IN ('TIP', 'TIP_REFUND', 'TIP_PAYOUT');--> statement-breakpoint
CREATE TEMPORARY TABLE removed_intents_0113 ON COMMIT DROP AS SELECT id FROM payment_intents WHERE purpose = 'TIP';--> statement-breakpoint
DROP TABLE "sale_tip_refunds" CASCADE;--> statement-breakpoint
DROP TABLE "sale_tips" CASCADE;--> statement-breakpoint
DELETE FROM payment_events v USING removed_intents_0113 x WHERE v.payment_intent_id = x.id;--> statement-breakpoint
DELETE FROM payment_intents p USING removed_intents_0113 x WHERE p.id = x.id;--> statement-breakpoint
UPDATE products SET product_type = 'SERVICE', updated_at = now() WHERE product_type = 'PACKAGE';--> statement-breakpoint

ALTER TABLE journal_entries ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE journal_lines ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE accounts ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE cash_movements ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE payment_intents ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE payment_events ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_returns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_movements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE products FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_tip_link";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_refund_link";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_reason_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumer_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumed_only_succeeded";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_type_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_package_value";--> statement-breakpoint
ALTER TABLE "sale_returns" DROP CONSTRAINT "sale_returns_tip_refund_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "package_value";--> statement-breakpoint
ALTER TABLE "sale_returns" DROP COLUMN "tip_refund";--> statement-breakpoint
-- NOT VALID as in 0111: movement types of the industries removed there stand.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" = 'PAY_IN' AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_refund_link" CHECK (("cash_movements"."type" = 'REFUND') = ("cash_movements"."sale_return_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK ("cash_movements"."type" NOT IN ('PAY_IN','PAY_OUT') OR length(trim(coalesce("cash_movements"."reason", ''))) > 0);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumer_check" CHECK (("payment_intents"."sale_id" IS NULL OR "payment_intents"."purpose" IN ('SALE')));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumed_only_succeeded" CHECK ("payment_intents"."sale_id" IS NULL OR "payment_intents"."status" = 'SUCCEEDED');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_type_check" CHECK ("products"."product_type" IN ('STANDARD','SERVICE'));--> statement-breakpoint

-- 0111's versions without tips: no TIP charges any more.
CREATE OR REPLACE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.purpose = 'SALE'))) THEN
    RAISE EXCEPTION 'card/QR payments on this shift are not settled' USING ERRCODE = '23514', CONSTRAINT = 'payments_outstanding';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.purpose <> 'SALE' AND (NEW.status <> OLD.status OR NEW.sale_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.sale_id IS NOT NULL AND (NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  ELSIF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
