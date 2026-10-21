-- Hand-written (session 24, ADR-0020 §3): expiry lots. DDL is in 0088.
-- * stock_lots / stock_lot_movements are written only by app_track_stock_lots, an AFTER INSERT trigger
--   on stock_movements, so every document that moves stock keeps the lots without knowing about them.
--   The app reads them; nobody else writes them.
-- * The rule: dated lots never hold more than is on hand (Σ lots ≤ max(on hand, 0)); the rest is
--   undated. Coming in: a date given (receipt, adjustment), or the dates the stock left with (customer
--   return → the lots its sale drew from; transfer receipt → the dates sent; pieces → the pack's dates).
--   Going out: undated stock first (the oldest: it came in before dates were kept, or without one),
--   then lots in order of expiry; a movement naming a lot (lot_id) takes it from that lot first.
--   Within one INSERT of several rows the AFTER triggers see the balance after the whole statement, so
--   a draw is capped at the movement's own quantity and the total stays right.
-- * platform_flag_expiring_lots(): the worker's hourly pass marks each lot once when it comes within
--   its branch's alert window (branch calendar) and writes one stock.expiring event per branch.
ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_lots FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON stock_lots USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE stock_lot_movements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_lot_movements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON stock_lot_movements USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT ON stock_lots, stock_lot_movements TO onepos_app;--> statement-breakpoint
GRANT SELECT ON stock_lots, stock_lot_movements TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON stock_lots, stock_lot_movements TO onepos_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON stock_lots TO onepos_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON stock_lot_movements TO onepos_platform;--> statement-breakpoint
GRANT SELECT ON products, branches TO onepos_platform;--> statement-breakpoint
GRANT UPDATE (expiry_alert_days) ON inventory_settings TO onepos_app;--> statement-breakpoint

CREATE TRIGGER stock_lot_movements_append_only BEFORE UPDATE OR DELETE ON stock_lot_movements
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER stock_lots_no_delete BEFORE DELETE ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

CREATE FUNCTION app_track_stock_lots() RETURNS trigger
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

  need := -NEW.quantity;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT * INTO lot FROM stock_lots s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.lot_id FOR UPDATE;
    IF lot.branch_id IS DISTINCT FROM NEW.branch_id OR lot.variant_id IS DISTINCT FROM NEW.variant_id THEN
      RAISE EXCEPTION 'the lot named is not this item''s at this branch' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_named_lot_match';
    END IF;
    take := least(need, lot.quantity);
    IF take > 0 THEN
      UPDATE stock_lots SET quantity = quantity - take, updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = lot.id;
      INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity) VALUES (NEW.tenant_id, lot.id, NEW.id, -take);
      dated := dated - take;
      need := need - take;
    END IF;
  END IF;
  excess := least(dated - cap, need);
  IF excess > 0 THEN
    FOR lot IN
      SELECT * FROM stock_lots s
       WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id AND s.variant_id = NEW.variant_id AND s.quantity > 0
       ORDER BY s.expires_on, s.lot_code NULLS FIRST, s.id
       FOR UPDATE
    LOOP
      take := least(lot.quantity, excess);
      UPDATE stock_lots SET quantity = quantity - take, updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = lot.id;
      INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity) VALUES (NEW.tenant_id, lot.id, NEW.id, -take);
      excess := excess - take;
      EXIT WHEN excess <= 0;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER stock_movements_lots AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app_track_stock_lots();--> statement-breakpoint

CREATE FUNCTION platform_flag_expiring_lots() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN
    WITH due AS (
      UPDATE stock_lots s SET alerted_at = now()
        FROM branches b LEFT JOIN inventory_settings i ON i.tenant_id = b.tenant_id AND i.branch_id = b.id
       WHERE b.tenant_id = s.tenant_id AND b.id = s.branch_id
         AND s.alerted_at IS NULL AND s.quantity > 0
         AND coalesce(i.expiry_alert_days, 30) > 0
         AND s.expires_on <= (now() AT TIME ZONE b.timezone)::date + coalesce(i.expiry_alert_days, 30)
      RETURNING s.tenant_id, s.branch_id, s.expires_on, coalesce(i.expiry_alert_days, 30) AS days)
    SELECT tenant_id, branch_id, count(*)::int AS lots, min(expires_on) AS first, max(days) AS days FROM due GROUP BY 1, 2
  LOOP
    INSERT INTO outbox_events (tenant_id, topic, payload)
    VALUES (r.tenant_id, 'stock.expiring', jsonb_build_object('branchId', r.branch_id, 'lots', r.lots, 'firstExpiresOn', r.first, 'withinDays', r.days));
    n := n + r.lots;
  END LOOP;
  RETURN n;
END $$;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION app_track_stock_lots() OWNER TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION platform_flag_expiring_lots() OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_track_stock_lots() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_flag_expiring_lots() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_flag_expiring_lots() TO onepos_worker;
