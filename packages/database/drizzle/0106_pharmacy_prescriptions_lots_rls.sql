-- Hand-written (session 30, ADR-0025): pharmacies and drugstores. DDL is in 0105.
-- * pharmacy settings, pharmacist licences, prescriptions and their items, dispense approvals, lot holds:
--   tenant RLS, operational records changed in place (audited by the API), never deleted (items only while
--   nothing is dispensed on their prescription).
-- * prescription_fills: append-only; Σ per item between 0 and what was prescribed, a dangerous drug in one
--   full fill, per item under a lock; the item's generic key must be the dispensed product's.
-- * dispense approvals are used once; lot holds are released once.
-- * app_track_stock_lots: where expired stock is blocked (ADR-0025 §4) a sale, a recipe's consumption or
--   a pack opened for a sale draws unexpired, unheld lots first; every draw from an expired or held lot is
--   marked (`stock_lot_movements.expired`).
-- * Permissions pharmacy.*; the Pharmacist and Pharmacy Assistant roles for HYBRID businesses.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_settings', 'pharmacist_licenses', 'prescriptions', 'prescription_items', 'prescription_fills', 'dispense_approvals', 'lot_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly, onepos_worker', t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (require_purchase_booklet, updated_by, updated_at) ON pharmacy_settings TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (license_no, valid_until, updated_by, updated_at) ON pharmacist_licenses TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (customer_id, patient_name, patient_address, prescriber_name, prescriber_license_no, prescriber_s2_no, yellow_form_no,
  issued_on, notes, updated_by, updated_at, voided_at, voided_by, void_reason) ON prescriptions TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON prescription_items TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON prescription_fills TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (sale_id) ON dispense_approvals TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (released_by, released_at, release_reason) ON lot_holds TO onepos_app;--> statement-breakpoint
GRANT UPDATE (generic_name, strength, dosage_form, drug_class, fda_registration_no) ON products TO onepos_app;--> statement-breakpoint
GRANT UPDATE (expired_stock) ON inventory_settings TO onepos_app;--> statement-breakpoint

-- Never deleted: what sales, fills and the books name; fills are evidence.
CREATE TRIGGER pharmacist_licenses_no_delete BEFORE DELETE ON pharmacist_licenses FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER prescriptions_no_delete BEFORE DELETE ON prescriptions FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER prescription_fills_append_only BEFORE UPDATE OR DELETE ON prescription_fills FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER dispense_approvals_no_delete BEFORE DELETE ON dispense_approvals FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER lot_holds_no_delete BEFORE DELETE ON lot_holds FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- A prescription (§6): edited only until something is dispensed on it; voided only while nothing is
-- (all fills given back); a void is final. Anonymising the customer may always unlink it.
CREATE FUNCTION app_prescription_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  filled boolean;
  held boolean;
BEGIN
  -- Anonymising the customer unlinks the prescription, whatever its state.
  IF (to_jsonb(NEW) - ARRAY['customer_id', 'updated_by', 'updated_at']) = (to_jsonb(OLD) - ARRAY['customer_id', 'updated_by', 'updated_at']) AND NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this prescription was voided and does not change' USING ERRCODE = '23514', CONSTRAINT = 'prescriptions_voided_final';
  END IF;
  SELECT EXISTS (SELECT 1 FROM prescription_fills f WHERE f.tenant_id = NEW.tenant_id AND f.prescription_id = NEW.id) INTO filled;
  IF NOT filled THEN
    RETURN NEW;
  END IF;
  IF NEW.voided_at IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM prescription_fills f WHERE f.tenant_id = NEW.tenant_id AND f.prescription_id = NEW.id
                    GROUP BY f.prescription_item_id HAVING sum(f.quantity) <> 0) INTO held;
    IF held THEN
      RAISE EXCEPTION 'medicine was dispensed on this prescription; return it before voiding' USING ERRCODE = '23514', CONSTRAINT = 'prescriptions_void_dispensed';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_by', 'updated_at']) = (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_by', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'medicine was dispensed on this prescription, so it no longer changes' USING ERRCODE = '23514', CONSTRAINT = 'prescriptions_dispensed_final';
END $$;--> statement-breakpoint
CREATE TRIGGER prescriptions_update BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION app_prescription_update();--> statement-breakpoint

-- Its items change (as a set) only while nothing is dispensed on it and it is not voided.
CREATE FUNCTION app_prescription_items_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rx_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.prescription_id ELSE NEW.prescription_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = rx_id AND p.voided_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM prescription_fills f WHERE f.prescription_id = rx_id) THEN
    RAISE EXCEPTION 'medicine was dispensed on this prescription, so it no longer changes' USING ERRCODE = '23514', CONSTRAINT = 'prescriptions_dispensed_final';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;--> statement-breakpoint
