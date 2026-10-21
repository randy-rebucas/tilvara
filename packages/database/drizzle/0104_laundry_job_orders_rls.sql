-- Hand-written (session 29, ADR-0024): laundromats and laundry shops. DDL is in 0103.
-- * laundry settings, garment types, machines, job orders, their lines, items and trips: tenant RLS,
--   operational data (changed in place, audited by the API). Never deleted, except lines and items
--   (replaced as a set while a job is open).
-- * job orders: a state machine (RECEIVED → WASHING → DRYING → FOLDING → READY → (OUT_FOR_DELIVERY →)
--   CLAIMED, or CANCELLED / DISPOSED); steps may be skipped, READY → FOLDING is the one way back.
-- * job_order_status_changes, job_order_deposits: append-only evidence; deposits of one job are
--   serialised, never below zero and never more than the job's frozen total.
-- * job_order_notices: queued once per (job, kind, step), settled once by the worker (definer function).
-- * machine_runs: one machine's runs never overlap (GiST exclusion); only `stopped_at` changes, once.
-- * Cash down payments go through cash_movements (JOB_DEPOSIT, JOB_DEPOSIT_REFUND); a card/QR payment of
--   purpose JOB_ORDER is consumed by its down payment (`payment_intents.job_order_id`).
-- * Permissions laundry.*; the Laundry Attendant and Rider roles for HYBRID businesses; system accounts
--   2330 and 4120 in every chart; platform_flag_laundry_notices() and laundry_notice_settle() for the worker.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['laundry_settings', 'laundry_garment_types', 'laundry_machines', 'machine_runs', 'job_orders', 'job_order_lines',
                           'job_order_items', 'job_order_status_changes', 'job_order_deposits', 'job_order_notices', 'job_order_trips'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly, onepos_worker', t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (regular_hours, express_hours, express_variant_id, delivery_variant_id, storage_fee_variant_id, storage_free_days,
  unclaimed_days, final_notice_days, reminder_days, claim_policy_text, sms_enabled, updated_by, updated_at) ON laundry_settings TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (name, archived_at) ON laundry_garment_types TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (label, capacity_kg, cycle_minutes, out_of_order_reason, archived_at, updated_at) ON laundry_machines TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (stopped_at, stopped_by) ON machine_runs TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (customer_id, customer_name, customer_phone, service_level, promised_at, status, weight_kg, bag_count, special_instructions,
  condition_notes, pickup_requested, delivery_requested, notify, currency, tax_profile_id, tax_snapshot, requires_professional_review, priced_at,
  amount_due, sale_id, ready_at, claimed_at, claimed_by, cancelled_at, cancel_reason, disposed_at, disposed_reason, disposed_note, updated_by,
  updated_at) ON job_orders TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON job_order_lines, job_order_items TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON job_order_status_changes, job_order_deposits, job_order_notices TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (address, contact_phone, contact_name, window_start, window_end, rider_member_id, rider_name, status, fail_reason, notes,
  done_at, done_by, updated_at) ON job_order_trips TO onepos_app;--> statement-breakpoint
GRANT UPDATE (job_order_id) ON payment_intents TO onepos_app;--> statement-breakpoint
GRANT UPDATE (laundry_unit, laundry_min_quantity, laundry_kg_per_load, laundry_addon, machine_kind, machine_minutes) ON product_variants TO onepos_app;--> statement-breakpoint

