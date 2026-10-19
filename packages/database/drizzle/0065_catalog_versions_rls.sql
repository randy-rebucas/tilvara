-- Hand-written: catalog version for tills (session 16; ADR-0015 amendment). A statement trigger on
-- every table a terminal snapshot is made of bumps the business's counter once per statement (the
-- tenant comes from the transaction's app.tenant_id; writes outside a tenant, e.g. a migration's
-- back-fill, bump nothing). Tills compare it with the version their snapshot was taken at.

ALTER TABLE catalog_versions ADD CONSTRAINT catalog_versions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id);
ALTER TABLE catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalog_versions USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT ON catalog_versions TO onepos_app, onepos_readonly, onepos_worker;

CREATE FUNCTION app_bump_catalog_version() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid := app_current_tenant_id();
BEGIN
  IF t IS NOT NULL THEN
    INSERT INTO catalog_versions (tenant_id, version, changed_at) VALUES (t, 1, now())
    ON CONFLICT (tenant_id) DO UPDATE SET version = catalog_versions.version + 1, changed_at = now();
  END IF;
  RETURN NULL;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION app_bump_catalog_version() OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION app_bump_catalog_version() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON catalog_versions TO onepos_platform;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'product_variants', 'barcodes', 'product_prices', 'price_lists', 'branch_price_lists',
                           'tax_categories', 'units_of_measure', 'tax_profiles', 'legal_entities', 'branches', 'registers'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version()',
                   t || '_bump_catalog_version', t);
  END LOOP;
END $$;