CREATE TRIGGER prescription_items_open BEFORE INSERT OR DELETE ON prescription_items FOR EACH ROW EXECUTE FUNCTION app_prescription_items_open();--> statement-breakpoint

-- Fills (§6): one item's fills are serialised (the API takes the same lock first); never more than was
-- prescribed, never below zero; a dangerous drug is dispensed in one full fill; the product dispensed has
-- the item's generic name, strength and form; a voided prescription takes no more.
CREATE FUNCTION app_prescription_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item prescription_items%ROWTYPE;
  voided timestamptz;
  product_key text;
  before numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rx-item:' || NEW.prescription_item_id::text, 0));
  SELECT * INTO item FROM prescription_items i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.prescription_item_id;
  IF item.prescription_id IS DISTINCT FROM NEW.prescription_id THEN
    RAISE EXCEPTION 'the item is not on this prescription' USING ERRCODE = '23514', CONSTRAINT = 'prescription_fills_item_match';
  END IF;
  SELECT coalesce(sum(f.quantity), 0) INTO before FROM prescription_fills f WHERE f.tenant_id = NEW.tenant_id AND f.prescription_item_id = NEW.prescription_item_id;
  IF before + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'more given back than was dispensed on this prescription' USING ERRCODE = '23514', CONSTRAINT = 'prescription_fills_not_negative';
  END IF;
  IF NEW.quantity > 0 THEN
    SELECT p.voided_at INTO voided FROM prescriptions p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.prescription_id;
    IF voided IS NOT NULL THEN
      RAISE EXCEPTION 'this prescription was voided' USING ERRCODE = '23514', CONSTRAINT = 'prescriptions_voided_final';
    END IF;
    SELECT pr.generic_key INTO product_key FROM product_variants v JOIN products pr ON pr.tenant_id = v.tenant_id AND pr.id = v.product_id
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
    IF product_key IS DISTINCT FROM item.generic_key THEN
      RAISE EXCEPTION 'this medicine is not what the prescription orders' USING ERRCODE = '23514', CONSTRAINT = 'prescription_fills_generic_match';
    END IF;
    IF before + NEW.quantity > item.quantity AND NOT NEW.needs_review THEN
      RAISE EXCEPTION 'more than the prescription allows' USING ERRCODE = '23514', CONSTRAINT = 'prescription_fills_within_prescribed';
    END IF;
    IF item.drug_class = 'DANGEROUS' AND (before <> 0 OR NEW.quantity <> item.quantity) THEN
      RAISE EXCEPTION 'a dangerous drug is dispensed once, in full' USING ERRCODE = '23514', CONSTRAINT = 'prescription_fills_dangerous_full';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER prescription_fills_check BEFORE INSERT ON prescription_fills FOR EACH ROW EXECUTE FUNCTION app_prescription_fill();--> statement-breakpoint

-- A pharmacist's approval is used once, by one sale.
CREATE FUNCTION app_dispense_approval_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sale_id IS NOT NULL OR NEW.sale_id IS NULL THEN
    RAISE EXCEPTION 'this approval was already used' USING ERRCODE = '23514', CONSTRAINT = 'dispense_approvals_used_once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER dispense_approvals_use BEFORE UPDATE ON dispense_approvals FOR EACH ROW EXECUTE FUNCTION app_dispense_approval_use();--> statement-breakpoint

-- A hold is released once.
CREATE FUNCTION app_lot_hold_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'this hold was already released' USING ERRCODE = '23514', CONSTRAINT = 'lot_holds_release_once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER lot_holds_release BEFORE UPDATE ON lot_holds FOR EACH ROW EXECUTE FUNCTION app_lot_hold_release();--> statement-breakpoint

-- Lots (ADR-0020 §3, ADR-0025 §4). As in 0089, plus: at a branch where expired stock is blocked (its
-- setting, else BLOCK for a pharmacy), a SALE, CONSUMPTION or UNPACK_OUT takes unexpired, unheld lots
-- before expired or held ones; any draw from an expired (expires_on < today, branch calendar) or held lot
-- is marked `expired`. The definer bypasses RLS: every read filters on the movement's tenant.
GRANT SELECT ON lot_holds, tenants TO onepos_platform;--> statement-breakpoint
GRANT UPDATE (expired) ON stock_lot_movements TO onepos_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_track_stock_lots() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tracks boolean;
  cap numeric;
  dated numeric;
  room numeric;
  need numeric;
  take numeric;
  excess numeric;
  lot stock_lots%ROWTYPE;
  src record;
  lot_id uuid;
  today date;
  blocked boolean;
  sellable_first boolean;
