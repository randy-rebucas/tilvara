-- Hand-written: stock reservations and the supplier catalog (session 20).
ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_reservations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON stock_reservations USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE supplier_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_items USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON stock_reservations, supplier_items TO onepos_app;--> statement-breakpoint
GRANT UPDATE (status, released_by, released_at, release_reason) ON stock_reservations TO onepos_app;--> statement-breakpoint
GRANT UPDATE (supplier_sku, supplier_item_name, unit_cost, preferred, updated_at, archived_at) ON supplier_items TO onepos_app;--> statement-breakpoint
GRANT SELECT ON stock_reservations, supplier_items TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON stock_reservations, supplier_items TO onepos_worker;--> statement-breakpoint

-- A reservation is released once, and nothing else about it changes; it is never deleted.
CREATE OR REPLACE FUNCTION app_stock_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_reservations rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED'
     OR (to_jsonb(NEW) - ARRAY['status','released_by','released_at','release_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','released_by','released_at','release_reason']) THEN
    RAISE EXCEPTION 'a reservation is only released, once' USING ERRCODE = '23514', CONSTRAINT = 'stock_reservations_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stock_reservations_transition BEFORE UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW EXECUTE FUNCTION app_stock_reservation_transition();--> statement-breakpoint

-- Supplier catalog rows are archived, never deleted (purchase orders may point at what they said).
CREATE TRIGGER supplier_items_no_delete BEFORE DELETE ON supplier_items
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