-- Never deleted: what sales, runs and tickets name; append-only evidence.
CREATE TRIGGER laundry_garment_types_no_delete BEFORE DELETE ON laundry_garment_types FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER laundry_machines_no_delete BEFORE DELETE ON laundry_machines FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER job_orders_no_delete BEFORE DELETE ON job_orders FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER job_order_trips_no_delete BEFORE DELETE ON job_order_trips FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER machine_runs_no_delete BEFORE DELETE ON machine_runs FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER job_order_status_changes_append_only BEFORE UPDATE OR DELETE ON job_order_status_changes FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER job_order_deposits_append_only BEFORE UPDATE OR DELETE ON job_order_deposits FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER job_order_notices_no_delete BEFORE DELETE ON job_order_notices FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- Job order statuses (§3). A job that ended does not move; the claim, cancel and disposal are final.
CREATE FUNCTION app_job_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  steps constant text[] := ARRAY['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY'];
BEGIN
  IF OLD.status IN ('CLAIMED', 'CANCELLED', 'DISPOSED') THEN
    -- Anonymising a customer may still blank a finished job's walk-in name and phone, nothing else.
    IF (to_jsonb(NEW) - ARRAY['customer_name', 'customer_phone', 'updated_by', 'updated_at']) = (to_jsonb(OLD) - ARRAY['customer_name', 'customer_phone', 'updated_by', 'updated_at'])
       AND NEW.customer_phone IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this job order has ended and does not change' USING ERRCODE = '23514', CONSTRAINT = 'job_orders_status_final';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (array_position(steps, NEW.status) IS NOT NULL AND array_position(steps, OLD.status) IS NOT NULL
         AND (array_position(steps, NEW.status) > array_position(steps, OLD.status) OR (OLD.status = 'READY' AND NEW.status = 'FOLDING')))
    OR (OLD.status = 'READY' AND NEW.status IN ('OUT_FOR_DELIVERY', 'CLAIMED', 'DISPOSED'))
    OR (OLD.status = 'OUT_FOR_DELIVERY' AND NEW.status IN ('READY', 'CLAIMED'))
    OR NEW.status = 'CANCELLED'
    -- A job paid and handed over before it was marked ready (a same-day counter release).
    OR (array_position(steps, OLD.status) IS NOT NULL AND NEW.status = 'CLAIMED')) THEN
    RAISE EXCEPTION 'a job order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'job_orders_status_move';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER job_orders_status BEFORE UPDATE ON job_orders FOR EACH ROW EXECUTE FUNCTION app_job_order_status();--> statement-breakpoint

-- Lines and items change only while the job is open (not claimed, cancelled or disposed).
CREATE FUNCTION app_job_order_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.job_order_id ELSE NEW.job_order_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM job_orders j WHERE j.id = job_id AND j.status IN ('CLAIMED', 'CANCELLED', 'DISPOSED')) THEN
    RAISE EXCEPTION 'this job order has ended and does not change' USING ERRCODE = '23514', CONSTRAINT = 'job_orders_status_final';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;--> statement-breakpoint
CREATE TRIGGER job_order_lines_open BEFORE INSERT OR DELETE ON job_order_lines FOR EACH ROW EXECUTE FUNCTION app_job_order_open();--> statement-breakpoint
CREATE TRIGGER job_order_items_open BEFORE INSERT OR DELETE ON job_order_items FOR EACH ROW EXECUTE FUNCTION app_job_order_open();--> statement-breakpoint

-- Machines (§7): one machine's runs never overlap; a run only gets stopped, once.
ALTER TABLE machine_runs ADD CONSTRAINT machine_runs_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, machine_id WITH =, tstzrange(started_at, coalesce(stopped_at, ends_at)) WITH &&);--> statement-breakpoint
CREATE FUNCTION app_machine_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stopped_at IS NOT NULL OR NEW.stopped_at IS NULL OR NEW.stopped_by IS NULL THEN
    RAISE EXCEPTION 'a machine run is stopped once' USING ERRCODE = '23514', CONSTRAINT = 'machine_runs_stop_once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER machine_runs_update BEFORE UPDATE ON machine_runs FOR EACH ROW EXECUTE FUNCTION app_machine_run_update();--> statement-breakpoint

-- Down payments (§5): one job's rows are serialised (the API takes the same lock first); never below
-- zero, never more than the job's frozen total; of the job's branch and entity; APPLIED only with the
-- claim sale's JOB_DEPOSIT tender of the same amount.
CREATE FUNCTION app_job_order_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j record;
  held numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('job-deposit:' || NEW.job_order_id::text, 0));
  SELECT * INTO j FROM job_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.job_order_id;
  IF j.legal_entity_id <> NEW.legal_entity_id OR j.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'the down payment is not of this job''s branch' USING ERRCODE = '23514', CONSTRAINT = 'job_order_deposits_match';
  END IF;
  SELECT coalesce(sum(d.amount), 0) + NEW.amount INTO held FROM job_order_deposits d WHERE d.tenant_id = NEW.tenant_id AND d.job_order_id = NEW.job_order_id;
  IF held < 0 THEN
    RAISE EXCEPTION 'more than the down payment held' USING ERRCODE = '23514', CONSTRAINT = 'job_order_deposits_balance';
  END IF;
  IF NEW.kind = 'RECEIVED' AND held > j.amount_due THEN
    RAISE EXCEPTION 'more than the job order''s total' USING ERRCODE = '23514', CONSTRAINT = 'job_order_deposits_exceed_total';
  END IF;
  IF NEW.kind = 'APPLIED' AND NOT EXISTS (
       SELECT 1 FROM sale_tenders t JOIN sales s ON s.tenant_id = t.tenant_id AND s.id = t.sale_id
        WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = NEW.sale_id AND t.method = 'JOB_DEPOSIT' AND t.job_order_id = NEW.job_order_id
          AND t.amount = -NEW.amount AND s.job_order_id = NEW.job_order_id) THEN
    RAISE EXCEPTION 'the down payment applied does not match its claim' USING ERRCODE = '23514', CONSTRAINT = 'job_order_deposits_match';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER job_order_deposits_check BEFORE INSERT ON job_order_deposits FOR EACH ROW EXECUTE FUNCTION app_job_order_deposit();--> statement-breakpoint

