-- Hand-edited (2026-10-25): retail only for now. The user removed the GROCERY, SALON, PHARMACY and HYBRID
-- business types, and with them salons (ADR-0022: service staff, appointments, packages, commissions,
-- tips split per staff, client notes), recipes ("supplies used", ADR-0014 §4), tips (session 25) and
-- prescriptions (ADR-0025: medicine details, prescriptions and fills, the pharmacist's approval and
-- licences, the pharmacy roles and books). Kept for every shop: packs and the box → strip → piece chain
-- (ADR-0020), expiry lots, lot codes, lot holds and the batch trace, and the expired-stock rule.
-- * Every business becomes RETAIL. A former PHARMACY or HYBRID branch without its own expired-stock
--   setting relied on "null = BLOCK there": it gets BLOCK written down, so nothing it blocked becomes
--   sellable. Elsewhere null now means ALLOW.
-- * The appointments.*, staff.manage and pharmacy.* permissions leave the catalog and every role. The Front
--   Desk, Stylist, Pharmacist and Pharmacy Assistant roles are deleted where nobody holds them; a held one
--   stays as the business's own role with what it had left. API keys keep their recorded scopes:
--   `appointments.read` grants nothing now.
-- * Service packages (product type PACKAGE) are archived with their variants; no new one can be made.
-- * Dropped: service staff and their services, hours and time off, appointments, package contents,
--   customers' packages and their entries, tip shares, client notes, pharmacy settings, pharmacist
--   licences, prescriptions, their items and fills, dispensing approvals, recipe versions and ingredients;
--   the links on sale lines (`service_staff_id`, `customer_package_id`), commission rates and the medicine
--   label printed on a line; the medicine details on products; service durations and package validity.
-- * Money already recorded stays as it was (append-only evidence): `sale_tips`, `sale_tip_refunds`,
--   `sale_returns.tip_refund`, tip drawer movements and tip card charges, `sale_lines.package_value` and
--   `stock_movements.recipe_version_id` for consumption, and their journal entries (accounts 2210 Tips
--   payable and 2310 Prepaid service packages stay in existing charts). As in 0110–0111, the checks below
--   are NOT VALID so those old rows stand while no new row may use those values. A return or void of a
--   sale with a tip or a package line is refused by the API (FEATURE_RETIRED).

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE branches NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_memberships NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_settings NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO inventory_settings (tenant_id, branch_id, expired_stock, updated_by)
SELECT b.tenant_id, b.id, 'BLOCK',
       (SELECT m.user_id FROM tenant_memberships m WHERE m.tenant_id = b.tenant_id ORDER BY m.created_at, m.id LIMIT 1)
  FROM branches b JOIN tenants t ON t.id = b.tenant_id
 WHERE t.business_type IN ('PHARMACY', 'HYBRID')
   AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = b.tenant_id)
ON CONFLICT (tenant_id, branch_id) DO UPDATE SET expired_stock = 'BLOCK', updated_at = now()
 WHERE inventory_settings.expired_stock IS NULL;--> statement-breakpoint
UPDATE tenants SET business_type = 'RETAIL', updated_at = now() WHERE business_type <> 'RETAIL';--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE branches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE membership_roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM role_permissions WHERE permission_code LIKE 'appointments.%' OR permission_code = 'staff.manage' OR permission_code LIKE 'pharmacy.%';--> statement-breakpoint
CREATE TEMPORARY TABLE removed_roles_0112 ON COMMIT DROP AS
  SELECT r.tenant_id, r.id FROM roles r WHERE r.is_system AND r.key IN ('front_desk', 'stylist', 'pharmacist', 'pharmacy_assistant');--> statement-breakpoint
DELETE FROM roles r USING removed_roles_0112 x
 WHERE r.tenant_id = x.tenant_id AND r.id = x.id
   AND NOT EXISTS (SELECT 1 FROM membership_roles m WHERE m.tenant_id = r.tenant_id AND m.role_id = r.id);--> statement-breakpoint
UPDATE roles r SET is_system = false FROM removed_roles_0112 x WHERE r.tenant_id = x.tenant_id AND r.id = x.id;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM permissions WHERE code LIKE 'appointments.%' OR code = 'staff.manage' OR code LIKE 'pharmacy.%';--> statement-breakpoint
ALTER TABLE products NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_variants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE product_variants v SET archived_at = now(), updated_at = now()
  FROM products p
 WHERE p.tenant_id = v.tenant_id AND p.id = v.product_id AND p.product_type = 'PACKAGE' AND v.archived_at IS NULL;--> statement-breakpoint
