-- Hand-written: negative-stock policy, low-stock alerts and blind count sheets (session 16; ADR-0012
-- amendment). DDL is in 0060.
-- * inventory_settings: per-branch policy (ALLOW / ALLOW_WITH_FLAG / BLOCK) and the low-stock switch.
-- * The costing trigger marks an outbound movement that leaves the balance below zero
--   (stock_movements.below_zero), and writes outbox events itself, because only it sees the quantity
--   before and after under the balance lock, whatever document moved the stock:
--     stock.low        the balance fell from above its reorder point to at or below it (alerts on);
--     stock.below_zero the balance fell from zero or more to below zero (policy is not ALLOW).
-- * A COUNT line with expected_quantity (posted from a count sheet) moves counted − expected: the
--   difference found against the frozen quantity, on top of whatever moved since the freeze.
-- * Count sheets: OPEN → POSTED | CANCELLED once; lines take counts only while their sheet is open.
-- * Permission inventory.count (enter counts without seeing the frozen quantities), given to every
--   business's owner and admin roles (the built-in templates hold every permission but subscription).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_settings', 'stock_count_sheets', 'stock_count_sheet_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_worker', t); -- data export (ADR-0016 slice 6)
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (negative_stock_policy, low_stock_alerts, updated_by, updated_at) ON inventory_settings TO onepos_app;
GRANT SELECT, INSERT, UPDATE (status, stock_count_id, closed_by, closed_at, cancel_reason) ON stock_count_sheets TO onepos_app;
GRANT SELECT, INSERT, UPDATE (counted_quantity, counted_by, counted_at) ON stock_count_sheet_lines TO onepos_app;

-- Count sheets move once, and only forward; what was frozen never changes.
CREATE FUNCTION app_count_sheet_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'a count sheet starts open' USING ERRCODE = '23514', CONSTRAINT = 'stock_count_sheets_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'OPEN' OR NEW.status NOT IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'count sheet % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'stock_count_sheets_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_count_sheets_transition BEFORE INSERT OR UPDATE ON stock_count_sheets
  FOR EACH ROW EXECUTE FUNCTION app_count_sheet_transition();

-- Lines are added and counted only while their sheet is open (FOR SHARE: a racing post or cancel
-- waits for this line, then sees it, or this line waits and is refused).
CREATE FUNCTION app_count_sheet_line_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM stock_count_sheets WHERE tenant_id = NEW.tenant_id AND id = NEW.sheet_id FOR SHARE;
  IF s IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'count sheet % is closed', NEW.sheet_id USING ERRCODE = '23514', CONSTRAINT = 'stock_count_sheet_lines_sheet_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_count_sheet_lines_sheet_open BEFORE INSERT OR UPDATE ON stock_count_sheet_lines
  FOR EACH ROW EXECUTE FUNCTION app_count_sheet_line_open();

-- Costing trigger (ADR-0012), extended again (last version: 0027).
CREATE OR REPLACE FUNCTION app_cost_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b stock_balances%ROWTYPE;
  q_after numeric;
  v_after numeric;
  avg_after numeric;
  counted numeric;
  expected numeric;
  rp numeric;
  policy text;
  alerts boolean;