-- Notices (§6): settled once by the worker; nothing else changes.
CREATE FUNCTION app_job_order_notice_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'QUEUED' OR NEW.status = 'QUEUED' OR NEW.job_order_id <> OLD.job_order_id OR NEW.kind <> OLD.kind OR NEW.step <> OLD.step THEN
    RAISE EXCEPTION 'a notice is settled once' USING ERRCODE = '23514', CONSTRAINT = 'job_order_notices_settle_once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER job_order_notices_update BEFORE UPDATE ON job_order_notices FOR EACH ROW EXECUTE FUNCTION app_job_order_notice_update();--> statement-breakpoint

-- A shift does not close while a card/QR payment of it belongs to no sale, folio or job (0048, 0102).
CREATE OR REPLACE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.folio_id IS NULL AND p.job_order_id IS NULL))) THEN
    RAISE EXCEPTION 'card/QR payments on this shift are not settled' USING ERRCODE = '23514', CONSTRAINT = 'payments_outstanding';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- A card/QR payment consumed by a folio, a deposit or a job's down payment is final (0094, 0102).
CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF (OLD.folio_id IS NOT NULL OR OLD.job_order_id IS NOT NULL)
     AND (NEW.folio_id IS DISTINCT FROM OLD.folio_id OR NEW.job_order_id IS DISTINCT FROM OLD.job_order_id OR NEW.status <> OLD.status OR NEW.sale_id IS NOT NULL) THEN
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
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL AND NEW.folio_id IS NULL AND NEW.job_order_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint

-- Permissions (§12): in the catalog, and in the built-in roles of every business.
INSERT INTO permissions (code, description) VALUES
  ('laundry.read', 'See job orders, machines and trips'),
  ('laundry.manage', 'Take in, move along and cancel job orders, take down payments, run machines'),
  ('laundry.release_override', 'Release a job order without its claim stub'),
  ('laundry.deliver', 'See and complete pickups and deliveries'),
  ('laundry.dispose', 'Dispose of unclaimed laundry and keep its down payment'),
  ('laundry.setup', 'Set up machines, garment types and laundry settings');--> statement-breakpoint
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r
  CROSS JOIN (VALUES ('laundry.read'), ('laundry.manage'), ('laundry.release_override'), ('laundry.deliver'), ('laundry.dispose'), ('laundry.setup')) AS p(code)
 WHERE r.is_system AND (
       r.key IN ('owner', 'admin', 'branch_manager', 'restaurant_manager')
    OR (r.key IN ('cashier', 'senior_cashier') AND p.code IN ('laundry.read', 'laundry.manage'))
    OR (r.key = 'accountant' AND p.code = 'laundry.read'))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The laundry roles for businesses that already take job orders (HYBRID); others get them when they
-- change type (BusinessService). A unit test checks this array against ROLE_TEMPLATES.
WITH templates(key, name, permissions) AS (
  VALUES
    ('laundry_attendant', 'Laundry Attendant', ARRAY['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'customers.manage', 'laundry.read', 'laundry.manage']),
    ('rider', 'Rider', ARRAY['laundry.read', 'laundry.deliver', 'sales.create', 'cash.session'])
),
added AS (
  INSERT INTO roles (tenant_id, key, name, is_system)
  SELECT t.id, tp.key, tp.name, true FROM tenants t CROSS JOIN templates tp
   WHERE t.business_type IN ('LAUNDRY', 'HYBRID')
  ON CONFLICT ON CONSTRAINT roles_tenant_key_unique DO NOTHING
  RETURNING id, tenant_id, key
)
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT a.tenant_id, a.id, unnest(tp.permissions) FROM added a JOIN templates tp ON tp.key = a.key;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The new system accounts in every existing chart (the same rows `seedChart` gives a new entity).
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.code = c.code) THEN c.code || '-SYS' ELSE c.code END,
       c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('CUSTOMER_DOWN_PAYMENTS', '2330', 'Customer down payments', 'LIABILITY'),
   ('FORFEITED_DOWN_PAYMENTS', '4120', 'Forfeited down payments', 'REVENUE')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = c.key);--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Reminders (§6): the worker's hourly pass queues a REMINDER for each of the branch's reminder days and