BEGIN
  SELECT p.tracks_expiry INTO tracks FROM product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
   WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
  tracks := coalesce(tracks, false);
  IF NOT tracks AND NEW.expires_on IS NULL AND NEW.lot_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM stock_lots s WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.variant_id = NEW.variant_id AND s.quantity > 0) THEN
    RETURN NULL;
  END IF;
  -- The balance row is locked by the costing trigger in this transaction: lots of this item at this
  -- branch change one movement at a time.
  SELECT greatest(b.quantity, 0) INTO cap FROM stock_balances b
   WHERE b.tenant_id = NEW.tenant_id AND b.branch_id = NEW.branch_id AND b.variant_id = NEW.variant_id;
  SELECT coalesce(sum(s.quantity), 0) INTO dated FROM stock_lots s
   WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.variant_id = NEW.variant_id;

  IF NEW.quantity > 0 THEN
    room := least(cap - dated, NEW.quantity);
    IF room <= 0 THEN
      RETURN NULL; -- the stock was below zero: what comes in fills the gap, undated
    END IF;
    FOR src IN
      SELECT x.expires_on, x.lot_code, x.qty FROM (
        SELECT NEW.expires_on AS expires_on, NEW.lot_code AS lot_code, NEW.quantity AS qty
         WHERE NEW.expires_on IS NOT NULL
        UNION ALL
        SELECT s.expires_on, s.lot_code, -sum(lm.quantity)
          FROM stock_lot_movements lm
          JOIN stock_lots s ON s.tenant_id = lm.tenant_id AND s.id = lm.lot_id
          JOIN stock_movements m ON m.tenant_id = lm.tenant_id AND m.id = lm.movement_id
         WHERE tracks AND NEW.expires_on IS NULL AND lm.tenant_id = NEW.tenant_id
           AND ((NEW.type = 'RETURN' AND m.sale_line_id = NEW.sale_line_id AND m.type IN ('SALE', 'RETURN'))
             OR (NEW.type = 'TRANSFER_IN' AND m.stock_transfer_line_id = NEW.stock_transfer_line_id AND m.type = 'TRANSFER_OUT'))
         GROUP BY s.expires_on, s.lot_code
        HAVING -sum(lm.quantity) > 0
        UNION ALL
        SELECT s.expires_on, s.lot_code, -sum(lm.quantity) * o.pieces / o.packs
          FROM stock_lot_movements lm
          JOIN stock_lots s ON s.tenant_id = lm.tenant_id AND s.id = lm.lot_id
          JOIN stock_movements m ON m.tenant_id = lm.tenant_id AND m.id = lm.movement_id
          JOIN pack_openings o ON o.tenant_id = m.tenant_id AND o.id = m.pack_opening_id
         WHERE tracks AND NEW.type = 'UNPACK_IN' AND lm.tenant_id = NEW.tenant_id
           AND m.pack_opening_id = NEW.pack_opening_id AND m.type = 'UNPACK_OUT'
         GROUP BY s.expires_on, s.lot_code, o.pieces, o.packs
      ) x ORDER BY x.expires_on, x.lot_code NULLS FIRST
    LOOP
      take := least(src.qty, room);
      EXIT WHEN take <= 0;
      INSERT INTO stock_lots (tenant_id, branch_id, variant_id, expires_on, lot_code, quantity)
      VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, src.expires_on, src.lot_code, take)
      ON CONFLICT (tenant_id, branch_id, variant_id, expires_on, (coalesce(lot_code, '')))
        DO UPDATE SET quantity = stock_lots.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING id INTO lot_id;
      INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity) VALUES (NEW.tenant_id, lot_id, NEW.id, take);
      room := room - take;
    END LOOP;
    RETURN NULL;
  END IF;

  SELECT (now() AT TIME ZONE b.timezone)::date,
         coalesce(i.expired_stock, CASE WHEN t.business_type = 'PHARMACY' THEN 'BLOCK' ELSE 'ALLOW' END) = 'BLOCK'
    INTO today, blocked
    FROM branches b
    JOIN tenants t ON t.id = b.tenant_id
    LEFT JOIN inventory_settings i ON i.tenant_id = b.tenant_id AND i.branch_id = b.id
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.branch_id;
  sellable_first := coalesce(blocked, false) AND NEW.type IN ('SALE', 'CONSUMPTION', 'UNPACK_OUT');

  need := -NEW.quantity;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT * INTO lot FROM stock_lots s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.lot_id FOR UPDATE;
    IF lot.branch_id IS DISTINCT FROM NEW.branch_id OR lot.variant_id IS DISTINCT FROM NEW.variant_id THEN
      RAISE EXCEPTION 'the lot named is not this item''s at this branch' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_named_lot_match';
    END IF;
    take := least(need, lot.quantity);
    IF take > 0 THEN
      UPDATE stock_lots SET quantity = quantity - take, updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = lot.id;
      INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity, expired)
      VALUES (NEW.tenant_id, lot.id, NEW.id, -take, lot.expires_on < today OR app_lot_held(NEW.tenant_id, NEW.branch_id, lot.variant_id, lot.lot_code));
      dated := dated - take;
      need := need - take;
    END IF;
  END IF;
  excess := least(dated - cap, need);
  IF excess > 0 THEN
    FOR lot IN
      SELECT * FROM stock_lots s
       WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.variant_id = NEW.variant_id AND s.quantity > 0
       ORDER BY CASE WHEN sellable_first AND (s.expires_on < today OR app_lot_held(s.tenant_id, s.branch_id, s.variant_id, s.lot_code)) THEN 1 ELSE 0 END,
                s.expires_on, s.lot_code NULLS FIRST, s.id
       FOR UPDATE
    LOOP
      take := least(lot.quantity, excess);
      UPDATE stock_lots SET quantity = quantity - take, updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = lot.id;
      INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity, expired)
      VALUES (NEW.tenant_id, lot.id, NEW.id, -take, lot.expires_on < today OR app_lot_held(NEW.tenant_id, NEW.branch_id, lot.variant_id, lot.lot_code));
      excess := excess - take;
      EXIT WHEN excess <= 0;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint

