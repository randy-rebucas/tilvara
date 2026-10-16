-- Hand-written: weighted-average costing in the stock ledger (ADR-0012).

-- 1. Legacy movements (before costing) are valued at the variant's reference cost, else 0.
--    The ledger is append-only for everyone else; only this migration may touch history.
--    FORCE RLS applies to the migrator too (no tenant context here), so lift it for the backfill.
ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_balances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE product_variants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only;
UPDATE stock_movements m
   SET unit_cost = coalesce(v.reference_cost, 0),
       value = round(m.quantity * coalesce(v.reference_cost, 0), 4)
  FROM product_variants v
 WHERE v.tenant_id = m.tenant_id AND v.id = m.variant_id;
ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only;

UPDATE stock_balances b
   SET value = coalesce((SELECT sum(m.value) FROM stock_movements m
                          WHERE m.tenant_id = b.tenant_id AND m.branch_id = b.branch_id AND m.variant_id = b.variant_id), 0),
       avg_cost = coalesce((SELECT v.reference_cost FROM product_variants v WHERE v.tenant_id = b.tenant_id AND v.id = b.variant_id), 0);
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;

-- 2. No silent zero cost: an inbound movement without a cost is refused by the trigger below.
ALTER TABLE stock_movements ALTER COLUMN unit_cost DROP DEFAULT;
ALTER TABLE stock_movements ALTER COLUMN value DROP DEFAULT;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_unit_cost_non_negative CHECK (unit_cost >= 0);

-- 3. One trigger owns quantity, value and average, under the balance row lock.
DROP TRIGGER stock_movements_apply_balance ON stock_movements;
DROP FUNCTION app_apply_stock_movement();

CREATE FUNCTION app_cost_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b stock_balances%ROWTYPE;
  q_after numeric;
  v_after numeric;
  avg_after numeric;
BEGIN
  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, value, avg_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, 0, 0, 0, now())
  ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING;
  SELECT * INTO b FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id
   FOR UPDATE;
  q_after := b.quantity + NEW.quantity;

  IF NEW.quantity < 0 THEN
    -- Outbound leaves at the current average; emptying the item takes the exact remaining value.
    NEW.unit_cost := b.avg_cost;
    NEW.value := CASE WHEN q_after = 0 THEN -b.value ELSE round(NEW.quantity * b.avg_cost, 4) END;
    v_after := b.value + NEW.value;
    avg_after := b.avg_cost;
  ELSE
    IF NEW.type = 'RETURN' THEN
      -- A customer return comes back at the cost its sale went out with.
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.sale_line_id = NEW.sale_line_id AND m.type = 'SALE'
       ORDER BY m.created_at, m.id LIMIT 1;
    END IF;
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'inbound stock movement (%) needs a unit cost', NEW.type
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_unit_cost_required';
    END IF;
    IF b.quantity > 0 THEN
      v_after := b.value + round(NEW.quantity * NEW.unit_cost, 4);
      avg_after := round(v_after / q_after, 4);
    ELSE
      -- Restart from this cost; the movement value absorbs the revaluation of units sold short.
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
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION app_cost_stock_movement() OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION app_cost_stock_movement() FROM PUBLIC;
GRANT SELECT ON stock_movements TO onepos_platform;
CREATE TRIGGER stock_movements_cost BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app_cost_stock_movement();
