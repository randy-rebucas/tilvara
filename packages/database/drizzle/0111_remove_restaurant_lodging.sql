-- Hand-edited (2026-10-25): restaurants (all table service) and lodging are no longer offered; ADR-0014
-- (restaurant orders) and ADR-0023 (lodging) are withdrawn. Dropped: dining areas, tables, kitchen
-- stations, menus and their versions, choices (modifier groups and options), restaurant settings,
-- sold-out items, orders, order items, course notes, item moves, kitchen tickets, bills, bill lines,
-- charges, beneficiaries and allocations; room types, rooms, room blocks and status changes, stays,
-- the guest registry, folios, folio entries and payments, stay deposits and lodging settings. With them
-- go the links on sales (`order_bill_id`), sale charges, tenders (`stay_id`), payment intents
-- (`folio_id`), cash movements and store credit (`folio_payment_id`, `stay_deposit_id`).
-- * Recipes stay (a salon's "supplies used"); so do tips, and `sale_charges` / `sale_return_charges` /
--   `sale_lines.parent_line_id`, which hold what earlier restaurant sales were made of: those sales still
--   add up, and a return of one still gives its service charge back.
-- * A RESTAURANT or LODGING business becomes RETAIL; HYBRID keeps salons and pharmacies.
-- * The restaurant.*, kitchen.* and lodging.* permissions leave the catalog and every role. The Restaurant
--   Manager, Kitchen Crew and Housekeeping roles, and the Front Desk of a business without appointments,
--   are deleted where nobody holds them; a held one stays as the business's own role with what it had left.
-- * Plans lose the `restaurant` feature. Webhooks lose the stay.* and folio.* topics; one that listened to
--   nothing else is turned off.
-- * Money already recorded stays as it was (append-only evidence): room-charge tenders, folio and deposit
--   drawer movements, store credit spent on folios, returns put back on a folio, and their journal entries
--   (the accounts 1150, 2120, 2320, 4100 and 4110 stay in existing charts). As in 0110, the checks below
--   are NOT VALID so those old rows stand while no new row may use those values. API keys keep their
--   recorded scopes: `lodging.read` grants nothing now.

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE tenants SET business_type = 'RETAIL' WHERE business_type IN ('RESTAURANT', 'LODGING');--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE membership_roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM role_permissions WHERE permission_code LIKE 'restaurant.%' OR permission_code LIKE 'kitchen.%' OR permission_code LIKE 'lodging.%';--> statement-breakpoint
CREATE TEMPORARY TABLE removed_roles ON COMMIT DROP AS
  SELECT r.tenant_id, r.id FROM roles r JOIN tenants t ON t.id = r.tenant_id
   WHERE r.is_system AND (r.key IN ('restaurant_manager', 'kitchen_crew', 'housekeeping')
                          OR (r.key = 'front_desk' AND t.business_type NOT IN ('SALON', 'HYBRID')));--> statement-breakpoint
DELETE FROM roles r USING removed_roles x
 WHERE r.tenant_id = x.tenant_id AND r.id = x.id
   AND NOT EXISTS (SELECT 1 FROM membership_roles m WHERE m.tenant_id = r.tenant_id AND m.role_id = r.id);--> statement-breakpoint
UPDATE roles r SET is_system = false FROM removed_roles x WHERE r.tenant_id = x.tenant_id AND r.id = x.id;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM permissions WHERE code LIKE 'restaurant.%' OR code LIKE 'kitchen.%' OR code LIKE 'lodging.%';--> statement-breakpoint
UPDATE plans SET features = features - 'restaurant' WHERE features ? 'restaurant';--> statement-breakpoint
ALTER TABLE webhook_endpoints NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE webhook_endpoints SET enabled = false, updated_at = now()
 WHERE enabled AND topics <@ ARRAY['stay.checked_in', 'stay.checked_out', 'folio.entry_posted']::text[];--> statement-breakpoint
UPDATE webhook_endpoints
   SET topics = array(SELECT x FROM unnest(topics) AS x WHERE x NOT IN ('stay.checked_in', 'stay.checked_out', 'folio.entry_posted')), updated_at = now()
 WHERE topics && ARRAY['stay.checked_in', 'stay.checked_out', 'folio.entry_posted']::text[]
   AND NOT topics <@ ARRAY['stay.checked_in', 'stay.checked_out', 'folio.entry_posted']::text[];--> statement-breakpoint
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP TABLE "order_bill_allocations" CASCADE;--> statement-breakpoint
DROP TABLE "dining_areas" CASCADE;--> statement-breakpoint
DROP TABLE "kitchen_stations" CASCADE;--> statement-breakpoint
DROP TABLE "kitchen_tickets" CASCADE;--> statement-breakpoint
DROP TABLE "menu_item_modifier_groups" CASCADE;--> statement-breakpoint
DROP TABLE "menu_items" CASCADE;--> statement-breakpoint
DROP TABLE "menu_sections" CASCADE;--> statement-breakpoint
DROP TABLE "menu_versions" CASCADE;--> statement-breakpoint
DROP TABLE "menus" CASCADE;--> statement-breakpoint
DROP TABLE "modifier_groups" CASCADE;--> statement-breakpoint
DROP TABLE "modifier_options" CASCADE;--> statement-breakpoint
DROP TABLE "order_bill_beneficiaries" CASCADE;--> statement-breakpoint
DROP TABLE "order_bill_charges" CASCADE;--> statement-breakpoint
DROP TABLE "order_bill_lines" CASCADE;--> statement-breakpoint
DROP TABLE "order_bills" CASCADE;--> statement-breakpoint
DROP TABLE "order_course_notes" CASCADE;--> statement-breakpoint
DROP TABLE "order_item_moves" CASCADE;--> statement-breakpoint
DROP TABLE "order_items" CASCADE;--> statement-breakpoint
DROP TABLE "restaurant_orders" CASCADE;--> statement-breakpoint
DROP TABLE "restaurant_settings" CASCADE;--> statement-breakpoint
DROP TABLE "restaurant_tables" CASCADE;--> statement-breakpoint
DROP TABLE "sold_out_items" CASCADE;--> statement-breakpoint
DROP TABLE "folio_entries" CASCADE;--> statement-breakpoint
DROP TABLE "folio_payments" CASCADE;--> statement-breakpoint
DROP TABLE "folios" CASCADE;--> statement-breakpoint
DROP TABLE "lodging_settings" CASCADE;--> statement-breakpoint
DROP TABLE "room_blocks" CASCADE;--> statement-breakpoint
DROP TABLE "room_status_changes" CASCADE;--> statement-breakpoint
DROP TABLE "room_types" CASCADE;--> statement-breakpoint
DROP TABLE "rooms" CASCADE;--> statement-breakpoint
DROP TABLE "stay_beneficiaries" CASCADE;--> statement-breakpoint
DROP TABLE "stay_deposits" CASCADE;--> statement-breakpoint
DROP TABLE "stay_guests" CASCADE;--> statement-breakpoint
DROP TABLE "stays" CASCADE;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_lodging_link";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT "customer_credit_entries_kind_check";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT "customer_credit_entries_link_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumer_check";--> statement-breakpoint
ALTER TABLE "sale_returns" DROP CONSTRAINT "sale_returns_refund_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_room_charge_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_intent_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_tenant_id_folio_payment_id_folio_payments_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_tenant_id_stay_deposit_id_stay_deposits_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT IF EXISTS "customer_credit_entries_tenant_id_folio_payment_id_folio_payments_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_tenant_id_folio_id_folios_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_charges" DROP CONSTRAINT IF EXISTS "sale_charges_tenant_id_order_bill_charge_id_order_bill_charges_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT IF EXISTS "sale_tenders_tenant_id_stay_id_stays_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "sales_tenant_id_order_bill_id_order_bills_tenant_id_id_fk";
--> statement-breakpoint
DROP INDEX "customer_credit_entries_folio_once";--> statement-breakpoint
DROP INDEX "sales_bill_idx";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP COLUMN "folio_payment_id";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP COLUMN "stay_deposit_id";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP COLUMN "folio_payment_id";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP COLUMN "folio_id";--> statement-breakpoint
ALTER TABLE "sale_charges" DROP COLUMN "order_bill_charge_id";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP COLUMN "stay_id";--> statement-breakpoint
ALTER TABLE "sales" DROP COLUMN "order_bill_id";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','HYBRID','GROCERY','SALON','PHARMACY'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','TIP','TIP_REFUND','TIP_PAYOUT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND','TIP_REFUND','TIP_PAYOUT') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN','TIP') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_kind_check" CHECK ("customer_credit_entries"."kind" IN ('RETURN','REDEEM')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_link_check" CHECK (("customer_credit_entries"."kind" = 'RETURN' AND "customer_credit_entries"."amount" > 0 AND "customer_credit_entries"."sale_return_id" IS NOT NULL AND "customer_credit_entries"."sale_id" IS NULL)
       OR ("customer_credit_entries"."kind" = 'REDEEM' AND "customer_credit_entries"."amount" < 0 AND "customer_credit_entries"."sale_id" IS NOT NULL AND "customer_credit_entries"."sale_return_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumer_check" CHECK (("payment_intents"."sale_id" IS NULL OR "payment_intents"."purpose" IN ('SALE','TIP')));--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_refund_method_check" CHECK ("sale_returns"."refund_method" IN ('CASH','STORE_CREDIT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" IN ('CASH','STORE_CREDIT')) = ("sale_tenders"."payment_intent_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','SALE_TIP_REFUND','MANUAL','REVERSAL')) NOT VALID;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") > 0 AND "api_keys"."scopes" <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read','appointments.read']::text[]) NOT VALID;--> statement-breakpoint