-- one FINAL notice before the unclaimed day, once each, for a READY job that wants notices and has a way
-- to be reached; one job_order.notice event (ids only) per notice.
GRANT SELECT ON job_orders, laundry_settings TO onepos_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, email_status, email_to, sms_status, sms_to, provider_reference, settled_at) ON job_order_notices TO onepos_platform;--> statement-breakpoint
CREATE FUNCTION platform_flag_laundry_notices() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN
    WITH due AS (
      SELECT j.tenant_id, j.id AS job_id, 'REMINDER'::text AS kind, d.day AS step
        FROM job_orders j
        LEFT JOIN laundry_settings s ON s.tenant_id = j.tenant_id AND s.branch_id = j.branch_id
        LEFT JOIN customers c ON c.tenant_id = j.tenant_id AND c.id = j.customer_id
       CROSS JOIN LATERAL unnest(coalesce(s.reminder_days, '{3,7}'::integer[])) AS d(day)
       WHERE j.status = 'READY' AND j.notify AND j.ready_at IS NOT NULL
         AND now() >= j.ready_at + make_interval(days => d.day)
         AND d.day < coalesce(s.unclaimed_days, 30) - coalesce(s.final_notice_days, 3)
         AND (j.customer_phone IS NOT NULL OR (c.anonymised_at IS NULL AND (c.email IS NOT NULL OR c.phone IS NOT NULL)))
      UNION ALL
      SELECT j.tenant_id, j.id, 'FINAL', 0
        FROM job_orders j
        LEFT JOIN laundry_settings s ON s.tenant_id = j.tenant_id AND s.branch_id = j.branch_id
        LEFT JOIN customers c ON c.tenant_id = j.tenant_id AND c.id = j.customer_id
       WHERE j.status = 'READY' AND j.notify AND j.ready_at IS NOT NULL
         AND now() >= j.ready_at + make_interval(days => coalesce(s.unclaimed_days, 30) - coalesce(s.final_notice_days, 3))
         AND (j.customer_phone IS NOT NULL OR (c.anonymised_at IS NULL AND (c.email IS NOT NULL OR c.phone IS NOT NULL)))
    )
    INSERT INTO job_order_notices (tenant_id, job_order_id, kind, step)
    SELECT tenant_id, job_id, kind, step FROM due
    ON CONFLICT ON CONSTRAINT job_order_notices_once DO NOTHING
    RETURNING tenant_id, id, job_order_id
  LOOP
    INSERT INTO outbox_events (tenant_id, topic, payload)
    VALUES (r.tenant_id, 'job_order.notice', jsonb_build_object('noticeId', r.id, 'jobOrderId', r.job_order_id));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;--> statement-breakpoint

-- What the worker did with a notice, once, inside the event's tenant. Recipients arrive masked.
CREATE FUNCTION laundry_notice_settle(p_notice uuid, p_email_status text, p_email_to text, p_sms_status text, p_sms_to text, p_reference text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  done boolean;
BEGIN
  UPDATE job_order_notices
     SET status = CASE WHEN 'SENT' IN (p_email_status, p_sms_status) THEN 'SENT' WHEN 'FAILED' IN (p_email_status, p_sms_status) THEN 'FAILED' ELSE 'SKIPPED' END,
         email_status = p_email_status, email_to = left(p_email_to, 254), sms_status = p_sms_status, sms_to = left(p_sms_to, 20),
         provider_reference = left(p_reference, 128), settled_at = now()
   WHERE id = p_notice AND tenant_id = app_current_tenant_id() AND status = 'QUEUED'
  RETURNING true INTO done;
  RETURN coalesce(done, false);
END $$;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION platform_flag_laundry_notices() OWNER TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION laundry_notice_settle(uuid, text, text, text, text, text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_flag_laundry_notices() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION laundry_notice_settle(uuid, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_flag_laundry_notices() TO onepos_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION laundry_notice_settle(uuid, text, text, text, text, text) TO onepos_worker;