-- Whether a lot is on hold at a branch (a hold for the branch or for every branch, same lot code).
CREATE FUNCTION app_lot_held(p_tenant uuid, p_branch uuid, p_variant uuid, p_lot_code text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_lot_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM lot_holds h
     WHERE h.tenant_id = p_tenant AND h.variant_id = p_variant AND h.released_at IS NULL
       AND upper(btrim(h.lot_code)) = upper(btrim(p_lot_code)) AND (h.branch_id IS NULL OR h.branch_id = p_branch))
$$;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION app_lot_held(uuid, uuid, uuid, text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_lot_held(uuid, uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_track_stock_lots() FROM PUBLIC;--> statement-breakpoint

-- Permissions (§9): in the catalog, and in the built-in roles of every business.
INSERT INTO permissions (code, description) VALUES
  ('pharmacy.read', 'See prescriptions and the prescription and dangerous drugs books'),
  ('pharmacy.dispense', 'Dispense prescription medicines and antibiotics, record prescriptions'),
  ('pharmacy.dangerous_drugs', 'Dispense dangerous drugs (with a pharmacist licence on record)'),
  ('pharmacy.setup', 'Set up pharmacy rules and members'' pharmacist licences');--> statement-breakpoint
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r
  CROSS JOIN (VALUES ('pharmacy.read'), ('pharmacy.dispense'), ('pharmacy.dangerous_drugs'), ('pharmacy.setup')) AS p(code)
 WHERE r.is_system AND (
       r.key IN ('owner', 'admin')
    OR (r.key = 'branch_manager' AND p.code IN ('pharmacy.read', 'pharmacy.dispense')))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The pharmacy roles for businesses that already sell medicines (HYBRID); others get them when they
-- change type (BusinessService). A unit test checks this array against ROLE_TEMPLATES.
WITH templates(key, name, permissions) AS (
  VALUES
    ('pharmacist', 'Pharmacist', ARRAY['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'cash.session', 'customers.read', 'customers.manage',
      'inventory.read', 'inventory.adjust', 'inventory.count', 'pharmacy.read', 'pharmacy.dispense', 'pharmacy.dangerous_drugs']),
    ('pharmacy_assistant', 'Pharmacy Assistant', ARRAY['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'inventory.read', 'inventory.count', 'pharmacy.read'])
),
added AS (
  INSERT INTO roles (tenant_id, key, name, is_system)
  SELECT t.id, tp.key, tp.name, true FROM tenants t CROSS JOIN templates tp
   WHERE t.business_type IN ('PHARMACY', 'HYBRID')
  ON CONFLICT ON CONSTRAINT roles_tenant_key_unique DO NOTHING
  RETURNING id, tenant_id, key
)
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT a.tenant_id, a.id, unnest(tp.permissions) FROM added a JOIN templates tp ON tp.key = a.key;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
