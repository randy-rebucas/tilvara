-- Hand-written (session 24, ADR-0020 §2): packs and pieces (tingi). DDL is in 0086.
-- * pack_conversions: a pack and the piece sold from it. Only auto_open and archiving change; a new
--   count is a new link. Never deleted.
-- * pack_openings: append-only documents; pieces = packs × the link's count.
-- * The costing trigger prices UNPACK_IN at what its UNPACK_OUT took out of the pack (exactly, when the
--   pieces were not below zero), and checks both movements against their opening.
ALTER TABLE pack_conversions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pack_conversions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON pack_conversions USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE pack_openings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pack_openings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON pack_openings USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON pack_conversions, pack_openings TO onepos_app;--> statement-breakpoint
GRANT UPDATE (auto_open, archived_at) ON pack_conversions TO onepos_app;--> statement-breakpoint
GRANT SELECT ON pack_conversions, pack_openings TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON pack_conversions, pack_openings TO onepos_worker;--> statement-breakpoint
-- The costing trigger (owned by onepos_platform) checks pack movements against their opening.
GRANT SELECT ON pack_conversions, pack_openings TO onepos_platform;--> statement-breakpoint

CREATE TRIGGER pack_openings_append_only BEFORE UPDATE OR DELETE ON pack_openings
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_pack_conversion_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pack_conversions rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.archived_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['auto_open','archived_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['auto_open','archived_at']) THEN
    RAISE EXCEPTION 'a pack link only turns automatic opening on or off, or is archived, once' USING ERRCODE = '23514', CONSTRAINT = 'pack_conversions_change';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pack_conversions_change BEFORE UPDATE OR DELETE ON pack_conversions
  FOR EACH ROW EXECUTE FUNCTION app_pack_conversion_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_pack_opening_pieces() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  per numeric;
BEGIN
  SELECT c.pieces_per_pack INTO per FROM pack_conversions c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversion_id;
  IF per IS NULL OR NEW.pieces <> NEW.packs * per THEN
    RAISE EXCEPTION 'an opening gives packs × the link''s pieces per pack' USING ERRCODE = '23514', CONSTRAINT = 'pack_openings_pieces_match';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pack_openings_pieces BEFORE INSERT ON pack_openings
  FOR EACH ROW EXECUTE FUNCTION app_pack_opening_pieces();--> statement-breakpoint

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
  o record;
  out_value numeric;
BEGIN
  -- Pack openings (ADR-0020): each movement is the opening's packs out or pieces in, once.
  IF NEW.type IN ('UNPACK_OUT', 'UNPACK_IN') THEN
    SELECT p.branch_id, p.packs, p.pieces, c.pack_variant_id, c.piece_variant_id INTO o
      FROM pack_openings p JOIN pack_conversions c ON c.tenant_id = p.tenant_id AND c.id = p.conversion_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.pack_opening_id;
    IF o.branch_id IS DISTINCT FROM NEW.branch_id
       OR (NEW.type = 'UNPACK_OUT' AND (NEW.variant_id <> o.pack_variant_id OR NEW.quantity <> -o.packs))
       OR (NEW.type = 'UNPACK_IN' AND (NEW.variant_id <> o.piece_variant_id OR NEW.quantity <> o.pieces))
       OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = NEW.type) THEN
      RAISE EXCEPTION 'pack movement does not match its opening' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
    END IF;
  END IF;

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
    ELSIF NEW.type = 'UNPACK_IN' THEN
      -- The pieces carry what the packs took out (the packs leave first, in the same transaction).
      SELECT m.value INTO out_value FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = 'UNPACK_OUT';
      IF out_value IS NULL THEN
        RAISE EXCEPTION 'pieces from a pack that has not left stock' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
      END IF;
      NEW.unit_cost := round(-out_value / NEW.quantity, 4);
    ELSIF NEW.type = 'COUNT' THEN
      SELECT CASE WHEN b.avg_cost > 0 THEN b.avg_cost ELSE coalesce(v.reference_cost, 0) END INTO NEW.unit_cost
        FROM product_variants v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
    END IF;
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'inbound stock movement (%) needs a unit cost', NEW.type
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_unit_cost_required';
    END IF;
    IF NEW.type = 'UNPACK_IN' AND b.quantity >= 0 THEN
      -- Exactly the packs' value, so an opening moves no value in the books.
      v_after := b.value - out_value;
      avg_after := round(v_after / q_after, 4);
    ELSIF b.quantity > 0 THEN
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
