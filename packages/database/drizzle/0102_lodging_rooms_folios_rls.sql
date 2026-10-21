-- Hand-written (session 28, ADR-0023): hotels, resorts and transient houses. DDL is in 0101.
-- * room types, rooms, room blocks, lodging settings, stays, the guest registry and SC/PWD guests:
--   tenant RLS, operational data (changed in place, audited by the API). Never deleted, except blocks,
--   registry rows (corrections, anonymisation) and beneficiaries before a night used them.
-- * stays: a state machine (BOOKED → IN_HOUSE → CHECKED_OUT, or CANCELLED / NO_SHOW); no
--   double-booking of a room (GiST exclusion on active stays, a trigger for stays against blocks).
-- * folios, folio_entries, folio_payments, stay_deposits, room_status_changes: append-only evidence
--   (a folio only moves OPEN → SETTLED); entries of one folio are serialised and checked against
--   their documents; no folio or deposit balance below zero.
-- * Cash taken at the front desk goes through cash_movements (FOLIO_PAYMENT, DEPOSIT, DEPOSIT_REFUND);
--   a card/QR payment of purpose FOLIO is consumed by its folio (`payment_intents.folio_id`).
-- * Permissions lodging.*; the Housekeeping role (and the front desk's lodging codes) for HYBRID
--   businesses; system accounts 1150, 2120, 2320, 4100, 4110 in every chart;
--   platform_lodging_due_tenants() for the API's night audit.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['room_types', 'rooms', 'room_blocks', 'room_status_changes', 'lodging_settings', 'stays',
                           'stay_guests', 'stay_beneficiaries', 'folios', 'folio_entries', 'folio_payments', 'stay_deposits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly, onepos_worker', t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (name, base_occupancy, max_occupancy, night_variant_id, archived_at, updated_at) ON room_types TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (room_type_id, number, floor, notes, housekeeping_status, archived_at, updated_at) ON rooms TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON room_blocks TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON room_status_changes, folio_entries, folio_payments, stay_deposits TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (night_audit_time, accommodation_tax_rate, forfeit_on_cancel, updated_by, updated_at) ON lodging_settings TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (room_id, room_type_id, customer_id, guest_name, arrival_date, departure_date, adults, children, status, nightly_rate,
  allow_charges, charge_limit, source, external_reference, notes, updated_by, updated_at, checked_in_at, checked_in_by, checked_out_at,
  checked_out_by, cancel_reason, cancelled_at, cancelled_by) ON stays TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (is_primary, full_name, nationality, id_type, id_number, address, birth_date, contact, updated_at), DELETE ON stay_guests TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (removed_at), DELETE ON stay_beneficiaries TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, settled_by, settled_at) ON folios TO onepos_app;--> statement-breakpoint
GRANT UPDATE (folio_id) ON payment_intents TO onepos_app;--> statement-breakpoint

-- Never deleted: stays, folios and the rooms they name; append-only evidence.
CREATE TRIGGER room_types_no_delete BEFORE DELETE ON room_types FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER rooms_no_delete BEFORE DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER stays_no_delete BEFORE DELETE ON stays FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER folios_no_delete BEFORE DELETE ON folios FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER room_status_changes_append_only BEFORE UPDATE OR DELETE ON room_status_changes FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER folio_entries_append_only BEFORE UPDATE OR DELETE ON folio_entries FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER folio_payments_append_only BEFORE UPDATE OR DELETE ON folio_payments FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER stay_deposits_append_only BEFORE UPDATE OR DELETE ON stay_deposits FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- A folio only moves OPEN → SETTLED (§5).
CREATE FUNCTION app_folio_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SETTLED' THEN
    RAISE EXCEPTION 'a settled folio does not change' USING ERRCODE = '23514', CONSTRAINT = 'folios_settled_final';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER folios_status BEFORE UPDATE ON folios FOR EACH ROW EXECUTE FUNCTION app_folio_status();--> statement-breakpoint

-- Stay statuses (§3): BOOKED → IN_HOUSE → CHECKED_OUT, or BOOKED → CANCELLED / NO_SHOW. A stay that
-- ended does not change; an in-house stay keeps its arrival date (its nights are charged from it).
CREATE FUNCTION app_stay_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CHECKED_OUT', 'CANCELLED', 'NO_SHOW') THEN
    RAISE EXCEPTION 'this stay has ended and does not change' USING ERRCODE = '23514', CONSTRAINT = 'stays_status_final';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'BOOKED' AND NEW.status IN ('IN_HOUSE', 'CANCELLED', 'NO_SHOW'))
    OR (OLD.status = 'IN_HOUSE' AND NEW.status = 'CHECKED_OUT')) THEN
    RAISE EXCEPTION 'a stay cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'stays_status_move';
  END IF;
  IF OLD.status = 'IN_HOUSE' AND NEW.arrival_date <> OLD.arrival_date THEN
    RAISE EXCEPTION 'an in-house stay keeps its arrival date' USING ERRCODE = '23514', CONSTRAINT = 'stays_arrival_fixed';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stays_status BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION app_stay_status();--> statement-breakpoint