DROP FUNCTION app_folio_entry();--> statement-breakpoint
DROP FUNCTION app_folio_status();--> statement-breakpoint
DROP FUNCTION app_menu_draft_only();--> statement-breakpoint
DROP FUNCTION app_menu_version_transition();--> statement-breakpoint
DROP FUNCTION app_notify_floor();--> statement-breakpoint
DROP FUNCTION app_order_bill_allocation_guard();--> statement-breakpoint
DROP FUNCTION app_order_bill_transition();--> statement-breakpoint
DROP FUNCTION app_order_course_note_open();--> statement-breakpoint
DROP FUNCTION app_order_item_delete();--> statement-breakpoint
DROP FUNCTION app_order_item_insert();--> statement-breakpoint
DROP FUNCTION app_order_item_update();--> statement-breakpoint
DROP FUNCTION app_record_order_item_move();--> statement-breakpoint
DROP FUNCTION app_restaurant_order_transition();--> statement-breakpoint
DROP FUNCTION app_room_hold_check();--> statement-breakpoint
DROP FUNCTION app_stay_deposit();--> statement-breakpoint
DROP FUNCTION app_stay_status();--> statement-breakpoint
DROP FUNCTION platform_lodging_due_tenants();--> statement-breakpoint

-- 0110's versions without folios. Card/QR payments taken for a folio or a deposit (FOLIO) or a laundry
-- down payment (JOB_ORDER) before 0110/0111 were consumed by documents that are gone: they do not hold
-- their shift open and do not change.
CREATE OR REPLACE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.purpose IN ('SALE', 'TIP')))) THEN
    RAISE EXCEPTION 'card/QR payments on this shift are not settled' USING ERRCODE = '23514', CONSTRAINT = 'payments_outstanding';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- A card/QR payment consumed by a sale is final (0094); so is one of a purpose no longer offered.
CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.purpose NOT IN ('SALE', 'TIP') AND (NEW.status <> OLD.status OR NEW.sale_id IS NOT NULL) THEN
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
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint

-- 0107's store-credit check without folios (FOLIO_PAYMENT entries are no longer written; old ones stay).
CREATE OR REPLACE FUNCTION app_customer_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.customer_id::text || ':' || NEW.legal_entity_id::text, 0));
  IF NEW.kind = 'RETURN' THEN
    IF NOT EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method = 'STORE_CREDIT'
         AND r.amount_due = NEW.amount
         AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) AND NOT EXISTS (
      SELECT 1 FROM sale_returns r JOIN sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method <> 'STORE_CREDIT'
         AND NEW.amount > 0 AND s.customer_id = NEW.customer_id
         AND NEW.amount <= r.amount_due
         AND NEW.amount + coalesce((SELECT sum(c.amount) FROM customer_credit_entries c JOIN sale_returns o ON o.tenant_id = c.tenant_id AND o.id = c.sale_return_id
                                     WHERE c.tenant_id = NEW.tenant_id AND c.kind = 'RETURN' AND o.sale_id = r.sale_id), 0)
             <= (SELECT coalesce(sum(t.amount), 0) FROM sale_tenders t WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = r.sale_id AND t.method = 'STORE_CREDIT')
         AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its return' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM sales s
       WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id AND s.customer_id = NEW.customer_id
         AND s.legal_entity_id = NEW.legal_entity_id AND s.branch_id = NEW.branch_id
         AND -NEW.amount = (SELECT coalesce(sum(t.amount), 0) FROM sale_tenders t WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = s.id AND t.method = 'STORE_CREDIT')
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its sale' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  END IF;
  SELECT coalesce(sum(amount), 0) + NEW.amount INTO balance
    FROM customer_credit_entries
   WHERE tenant_id = NEW.tenant_id AND customer_id = NEW.customer_id AND legal_entity_id = NEW.legal_entity_id;
  IF balance < 0 THEN
    RAISE EXCEPTION 'store credit cannot go below zero' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_balance';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 0109's platform_metrics() without the lodging gauge (`lodging_stays_nights_overdue`).
CREATE OR REPLACE FUNCTION platform_metrics()
  RETURNS TABLE (metric text, label text, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'outbox_events', s, (SELECT count(*) FROM outbox_events o WHERE o.status = s)::float8
    FROM unnest(ARRAY['PENDING', 'PROCESSING', 'DEAD']) AS s
  UNION ALL
  SELECT 'outbox_oldest_undelivered_age_seconds', '', coalesce(extract(epoch FROM now() - min(o.created_at)), 0)::float8
    FROM outbox_events o WHERE o.status IN ('PENDING', 'PROCESSING')
  UNION ALL
  SELECT 'payment_intents_unresolved', s, (SELECT count(*) FROM payment_intents p WHERE p.status = s)::float8
    FROM unnest(ARRAY['PROCESSING', 'UNKNOWN']) AS s
  UNION ALL
  SELECT 'payment_intents_unresolved_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(p.created_at)), 0)::float8
    FROM payment_intents p WHERE p.status IN ('PROCESSING', 'UNKNOWN')
  UNION ALL
  SELECT 'offline_sales_quarantined', '', count(*)::float8 FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  SELECT 'offline_sales_quarantined_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(x.received_at)), 0)::float8
    FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  -- Same rule as GET /v1/sync/terminals (TILL_SILENCE_MINUTES = 30): a till whose register has an
  -- open shift and that has not been in touch since the later of its last contact and the opening.
  SELECT m, '', v FROM (
    SELECT count(*)::float8 AS open_tills,
           count(*) FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes')::float8 AS silent,
           coalesce(max(extract(epoch FROM now() - greatest(c.opened_at, l.contact)))
                      FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes'), 0)::float8 AS longest
      FROM terminals t
      JOIN cashier_sessions c ON c.tenant_id = t.tenant_id AND c.register_id = t.register_id AND c.status = 'OPEN'
      CROSS JOIN LATERAL (
        SELECT greatest(
          (SELECT max(s.as_of) FROM terminal_snapshots s WHERE s.tenant_id = t.tenant_id AND s.terminal_id = t.id),
          (SELECT max(x.received_at) FROM terminal_transactions x WHERE x.tenant_id = t.tenant_id AND x.terminal_id = t.id)) AS contact
      ) l
     WHERE t.revoked_at IS NULL
  ) tills
  CROSS JOIN LATERAL (VALUES ('tills_with_open_shift', tills.open_tills), ('tills_silent', tills.silent),
                             ('tills_longest_silence_seconds', tills.longest)) AS g(m, v)
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval', '', count(*)::float8 FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(c.closed_at)), 0)::float8
    FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'workers_alive', '', count(*) FILTER (WHERE w.beat_at > now() - interval '60 seconds')::float8 FROM worker_heartbeats w
  UNION ALL
  -- No worker has ever beaten (or every one stopped): +Inf, so "older than N" alerts fire.
  SELECT 'worker_heartbeat_age_seconds', '', coalesce(extract(epoch FROM now() - max(w.beat_at))::float8, 'Infinity'::float8)
    FROM worker_heartbeats w
  UNION ALL
  -- Unix time of the last success; 0 when there was none, so "older than N" alerts fire.
  SELECT 'backup_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'BACKUP'
  UNION ALL
  SELECT 'restore_drill_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'RESTORE_DRILL'
$$;
