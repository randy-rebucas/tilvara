-- Hand-written: recipes (Phase 4 slice 1, ADR-0014 §4).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipe_versions', 'recipe_ingredients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
    -- History is evidence: the version a sale consumed with must never change.
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
END $$;

-- A recipe version governs future sales only (5 minutes of clock-skew tolerance, as tax profiles),
-- and belongs to an item that does not track stock itself (it is made from tracked ingredients;
-- otherwise one sale would move stock twice).
CREATE FUNCTION app_recipe_version_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_from < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'recipe versions cannot be backdated' USING ERRCODE = '23514', CONSTRAINT = 'recipe_versions_not_backdated';
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
              WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id AND p.track_inventory) THEN
    RAISE EXCEPTION 'an item that tracks its own stock cannot have a recipe' USING ERRCODE = '23514', CONSTRAINT = 'recipe_versions_item_untracked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipe_versions_rules BEFORE INSERT ON recipe_versions
  FOR EACH ROW EXECUTE FUNCTION app_recipe_version_rules();

-- Ingredients are stock items: their consumption is a costed movement in the stock ledger.
CREATE FUNCTION app_recipe_ingredient_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
                  WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.ingredient_variant_id AND p.track_inventory) THEN
    RAISE EXCEPTION 'a recipe ingredient must be an item that tracks stock' USING ERRCODE = '23514', CONSTRAINT = 'recipe_ingredients_tracked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipe_ingredients_rules BEFORE INSERT ON recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION app_recipe_ingredient_rules();

CREATE INDEX stock_movements_sale_line_idx ON stock_movements (tenant_id, sale_line_id) WHERE sale_line_id IS NOT NULL;