-- No double-booking (§3, §9): a room's active stays never overlap each other (exclusion), nor its
-- blocks (the trigger below, under a per-room lock); blocks never overlap each other.
ALTER TABLE stays ADD CONSTRAINT stays_no_double_booking
  EXCLUDE USING gist (tenant_id WITH =, room_id WITH =, daterange(arrival_date, departure_date) WITH &&) WHERE (status IN ('BOOKED', 'IN_HOUSE'));--> statement-breakpoint
ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, room_id WITH =, daterange(starts_on, ends_on) WITH &&);--> statement-breakpoint
CREATE FUNCTION app_room_hold_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('room:' || NEW.room_id::text, 0));
  IF TG_TABLE_NAME = 'stays' THEN
    IF NEW.status IN ('BOOKED', 'IN_HOUSE') AND EXISTS (
         SELECT 1 FROM room_blocks b
          WHERE b.tenant_id = NEW.tenant_id AND b.room_id = NEW.room_id
            AND daterange(b.starts_on, b.ends_on) && daterange(NEW.arrival_date, NEW.departure_date)) THEN
      RAISE EXCEPTION 'the room is out of order on these dates' USING ERRCODE = '23P01', CONSTRAINT = 'stays_room_blocked';
    END IF;
  ELSE
    IF EXISTS (
         SELECT 1 FROM stays s
          WHERE s.tenant_id = NEW.tenant_id AND s.room_id = NEW.room_id AND s.status IN ('BOOKED', 'IN_HOUSE')
            AND daterange(s.arrival_date, s.departure_date) && daterange(NEW.starts_on, NEW.ends_on)) THEN
      RAISE EXCEPTION 'the room is booked on these dates' USING ERRCODE = '23P01', CONSTRAINT = 'room_blocks_stay_overlap';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stays_room_hold BEFORE INSERT OR UPDATE OF room_id, arrival_date, departure_date, status ON stays
  FOR EACH ROW EXECUTE FUNCTION app_room_hold_check();--> statement-breakpoint
CREATE TRIGGER room_blocks_room_hold BEFORE INSERT ON room_blocks
  FOR EACH ROW EXECUTE FUNCTION app_room_hold_check();--> statement-breakpoint

