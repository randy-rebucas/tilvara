-- Hand-written: price overrides, held carts and exchange credits (session 20, counter controls).
ALTER TABLE price_overrides ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE price_overrides FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON price_overrides USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE held_carts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE held_carts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON held_carts USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON price_overrides, held_carts TO onepos_app;--> statement-breakpoint
GRANT UPDATE (status, closed_by, closed_at, lines, beneficiaries) ON held_carts TO onepos_app;--> statement-breakpoint
GRANT SELECT ON price_overrides, held_carts TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON price_overrides, held_carts TO onepos_worker;--> statement-breakpoint

-- An approval is evidence: append-only.
CREATE TRIGGER price_overrides_append_only BEFORE UPDATE OR DELETE ON price_overrides
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- A sale line at an approved price: the approval is for this item at this branch, at this price.
CREATE OR REPLACE FUNCTION app_sale_line_price_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_override_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_overrides o JOIN sales s ON s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.price_override_id
       AND o.variant_id = NEW.variant_id AND o.unit_price = NEW.unit_price AND o.branch_id = s.branch_id
  ) THEN
    RAISE EXCEPTION 'the price override does not match this sale line'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_lines_price_override_match';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER sale_lines_price_override BEFORE INSERT ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION app_sale_line_price_override();--> statement-breakpoint

-- An exchange credit is the refund of a return of the same branch, and no more than that refund.
CREATE OR REPLACE FUNCTION app_sale_tender_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exchange_return_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sale_returns r JOIN sales s ON s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id
     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.exchange_return_id
       AND r.branch_id = s.branch_id AND r.cashier_session_id = s.cashier_session_id AND NEW.tendered = r.amount_due
  ) THEN
    RAISE EXCEPTION 'the exchange credit does not match its return'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_tenders_exchange_match';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER sale_tenders_exchange BEFORE INSERT ON sale_tenders
  FOR EACH ROW EXECUTE FUNCTION app_sale_tender_exchange();--> statement-breakpoint

-- A held cart only goes OPEN → RESUMED or DISCARDED, once, and gives up its lines and SC/PWD details when it does.
CREATE OR REPLACE FUNCTION app_held_cart_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'held_carts rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'OPEN' OR NEW.status NOT IN ('RESUMED', 'DISCARDED')
     OR NEW.lines <> '[]'::jsonb OR NEW.beneficiaries <> '[]'::jsonb
     OR (to_jsonb(NEW) - ARRAY['status','closed_by','closed_at','lines','beneficiaries']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','closed_by','closed_at','lines','beneficiaries']) THEN
    RAISE EXCEPTION 'a held cart is resumed or discarded once, and its lines are cleared'
      USING ERRCODE = '23514', CONSTRAINT = 'held_carts_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER held_carts_transition BEFORE UPDATE OR DELETE ON held_carts
  FOR EACH ROW EXECUTE FUNCTION app_held_cart_transition();
