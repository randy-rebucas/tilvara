-- Hand-written: RLS, grants and integrity triggers for catalog & pricing.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units_of_measure', 'tax_categories', 'categories', 'products', 'product_variants',
                           'barcodes', 'price_lists', 'branch_price_lists', 'product_prices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Master data referenced by history is archived, never deleted.
  FOREACH t IN ARRAY ARRAY['units_of_measure', 'tax_categories', 'categories', 'products', 'product_variants',
                           'barcodes', 'price_lists'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()',
      t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['categories', 'products', 'product_variants', 'branch_price_lists'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;

-- Prices are versioned history: append-only.
CREATE TRIGGER product_prices_append_only BEFORE UPDATE OR DELETE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

GRANT SELECT, INSERT ON units_of_measure TO onepos_app;
GRANT UPDATE (name, allows_fraction, archived_at) ON units_of_measure TO onepos_app;
GRANT SELECT, INSERT ON tax_categories TO onepos_app;
-- vat_treatment is immutable once created (historical meaning); create a new category instead.
GRANT UPDATE (name, archived_at) ON tax_categories TO onepos_app;
GRANT SELECT, INSERT ON categories TO onepos_app;
GRANT UPDATE (parent_id, name, sort_order, archived_at) ON categories TO onepos_app;
GRANT SELECT, INSERT ON products TO onepos_app;
GRANT UPDATE (category_id, tax_category_id, name, description, track_inventory, archived_at) ON products TO onepos_app;
GRANT SELECT, INSERT ON product_variants TO onepos_app;
GRANT UPDATE (name, attributes, reference_cost, archived_at) ON product_variants TO onepos_app;
GRANT SELECT, INSERT ON barcodes TO onepos_app;
GRANT UPDATE (archived_at) ON barcodes TO onepos_app;
GRANT SELECT, INSERT ON price_lists TO onepos_app;
GRANT UPDATE (name, prices_include_tax, is_default, archived_at) ON price_lists TO onepos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_price_lists TO onepos_app;
GRANT SELECT, INSERT ON product_prices TO onepos_app;

-- Category tree: no cycles, max depth 5.
CREATE FUNCTION app_category_tree_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cur uuid := NEW.parent_id;
  depth int := 1;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'category cycle detected' USING ERRCODE = '23514';
    END IF;
    depth := depth + 1;
    IF depth > 5 THEN
      RAISE EXCEPTION 'category tree deeper than 5 levels' USING ERRCODE = '23514';
    END IF;
    SELECT parent_id INTO cur FROM categories WHERE tenant_id = NEW.tenant_id AND id = cur;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER categories_tree_guard BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION app_category_tree_guard();