UPDATE products SET archived_at = now(), updated_at = now() WHERE product_type = 'PACKAGE' AND archived_at IS NULL;--> statement-breakpoint
ALTER TABLE products FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP TABLE "recipe_ingredients" CASCADE;--> statement-breakpoint
DROP TABLE "recipe_versions" CASCADE;--> statement-breakpoint
DROP TABLE "appointment_services" CASCADE;--> statement-breakpoint
DROP TABLE "appointments" CASCADE;--> statement-breakpoint
DROP TABLE "customer_notes" CASCADE;--> statement-breakpoint
DROP TABLE "customer_package_entries" CASCADE;--> statement-breakpoint
DROP TABLE "customer_package_items" CASCADE;--> statement-breakpoint
DROP TABLE "customer_packages" CASCADE;--> statement-breakpoint
DROP TABLE "sale_tip_shares" CASCADE;--> statement-breakpoint
DROP TABLE "service_package_items" CASCADE;--> statement-breakpoint
DROP TABLE "service_staff" CASCADE;--> statement-breakpoint
DROP TABLE "service_staff_hours" CASCADE;--> statement-breakpoint
DROP TABLE "service_staff_services" CASCADE;--> statement-breakpoint
DROP TABLE "service_staff_time_off" CASCADE;--> statement-breakpoint
DROP TABLE "dispense_approvals" CASCADE;--> statement-breakpoint
DROP TABLE "pharmacist_licenses" CASCADE;--> statement-breakpoint
DROP TABLE "pharmacy_settings" CASCADE;--> statement-breakpoint
DROP TABLE "prescription_fills" CASCADE;--> statement-breakpoint
DROP TABLE "prescription_items" CASCADE;--> statement-breakpoint
DROP TABLE "prescriptions" CASCADE;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_service_minutes_range";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_package_days_range";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_drug_class_check";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_dosage_form_check";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_staff_rate";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT "sale_lines_package_value";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_scopes_check";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT IF EXISTS "sale_lines_tenant_id_service_staff_id_service_staff_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_lines" DROP CONSTRAINT IF EXISTS "sale_lines_tenant_id_customer_package_id_customer_packages_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_tenant_id_recipe_version_id_recipe_versions_tenant_id_id_fk";
--> statement-breakpoint
DROP INDEX "products_generic_key_idx";--> statement-breakpoint
DROP INDEX "sale_lines_staff_idx";--> statement-breakpoint
DROP INDEX "sale_lines_package_idx";--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "business_type" SET DEFAULT 'RETAIL';--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "service_minutes";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "package_valid_days";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "generic_key";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "drug_class";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "generic_name";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "strength";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "dosage_form";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "fda_registration_no";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "service_staff_id";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "commission_rate";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "customer_package_id";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "drug_class";--> statement-breakpoint
ALTER TABLE "sale_lines" DROP COLUMN "drug_label";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_type_check" CHECK ("products"."product_type" IN ('STANDARD','SERVICE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_package_value" CHECK ("sale_lines"."package_value" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_consumption_retired" CHECK ("stock_movements"."type" <> 'CONSUMPTION') NOT VALID;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") > 0 AND "api_keys"."scopes" <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read']::text[]) NOT VALID;--> statement-breakpoint

DROP FUNCTION app_customer_package_entry();--> statement-breakpoint
DROP FUNCTION app_dispense_approval_use();--> statement-breakpoint
DROP FUNCTION app_prescription_fill();--> statement-breakpoint
DROP FUNCTION app_prescription_items_open();--> statement-breakpoint
DROP FUNCTION app_prescription_update();--> statement-breakpoint
DROP FUNCTION app_recipe_ingredient_rules();--> statement-breakpoint
DROP FUNCTION app_recipe_version_rules();--> statement-breakpoint
DROP FUNCTION app_sale_tip_shares_total();--> statement-breakpoint
DROP FUNCTION platform_flag_appointment_reminders();--> statement-breakpoint

-- 0108's lot trigger without business types: expired or held lots are drawn last (and a sale from them
-- refused online) only where the branch's inventory settings say BLOCK; no setting = ALLOW.
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
         coalesce(i.expired_stock, 'ALLOW') = 'BLOCK'
    INTO today, blocked
    FROM branches b
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
END $$;
