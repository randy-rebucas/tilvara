-- Hand-written: transfers, counts, waste and reorder points (Phase 3 slice 3).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_transfers', 'stock_transfer_lines', 'stock_counts', 'stock_count_lines', 'reorder_points'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stock_counts', 'stock_count_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['stock_transfers', 'stock_transfer_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (status, received_by, received_at, receive_notes) ON stock_transfers TO onepos_app;
GRANT SELECT, INSERT, UPDATE (received_quantity, discrepancy_reason) ON stock_transfer_lines TO onepos_app;
-- Reorder points are configuration, not evidence: editable and removable (changes are audited by the API).
GRANT SELECT, INSERT, UPDATE (reorder_point, reorder_quantity, updated_by, updated_at), DELETE ON reorder_points TO onepos_app;

-- A transfer is received once; what was sent never changes.
CREATE FUNCTION app_stock_transfer_receive_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'stock_transfers' THEN
    IF NOT (OLD.status = 'DISPATCHED' AND NEW.status = 'RECEIVED') THEN
      RAISE EXCEPTION 'a transfer is received once' USING ERRCODE = '23514', CONSTRAINT = 'stock_transfers_receive_once';
    END IF;
  ELSIF OLD.received_quantity IS NOT NULL THEN
    RAISE EXCEPTION 'a transfer line is received once' USING ERRCODE = '23514', CONSTRAINT = 'stock_transfers_receive_once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_transfers_receive_once BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION app_stock_transfer_receive_once();
CREATE TRIGGER stock_transfer_lines_receive_once BEFORE UPDATE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION app_stock_transfer_receive_once();

-- Costing trigger (ADR-0012), extended:
--   TRANSFER_IN comes in at the unit cost its TRANSFER_OUT left with;
--   COUNT sets the quantity itself = counted − on hand, under the balance lock (no row when equal);
--   stock found without a cost (COUNT surplus) uses the last average, else the reference cost, else 0.
CREATE OR REPLACE FUNCTION app_cost_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b stock_balances%ROWTYPE;
  q_after numeric;
  v_after numeric;
  avg_after numeric;
  counted numeric;
BEGIN
  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, value, avg_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, 0, 0, 0, now())
  ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING;
  SELECT * INTO b FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id
   FOR UPDATE;

  IF NEW.type = 'COUNT' THEN
    SELECT l.counted_quantity INTO counted FROM stock_count_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.stock_count_line_id AND l.variant_id = NEW.variant_id;
    IF counted IS NULL THEN
      RAISE EXCEPTION 'count movement without its count line' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_count_link';
    END IF;
    NEW.quantity := counted - b.quantity;
    IF NEW.quantity = 0 THEN
      RETURN NULL; -- counted = on hand: nothing to move
    END IF;
    NEW.unit_cost := NULL;
  END IF;
  q_after := b.quantity + NEW.quantity;

  IF NEW.quantity < 0 THEN
    NEW.unit_cost := b.avg_cost;
    NEW.value := CASE WHEN q_after = 0 THEN -b.value ELSE round(NEW.quantity * b.avg_cost, 4) END;
    v_after := b.value + NEW.value;
    avg_after := b.avg_cost;
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
  END IF;

  UPDATE stock_balances
     SET quantity = q_after, value = v_after, avg_cost = avg_after, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id;
  RETURN NEW;
END $$;
GRANT SELECT ON stock_count_lines, product_variants TO onepos_platform;
