-- Lot holds stop a sale at every branch (session 36, retail fit audit). Until now a held lot (a recall)
-- was drawn last, and an online sale from it refused, only where the branch's expired-stock rule was
-- BLOCK, a default of the pharmacies; most retail branches have no setting (= ALLOW), so a hold did
-- nothing at the till. Now held lots are drawn last by every sale and pack opening; expired lots still
-- only where the branch says BLOCK. The API refuses an online sale that only held stock could fill
-- (`assertNotExpired`). Only the function changes: no data, no grants (it keeps its owner and
-- SECURITY DEFINER), and `stock_lot_movements.expired` is marked as before (expired or held).
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
  sale_like boolean;
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
  blocked := coalesce(blocked, false);
  sale_like := NEW.type IN ('SALE', 'CONSUMPTION', 'UNPACK_OUT');

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
       ORDER BY CASE WHEN sale_like AND ((blocked AND s.expires_on < today) OR app_lot_held(s.tenant_id, s.branch_id, s.variant_id, s.lot_code)) THEN 1 ELSE 0 END,
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