BEGIN
  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, value, avg_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, 0, 0, 0, now())
  ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING;
  SELECT * INTO b FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id
   FOR UPDATE;

  IF NEW.type = 'COUNT' THEN
    SELECT l.counted_quantity, l.expected_quantity INTO counted, expected FROM stock_count_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.stock_count_line_id AND l.variant_id = NEW.variant_id;
    IF counted IS NULL THEN
      RAISE EXCEPTION 'count movement without its count line' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_count_link';
    END IF;
    -- From a count sheet: the difference against the frozen quantity; else set on hand to the count.
    NEW.quantity := counted - coalesce(expected, b.quantity);
    IF NEW.quantity = 0 THEN
      RETURN NULL; -- nothing to move
    END IF;
    NEW.unit_cost := NULL;
  END IF;
  q_after := b.quantity + NEW.quantity;

  IF NEW.quantity < 0 THEN
    NEW.unit_cost := b.avg_cost;
    NEW.value := CASE WHEN q_after = 0 THEN -b.value ELSE round(NEW.quantity * b.avg_cost, 4) END;
    v_after := b.value + NEW.value;
    avg_after := b.avg_cost;
    NEW.below_zero := q_after < 0;
  ELSE
    IF NEW.type = 'RETURN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.sale_line_id = NEW.sale_line_id AND m.type = 'SALE'
       ORDER BY m.created_at, m.id LIMIT 1;
    ELSIF NEW.type = 'TRANSFER_IN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.stock_transfer_line_id = NEW.stock_transfer_line_id AND m.type = 'TRANSFER_OUT';
    ELSIF NEW.type = 'COUNT' THEN
      SELECT CASE WHEN b.avg_cost > 0 THEN b.avg_cost ELSE coalesce(v.reference_cost, 0) END INTO NEW.unit_cost
        FROM product_variants v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
    END IF;
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'inbound stock movement (%) needs a unit cost', NEW.type
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_unit_cost_required';
    END IF;
    IF b.quantity > 0 THEN
      v_after := b.value + round(NEW.quantity * NEW.unit_cost, 4);
      avg_after := round(v_after / q_after, 4);
    ELSE
      avg_after := NEW.unit_cost;
      v_after := round(q_after * NEW.unit_cost, 4);
    END IF;
    NEW.value := v_after - b.value;
    NEW.below_zero := false;
  END IF;

  UPDATE stock_balances
     SET quantity = q_after, value = v_after, avg_cost = avg_after, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id;

  -- Alerts: only when going down, and only on the crossing, so a busy day mails once per item.
  IF NEW.quantity < 0 THEN
    SELECT s.negative_stock_policy, s.low_stock_alerts INTO policy, alerts FROM inventory_settings s
     WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id;
    policy := coalesce(policy, 'ALLOW');
    alerts := coalesce(alerts, true);
    IF alerts THEN
      SELECT r.reorder_point INTO rp FROM reorder_points r
       WHERE r.tenant_id = NEW.tenant_id AND r.branch_id = NEW.branch_id AND r.variant_id = NEW.variant_id;
      IF rp IS NOT NULL AND b.quantity > rp AND q_after <= rp THEN
        INSERT INTO outbox_events (tenant_id, topic, payload)
        VALUES (NEW.tenant_id, 'stock.low', jsonb_build_object(
          'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
          'quantity', q_after::text, 'reorderPoint', rp::text));
      END IF;
    END IF;
    IF policy <> 'ALLOW' AND b.quantity >= 0 AND q_after < 0 THEN
      INSERT INTO outbox_events (tenant_id, topic, payload)
      VALUES (NEW.tenant_id, 'stock.below_zero', jsonb_build_object(
        'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
        'quantity', q_after::text, 'saleId', NEW.sale_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
GRANT SELECT ON inventory_settings, reorder_points TO onepos_platform;
GRANT INSERT ON outbox_events TO onepos_platform;

-- BLOCK at the counter: the app may read balances but not lock them (FOR UPDATE needs UPDATE). This
-- locks the caller's own balance rows in variant order, the order the costing trigger locks them a
-- moment later in the same transaction, and answers what is on hand; items with no row hold 0.
CREATE FUNCTION app_lock_stock_balances(p_branch uuid, p_variants uuid[])
  RETURNS TABLE (variant_id uuid, quantity numeric)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.variant_id, b.quantity FROM stock_balances b
   WHERE b.tenant_id = app_current_tenant_id() AND b.branch_id = p_branch AND b.variant_id = ANY (p_variants)
   ORDER BY b.variant_id
   FOR UPDATE
$$;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION app_lock_stock_balances(uuid, uuid[]) OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION app_lock_stock_balances(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lock_stock_balances(uuid, uuid[]) TO onepos_app;

-- inventory.count: in the catalog, and in every business's owner and admin roles.
INSERT INTO permissions (code, description) VALUES ('inventory.count', 'Count stock on count sheets without seeing the expected quantities');

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'inventory.count'
  FROM roles r JOIN tenants t ON t.id = r.tenant_id
 WHERE r.is_system AND r.key IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
