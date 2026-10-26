-- Leftovers of the removals (0110–0113), found by the retail fit audit (session 36).
--
-- 1. Journal sources: SALE_TIP_REFUND goes (0113 deleted every such entry). NOT VALID as in 0111: entries of removed
--    features (FOLIO_ENTRY, FOLIO_PAYMENT, JOB_ORDER_DEPOSIT, STAY_DEPOSIT) stay as history and are never updated.
-- 2. API keys: 0110–0112 re-added the scope check NOT VALID without the removed scopes, but Postgres checks it on every
--    UPDATE, so a key made before them that lists lodging.read, laundry.read or appointments.read could neither note its
--    last use (auth_api_key) nor be revoked. Those names are allowed again on any row: they grant nothing (AuthGuard keeps
--    known permission codes only), and new keys take the current scopes only (validation). Every key ever made fits, so
--    the check is validated.
-- 3. Card/QR payments of a purpose no longer offered (a laundry down payment before 0110, a folio payment before 0111)
--    still PROCESSING or UNKNOWN blocked their shift's close and could not be reconciled: the transition trigger froze
--    every non-sale intent. Such an intent may now take the provider's answer (PROCESSING/UNKNOWN → SUCCEEDED/FAILED,
--    PROCESSING → UNKNOWN); it is still never consumed by a sale, and once settled it stays as it is. The purpose
--    check, NOT VALID since 0110 but checked on every UPDATE, refused even that: it now lists the four purposes ever
--    used (validated), and a trigger keeps a new payment for a sale.
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP','FOLIO','JOB_ORDER'));--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','MANUAL','REVERSAL')) NOT VALID;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") > 0 AND "api_keys"."scopes" <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read','lodging.read','laundry.read','appointments.read']::text[]);--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_payment_intent_new_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose <> 'SALE' THEN
    RAISE EXCEPTION 'a new card/QR payment is for a sale' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_purpose_check';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER payment_intents_new_purpose BEFORE INSERT ON payment_intents FOR EACH ROW EXECUTE FUNCTION app_payment_intent_new_purpose();--> statement-breakpoint

-- 0113's version, with the provider's answer allowed on a payment of a retired purpose.
CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.purpose <> 'SALE' AND (NEW.sale_id IS NOT NULL OR (NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))))) THEN
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
