-- Hand-edited (2026-10-25): laundromats and laundry shops are no longer offered; ADR-0024 is withdrawn.
-- Job orders, down payments, machines, machine runs, trips, notices and laundry settings are dropped with
-- their links on sales, sale lines, tenders, payment intents, cash movements and product variants.
-- * A LAUNDRY business becomes RETAIL (HYBRID keeps everything else it has).
-- * The laundry.* permissions leave the catalog and every role. The Laundry Attendant and Rider roles are
--   deleted where nobody holds them; a held one stays as the business's own role with what it had besides
--   laundry, so its members can still sell.
-- * Money already recorded stays as it was: drawer movements, tenders and journal entries of down payments
--   (and the accounts 2330 and 4120 they posted to) are append-only evidence. The checks below are NOT VALID
--   so those old rows stand while no new row may use a laundry value; on a database without laundry
--   history they are the same as valid checks. API keys keep their recorded scopes (a key is never
--   edited): `laundry.read` grants nothing now.
-- * Webhooks lose the job_order.* topics; one that listened to nothing else is turned off.

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE tenants SET business_type = 'RETAIL' WHERE business_type = 'LAUNDRY';--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM role_permissions WHERE permission_code LIKE 'laundry.%';--> statement-breakpoint
ALTER TABLE membership_roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM roles r WHERE r.is_system AND r.key IN ('laundry_attendant', 'rider')
   AND NOT EXISTS (SELECT 1 FROM membership_roles m WHERE m.tenant_id = r.tenant_id AND m.role_id = r.id);--> statement-breakpoint
UPDATE roles SET is_system = false WHERE is_system AND key IN ('laundry_attendant', 'rider');--> statement-breakpoint
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM permissions WHERE code LIKE 'laundry.%';--> statement-breakpoint
ALTER TABLE webhook_endpoints NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE webhook_endpoints SET enabled = false, updated_at = now()
 WHERE enabled AND topics <@ ARRAY['job_order.ready', 'job_order.claimed']::text[];--> statement-breakpoint
UPDATE webhook_endpoints SET topics = array_remove(array_remove(topics, 'job_order.ready'), 'job_order.claimed'), updated_at = now()
 WHERE topics && ARRAY['job_order.ready', 'job_order.claimed']::text[] AND NOT topics <@ ARRAY['job_order.ready', 'job_order.claimed']::text[];--> statement-breakpoint
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP TABLE "job_order_deposits" CASCADE;--> statement-breakpoint
DROP TABLE "job_order_items" CASCADE;--> statement-breakpoint
DROP TABLE "job_order_lines" CASCADE;--> statement-breakpoint
DROP TABLE "job_order_notices" CASCADE;--> statement-breakpoint
DROP TABLE "job_order_status_changes" CASCADE;--> statement-breakpoint
DROP TABLE "job_order_trips" CASCADE;--> statement-breakpoint
DROP TABLE "job_orders" CASCADE;--> statement-breakpoint
DROP TABLE "laundry_garment_types" CASCADE;--> statement-breakpoint
DROP TABLE "laundry_machines" CASCADE;--> statement-breakpoint
DROP TABLE "laundry_settings" CASCADE;--> statement-breakpoint
DROP TABLE "machine_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_laundry_check";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_machine_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_job_deposit_link";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumer_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_job_deposit_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_intent_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_tenant_id_job_order_deposit_id_job_order_deposits_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_tenant_id_job_order_id_job_orders_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT IF EXISTS "sale_lines_tenant_id_machine_id_laundry_machines_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT IF EXISTS "sale_tenders_tenant_id_job_order_id_job_orders_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "sales_tenant_id_job_order_id_job_orders_tenant_id_id_fk";
--> statement-breakpoint
DROP INDEX "sales_job_order_once";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "laundry_unit";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "laundry_min_quantity";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "laundry_kg_per_load";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "laundry_addon";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "machine_kind";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "machine_minutes";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP COLUMN "job_order_deposit_id";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP COLUMN "job_order_id";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "machine_id";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP COLUMN "job_order_id";--> statement-breakpoint
ALTER TABLE "sales" DROP COLUMN "job_order_id";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','RESTAURANT','HYBRID','GROCERY','SALON','LODGING','PHARMACY'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','TIP','TIP_REFUND','TIP_PAYOUT','FOLIO_PAYMENT','DEPOSIT','DEPOSIT_REFUND')) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND','TIP_REFUND','TIP_PAYOUT','DEPOSIT_REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN','TIP','FOLIO_PAYMENT','DEPOSIT') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP','FOLIO')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumer_check" CHECK (("payment_intents"."sale_id" IS NULL OR "payment_intents"."purpose" IN ('SALE','TIP')) AND ("payment_intents"."folio_id" IS NULL OR ("payment_intents"."purpose" = 'FOLIO' AND "payment_intents"."status" = 'SUCCEEDED')));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT','ROOM_CHARGE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" IN ('CASH','STORE_CREDIT','ROOM_CHARGE')) = ("sale_tenders"."payment_intent_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','SALE_TIP_REFUND','FOLIO_ENTRY','FOLIO_PAYMENT','STAY_DEPOSIT','MANUAL','REVERSAL')) NOT VALID;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") > 0 AND "api_keys"."scopes" <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read','lodging.read','appointments.read']::text[]) NOT VALID;--> statement-breakpoint

DROP FUNCTION platform_flag_laundry_notices();--> statement-breakpoint
DROP FUNCTION laundry_notice_settle(uuid, text, text, text, text, text);--> statement-breakpoint
DROP FUNCTION app_job_order_status();--> statement-breakpoint
DROP FUNCTION app_job_order_open();--> statement-breakpoint
DROP FUNCTION app_machine_run_update();--> statement-breakpoint
DROP FUNCTION app_job_order_deposit();--> statement-breakpoint
DROP FUNCTION app_job_order_notice_update();--> statement-breakpoint

-- The 0102 versions again, without job orders. A card/QR down payment taken before this migration was
-- consumed by a job order that is gone: it does not hold its shift open and does not change.
CREATE OR REPLACE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.folio_id IS NULL AND p.purpose <> 'JOB_ORDER'))) THEN
    RAISE EXCEPTION 'card/QR payments on this shift are not settled' USING ERRCODE = '23514', CONSTRAINT = 'payments_outstanding';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- A card/QR payment consumed by a folio or a deposit (ADR-0023) is final, like one consumed by a sale (0094).
CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF (OLD.folio_id IS NOT NULL OR OLD.purpose = 'JOB_ORDER') AND (NEW.folio_id IS DISTINCT FROM OLD.folio_id OR NEW.status <> OLD.status OR NEW.sale_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.sale_id IS NOT NULL AND (NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.status <> OLD.status) THEN
    -- A voided sale's card tip, given back by cancelling its charge (its refund row comes first).
    IF NOT (OLD.purpose = 'TIP' AND NEW.sale_id = OLD.sale_id AND OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED'
            AND EXISTS (SELECT 1 FROM sale_tip_refunds r WHERE r.tenant_id = OLD.tenant_id AND r.payment_intent_id = OLD.id AND r.method = 'CARD')) THEN
      RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
    END IF;
  ELSIF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL AND NEW.folio_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
