-- Hand-written: restaurant orders, kitchen tickets and order items (Phase 4 slice 3, ADR-0014 §6, §7).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_orders', 'kitchen_tickets', 'order_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['restaurant_orders', 'kitchen_tickets'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['restaurant_orders', 'order_items'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t || '_touch_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (table_id, guest_count, customer_name, note, status, merged_into_id, close_reason, closed_by, closed_at, updated_at)
  ON restaurant_orders TO onepos_app;
GRANT SELECT, INSERT, UPDATE (bumped_at, bumped_by) ON kitchen_tickets TO onepos_app;
GRANT SELECT, INSERT, DELETE,
      UPDATE (order_id, quantity, course, seat, note, status, kitchen_ticket_id, fired_at, prep_started_at, ready_at, served_at,
              voided_at, voided_by, void_reason, waste_adjustment_id, updated_at)
  ON order_items TO onepos_app;

-- Orders: OPEN → BILLED → SETTLED; BILLED → OPEN (bill reopened); OPEN → CANCELLED | MERGED.
-- Closed orders never change; identity never changes.
CREATE FUNCTION app_restaurant_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SETTLED', 'CANCELLED', 'MERGED') THEN
    RAISE EXCEPTION 'a % order cannot change', lower(OLD.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status IN ('BILLED', 'CANCELLED', 'MERGED'))
    OR (OLD.status = 'BILLED' AND NEW.status IN ('OPEN', 'SETTLED'))) THEN
    RAISE EXCEPTION 'an % order cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_orders_transition BEFORE UPDATE ON restaurant_orders
  FOR EACH ROW EXECUTE FUNCTION app_restaurant_order_transition();

-- Items are added to open orders only, as PENDING, next to their parent.
CREATE FUNCTION app_order_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'an order item starts as pending' USING ERRCODE = '23514', CONSTRAINT = 'order_items_transition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM restaurant_orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id AND o.status = 'OPEN') THEN
    RAISE EXCEPTION 'items can only be added to an open order' USING ERRCODE = '23514', CONSTRAINT = 'order_items_order_open';
  END IF;
  IF NEW.parent_item_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM order_items p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.parent_item_id AND p.order_id = NEW.order_id AND p.kind = 'ITEM') THEN
    RAISE EXCEPTION 'a modifier belongs to an item of the same order' USING ERRCODE = '23514', CONSTRAINT = 'order_items_parent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_items_insert BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION app_order_item_insert();

-- Once fired, what was ordered is frozen; status only moves forward (PENDING → FIRED → IN_PREP →
-- READY → SERVED, skipping allowed) or to VOIDED; VOIDED is final. Items move only into open orders.
CREATE FUNCTION app_order_item_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int := array_position(ARRAY['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED'], OLD.status);
  rank_new int := array_position(ARRAY['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED'], NEW.status);
BEGIN
  IF OLD.status <> 'PENDING' AND (NEW.quantity <> OLD.quantity OR NEW.course <> OLD.course) THEN
    RAISE EXCEPTION 'a fired item cannot be changed; void it instead' USING ERRCODE = '23514', CONSTRAINT = 'order_items_frozen';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status = 'VOIDED'
       OR (NEW.status = 'VOIDED' AND OLD.status = 'PENDING')
       OR (NEW.status <> 'VOIDED' AND NOT (rank_new > rank_old AND (OLD.status <> 'PENDING' OR NEW.status = 'FIRED'))) THEN
      RAISE EXCEPTION 'an item cannot go from % to %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'order_items_transition';
    END IF;
  END IF;
  IF NEW.order_id <> OLD.order_id AND NOT EXISTS (
       SELECT 1 FROM restaurant_orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id AND o.status = 'OPEN') THEN
    RAISE EXCEPTION 'items can only move into an open order' USING ERRCODE = '23514', CONSTRAINT = 'order_items_order_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_items_update BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION app_order_item_update();

-- Only items the kitchen never saw may disappear; fired items are voided, never deleted.
CREATE FUNCTION app_order_item_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a fired item cannot be removed; void it instead' USING ERRCODE = '23514', CONSTRAINT = 'order_items_frozen';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER order_items_delete BEFORE DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION app_order_item_delete();
