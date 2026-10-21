-- Hand-written (session 26, ADR-0021): retail stores and boutiques. DDL is in 0096.
-- * promotions: tenant RLS; the terms never change once made (only the name, and ending it no earlier
--   than now); never deleted. Items and branches are written with the promotion and never changed.
-- * item_locations: a shelf label per (branch, item); ordinary mutable reference data.
-- * product_variants.quick_key_position: the app may set it.
-- * The till's snapshot carries promotions: their tables bump the catalog version.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promotions', 'promotion_items', 'promotion_branches', 'item_locations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly, onepos_worker', t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (name, ends_at, updated_at) ON promotions TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON promotion_items, promotion_branches TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (location, updated_by, updated_at), DELETE ON item_locations TO onepos_app;--> statement-breakpoint
GRANT UPDATE (quick_key_position) ON product_variants TO onepos_app;--> statement-breakpoint

CREATE TRIGGER promotion_items_append_only BEFORE UPDATE OR DELETE ON promotion_items FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER promotion_branches_append_only BEFORE UPDATE OR DELETE ON promotion_branches FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER promotions_no_delete BEFORE DELETE ON promotions FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- Ending is the only change to a promotion's window, once, and never back in time (a sale already
-- priced by it must re-price the same). The skew allowance matches `effectiveNowSql`.
CREATE FUNCTION app_promotion_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.price IS DISTINCT FROM OLD.price
     OR NEW.buy_quantity IS DISTINCT FROM OLD.buy_quantity OR NEW.get_quantity IS DISTINCT FROM OLD.get_quantity
     OR NEW.get_rate IS DISTINCT FROM OLD.get_rate OR NEW.tiers IS DISTINCT FROM OLD.tiers OR NEW.all_branches IS DISTINCT FROM OLD.all_branches
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a promotion''s terms never change; end it and make a new one' USING ERRCODE = '23514', CONSTRAINT = 'promotions_terms_immutable';
  END IF;
  IF NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF NEW.ends_at IS NULL OR (OLD.ends_at IS NOT NULL AND OLD.ends_at <= now())
       OR NEW.ends_at < now() - interval '5 seconds' AND NEW.ends_at <> NEW.starts_at THEN
      RAISE EXCEPTION 'a promotion ends now or later, and only while it runs' USING ERRCODE = '23514', CONSTRAINT = 'promotions_terms_immutable';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER promotions_terms BEFORE UPDATE ON promotions FOR EACH ROW EXECUTE FUNCTION app_promotion_terms();--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promotions', 'promotion_items', 'promotion_branches'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version()',
                   t || '_bump_catalog_version', t);
  END LOOP;
END $$;
