-- Audit 2026-10-21, second part (docs/AUDIT-2026-10-21.md §3–§4).

-- 1. Voiding a check gives its share of the bill back (ADR-0014 §8): a check sale voided (a VOID return)
--    no longer counts as paid. Its allocations stay as evidence, but the bill line may be paid again, a
--    settled bill becomes ACTIVE again and its order BILLED again, so the guest can be charged correctly.
CREATE OR REPLACE FUNCTION app_order_bill_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SETTLED' AND NEW.status = 'ACTIVE' THEN
    IF NOT EXISTS (SELECT 1 FROM order_bill_allocations a JOIN sale_returns r ON r.tenant_id = a.tenant_id AND r.sale_id = a.sale_id AND r.kind = 'VOID'
                    WHERE a.tenant_id = NEW.tenant_id AND a.order_bill_id = NEW.id) THEN
      RAISE EXCEPTION 'a settled bill reopens only when one of its checks is voided' USING ERRCODE = '23514', CONSTRAINT = 'order_bills_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('SETTLED', 'VOIDED') THEN
    RAISE EXCEPTION 'a % bill cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'order_bills_transition';
  END IF;
  IF NEW.status = 'VOIDED' AND EXISTS (
       SELECT 1 FROM order_bill_allocations a WHERE a.tenant_id = NEW.tenant_id AND a.order_bill_id = NEW.id
          AND NOT EXISTS (SELECT 1 FROM sale_returns r WHERE r.tenant_id = a.tenant_id AND r.sale_id = a.sale_id AND r.kind = 'VOID')) THEN
    RAISE EXCEPTION 'a bill with paid checks cannot be reopened' USING ERRCODE = '23514', CONSTRAINT = 'order_bills_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_order_bill_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
  n numeric := 0;
  d numeric := 1;
  g numeric;
  r record;
BEGIN
  SELECT status INTO bill_status FROM order_bills WHERE tenant_id = NEW.tenant_id AND id = NEW.order_bill_id FOR UPDATE;
  IF bill_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'only an active bill can be paid' USING ERRCODE = '23514', CONSTRAINT = 'order_bill_allocations_bill_active';
  END IF;
  -- Shares of voided checks are no longer paid.
  FOR r IN SELECT a.share_num, a.share_den FROM order_bill_allocations a
            WHERE a.tenant_id = NEW.tenant_id AND a.bill_line_id = NEW.bill_line_id
              AND NOT EXISTS (SELECT 1 FROM sale_returns x WHERE x.tenant_id = a.tenant_id AND x.sale_id = a.sale_id AND x.kind = 'VOID')
           UNION ALL SELECT NEW.share_num, NEW.share_den LOOP
    n := n * r.share_den + r.share_num * d;
    d := d * r.share_den;
    g := gcd(n, d);
    n := n / g;
    d := d / g;
  END LOOP;
  IF n > d THEN
    RAISE EXCEPTION 'a bill line cannot be paid more than once' USING ERRCODE = '23514', CONSTRAINT = 'order_bill_allocations_within_line';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_restaurant_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A settled table order goes back to BILLED when its bill is reopened by a voided check; nothing else changes.
  IF OLD.status = 'SETTLED' AND NEW.status = 'BILLED' AND OLD.order_type <> 'COUNTER'
     AND (to_jsonb(NEW) - ARRAY['status', 'closed_at', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'closed_at', 'updated_at'])
     AND EXISTS (SELECT 1 FROM order_bills b WHERE b.tenant_id = NEW.tenant_id AND b.order_id = NEW.id AND b.status = 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('SETTLED', 'CANCELLED', 'MERGED') THEN
    RAISE EXCEPTION 'a % order cannot change', lower(OLD.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  IF NEW.order_type <> OLD.order_type OR NEW.sale_id IS DISTINCT FROM OLD.sale_id THEN
    RAISE EXCEPTION 'an order keeps its type and sale' USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.order_type = 'COUNTER' AND OLD.status = 'OPEN' AND NEW.status = 'SETTLED')
    OR (OLD.order_type <> 'COUNTER' AND OLD.status = 'OPEN' AND NEW.status IN ('BILLED', 'CANCELLED', 'MERGED'))
    OR (OLD.order_type <> 'COUNTER' AND OLD.status = 'BILLED' AND NEW.status IN ('OPEN', 'SETTLED'))) THEN
    RAISE EXCEPTION 'an % order cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 2. A VOID slip for a kitchen that works from paper (session 25): an item voided after its ticket was
--    printed asks the station's till to print what was voided (claimed, printed and released like a ticket).
ALTER TABLE kitchen_tickets ADD COLUMN void_print_requested_at timestamp with time zone;--> statement-breakpoint
ALTER TABLE kitchen_tickets ADD COLUMN void_printed_at timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (void_print_requested_at, void_printed_at) ON kitchen_tickets TO onepos_app;--> statement-breakpoint

-- 3. An item marked sold out, or available again, reaches offline tills with their next snapshot.
CREATE TRIGGER sold_out_items_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON sold_out_items
  FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version();--> statement-breakpoint

-- 4. Expired or held lots are not sold by default where prescription medicines are (ADR-0025 §4, audit
--    decision A2): PHARMACY and HYBRID, unless the branch's inventory settings say otherwise.
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
         coalesce(i.expired_stock, CASE WHEN t.business_type IN ('PHARMACY', 'HYBRID') THEN 'BLOCK' ELSE 'ALLOW' END) = 'BLOCK'
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
END $$;