-- Deposits (§6): one stay's rows are serialised (the API takes the same lock first); never below zero.
CREATE FUNCTION app_stay_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('deposit:' || NEW.stay_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM folios f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.folio_id AND f.stay_id = NEW.stay_id
                    AND f.legal_entity_id = NEW.legal_entity_id AND f.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'the deposit is not of this stay''s folio' USING ERRCODE = '23514', CONSTRAINT = 'stay_deposits_match';
  END IF;
  SELECT coalesce(sum(d.amount), 0) + NEW.amount INTO held FROM stay_deposits d WHERE d.tenant_id = NEW.tenant_id AND d.stay_id = NEW.stay_id;
  IF held < 0 THEN
    RAISE EXCEPTION 'more than the deposit held' USING ERRCODE = '23514', CONSTRAINT = 'stay_deposits_balance';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stay_deposits_check BEFORE INSERT ON stay_deposits FOR EACH ROW EXECUTE FUNCTION app_stay_deposit();--> statement-breakpoint

-- Folio entries (§5): one folio's entries are serialised (the API takes the same lock first); a settled
-- folio takes none; each matches the document it comes from; the balance never goes below zero.
CREATE FUNCTION app_folio_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f record;
  s record;
  total numeric;
  charged numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('folio:' || NEW.folio_id::text, 0));
  SELECT * INTO f FROM folios WHERE tenant_id = NEW.tenant_id AND id = NEW.folio_id;
  IF f.status <> 'OPEN' THEN
    RAISE EXCEPTION 'this folio is settled and takes no more entries' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_folio_open';
  END IF;
  IF f.stay_id <> NEW.stay_id THEN
    RAISE EXCEPTION 'the entry is not of this folio''s stay' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
  END IF;
  IF NEW.kind = 'CHARGE' THEN
    SELECT * INTO s FROM stays WHERE tenant_id = NEW.tenant_id AND id = NEW.stay_id;
    IF s.status <> 'IN_HOUSE' THEN
      RAISE EXCEPTION 'the guest is not in house' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_in_house';
    END IF;
    IF NOT s.allow_charges THEN
      RAISE EXCEPTION 'this stay takes no room charges' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_charges_allowed';
    END IF;
    IF s.charge_limit IS NOT NULL THEN
      SELECT coalesce(sum(e.amount), 0) + NEW.amount INTO charged FROM folio_entries e
       WHERE e.tenant_id = NEW.tenant_id AND e.folio_id = NEW.folio_id AND e.kind IN ('CHARGE', 'CHARGE_RETURN');
      IF charged > s.charge_limit THEN
        RAISE EXCEPTION 'beyond the stay''s charge limit' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_charge_limit';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sale_tenders t JOIN sales x ON x.tenant_id = t.tenant_id AND x.id = t.sale_id
                    WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = NEW.sale_id AND t.method = 'ROOM_CHARGE' AND t.stay_id = NEW.stay_id
                      AND t.amount = NEW.amount AND x.legal_entity_id = f.legal_entity_id) THEN
      RAISE EXCEPTION 'the charge does not match its sale' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  ELSIF NEW.kind = 'CHARGE_RETURN' THEN
    IF NOT EXISTS (SELECT 1 FROM sale_returns r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.sale_id = NEW.sale_id)
       OR -NEW.amount + coalesce((SELECT -sum(e.amount) FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.sale_id = NEW.sale_id AND e.kind = 'CHARGE_RETURN'), 0)
          > coalesce((SELECT e.amount FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.folio_id = NEW.folio_id AND e.sale_id = NEW.sale_id AND e.kind = 'CHARGE'), 0) THEN
      RAISE EXCEPTION 'the return does not match the charge' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  ELSIF NEW.kind = 'NIGHT_REVERSAL' THEN
    IF NOT EXISTS (SELECT 1 FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.related_entry_id AND e.folio_id = NEW.folio_id
                      AND e.kind IN ('ROOM_NIGHT', 'ACCOMMODATION_TAX') AND e.amount = -NEW.amount) THEN
      RAISE EXCEPTION 'the reversal does not match its night' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  ELSIF NEW.kind = 'ACCOMMODATION_TAX' THEN
    IF NOT EXISTS (SELECT 1 FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.related_entry_id AND e.folio_id = NEW.folio_id
                      AND e.kind = 'ROOM_NIGHT' AND e.night_date = NEW.night_date) THEN
      RAISE EXCEPTION 'the tax does not match its night' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  ELSIF NEW.kind = 'DEPOSIT_APPLIED' THEN
    IF NOT EXISTS (SELECT 1 FROM stay_deposits d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.stay_deposit_id AND d.stay_id = NEW.stay_id
                      AND d.kind = 'APPLIED' AND d.amount = NEW.amount) THEN
      RAISE EXCEPTION 'the entry does not match its deposit' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  ELSIF NEW.kind = 'PAYMENT' THEN
    IF NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.folio_payment_id AND p.folio_id = NEW.folio_id
                      AND p.amount = -NEW.amount) THEN
      RAISE EXCEPTION 'the entry does not match its payment' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_match';
    END IF;
  END IF;
  SELECT coalesce(sum(e.amount), 0) + NEW.amount INTO total FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.folio_id = NEW.folio_id;
  IF total < 0 THEN
    RAISE EXCEPTION 'the folio would owe the guest money' USING ERRCODE = '23514', CONSTRAINT = 'folio_entries_overpaid';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER folio_entries_check BEFORE INSERT ON folio_entries FOR EACH ROW EXECUTE FUNCTION app_folio_entry();--> statement-breakpoint

-- Store credit spent on a folio (§5.2) matches its payment; the other kinds as before (0075).
CREATE OR REPLACE FUNCTION app_customer_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.customer_id::text || ':' || NEW.legal_entity_id::text, 0));
  IF NEW.kind = 'RETURN' THEN
    -- What a return put back onto a guest's folio (ADR-0023) is not store credit.
    IF NOT EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method = 'STORE_CREDIT'
         AND r.amount_due + coalesce((SELECT sum(e.amount) FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.sale_return_id = r.id AND e.kind = 'CHARGE_RETURN'), 0) = NEW.amount
         AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its return' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  ELSIF NEW.kind = 'FOLIO_PAYMENT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM folio_payments p JOIN folios f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id
        JOIN stays s ON s.tenant_id = f.tenant_id AND s.id = f.stay_id
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.folio_payment_id AND p.method = 'STORE_CREDIT' AND p.amount = -NEW.amount
         AND s.customer_id = NEW.customer_id AND p.legal_entity_id = NEW.legal_entity_id AND p.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its folio payment' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
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

