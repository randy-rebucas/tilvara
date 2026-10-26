-- Hand-written (ADR-0026): extensions. DDL is in 0114.
-- * extensions: the global catalog, read-only to tenants (like plans and permissions). Empty until the
--   first extension's migration inserts its row, its permission rows and the plans that allow it.
-- * tenant_extensions: tenant RLS; switched on and off in place by the API (audited), never deleted.
-- * app_extension_usable(code) / app_usable_extensions(): enabled, active in the catalog and allowed by
--   the current plan. SECURITY INVOKER: they read under the caller's tenant policy.
-- * Switching one bumps the catalog version, so tills fetch a snapshot with the new list (0065).

GRANT SELECT ON extensions TO onepos_app, onepos_readonly, onepos_platform;--> statement-breakpoint

ALTER TABLE tenant_extensions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_extensions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_extensions USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (enabled, changed_by, changed_at) ON tenant_extensions TO onepos_app;--> statement-breakpoint
GRANT SELECT ON tenant_extensions TO onepos_readonly, onepos_worker;--> statement-breakpoint
CREATE TRIGGER tenant_extensions_no_delete BEFORE DELETE ON tenant_extensions FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER tenant_extensions_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON tenant_extensions FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version();--> statement-breakpoint

CREATE FUNCTION app_usable_extensions() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(te.extension_code ORDER BY te.extension_code), '{}')
    FROM tenant_extensions te
    JOIN extensions e ON e.code = te.extension_code AND e.active
   WHERE te.enabled
     AND EXISTS (SELECT 1 FROM subscriptions s JOIN plans p ON p.code = s.plan_code
                  WHERE p.extensions ? te.extension_code)
$$;--> statement-breakpoint

CREATE FUNCTION app_extension_usable(code text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT code = ANY (app_usable_extensions())
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_usable_extensions(), app_extension_usable(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_usable_extensions(), app_extension_usable(text) TO onepos_app, onepos_readonly;