-- A shift does not close while a card/QR payment of it belongs to no sale and no folio (0048, ADR-0010 §6).
CREATE OR REPLACE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL AND p.folio_id IS NULL))) THEN
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
  IF OLD.folio_id IS NOT NULL AND (NEW.folio_id IS DISTINCT FROM OLD.folio_id OR NEW.status <> OLD.status OR NEW.sale_id IS NOT NULL) THEN
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
END $$;--> statement-breakpoint

-- Permissions (§11): in the catalog, and in the built-in roles of every business.
INSERT INTO permissions (code, description) VALUES
  ('lodging.read', 'See rooms, stays, folios and the housekeeping board'),
  ('lodging.manage', 'Book, change, check in and out, settle folios, take deposits'),
  ('lodging.rates', 'Agree room rates, adjust folios, take bank transfers, refund deposits'),
  ('lodging.housekeeping', 'Change a room''s housekeeping status'),
  ('lodging.setup', 'Set up room types, rooms and lodging settings');--> statement-breakpoint
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r JOIN tenants t ON t.id = r.tenant_id
  CROSS JOIN (VALUES ('lodging.read'), ('lodging.manage'), ('lodging.rates'), ('lodging.housekeeping'), ('lodging.setup')) AS p(code)
 WHERE r.is_system AND (
       r.key IN ('owner', 'admin', 'branch_manager', 'restaurant_manager')
    OR (r.key IN ('cashier', 'senior_cashier', 'accountant') AND p.code = 'lodging.read')
    OR (r.key = 'front_desk' AND t.business_type IN ('LODGING', 'HYBRID') AND p.code IN ('lodging.read', 'lodging.manage', 'lodging.housekeeping')))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The lodging role for businesses that already have rooms (HYBRID); others get it when they change
-- type (BusinessService). A unit test checks this array against ROLE_TEMPLATES.
WITH templates(key, name, permissions) AS (
  VALUES
    ('housekeeping', 'Housekeeping', ARRAY['lodging.read', 'lodging.housekeeping'])
),
added AS (
  INSERT INTO roles (tenant_id, key, name, is_system)
  SELECT t.id, tp.key, tp.name, true FROM tenants t CROSS JOIN templates tp
   WHERE t.business_type IN ('LODGING', 'HYBRID')
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
   ('GUEST_LEDGER', '1150', 'Guest ledger', 'ASSET'),
   ('ACCOMMODATION_TAX_PAYABLE', '2120', 'Accommodation tax payable', 'LIABILITY'),
   ('GUEST_DEPOSITS', '2320', 'Guest deposits', 'LIABILITY'),
   ('ROOM_REVENUE', '4100', 'Room revenue', 'REVENUE'),
   ('CANCELLATION_INCOME', '4110', 'Cancellation fees', 'REVENUE')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = c.key);--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The night audit (§7): the API's scheduler asks which businesses have a night due, then posts each
-- inside its own tenant. Night D of an in-house stay is due once the branch's clock has passed D + 1 at
-- the branch's audit time and no ROOM_NIGHT exists for it. Ids only; no tenant data leaves.
GRANT SELECT ON stays, lodging_settings, folio_entries TO onepos_platform;--> statement-breakpoint
CREATE FUNCTION platform_lodging_due_tenants() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT s.tenant_id
    FROM stays s
    JOIN branches b ON b.tenant_id = s.tenant_id AND b.id = s.branch_id
    LEFT JOIN lodging_settings ls ON ls.tenant_id = s.tenant_id AND ls.branch_id = s.branch_id
   WHERE s.status = 'IN_HOUSE'
     AND EXISTS (
       SELECT 1 FROM generate_series(
                s.arrival_date::timestamp,
                least(s.departure_date - 1, ((now() AT TIME ZONE b.timezone) - coalesce(ls.night_audit_time, time '03:00'))::date - 1)::timestamp,
                interval '1 day') AS d(night)
        WHERE NOT EXISTS (SELECT 1 FROM folio_entries e
                           WHERE e.tenant_id = s.tenant_id AND e.stay_id = s.id AND e.kind = 'ROOM_NIGHT' AND e.night_date = d.night::date))
$$;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION platform_lodging_due_tenants() OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_lodging_due_tenants() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_lodging_due_tenants() TO onepos_app;
