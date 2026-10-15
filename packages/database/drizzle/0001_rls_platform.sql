-- Hand-written: tenant context helpers, RLS, append-only enforcement, grants,
-- and the platform tenant-provisioning function. See ADR-0004.

-- Current tenant from the transaction-local setting. Unset/empty -> NULL -> policies match nothing.
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Generic guard for append-only tables (financial, inventory, audit).
CREATE FUNCTION app_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'Record a correcting entry instead.';
END
$$;

CREATE FUNCTION app_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- tenants ------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

CREATE TRIGGER tenants_touch_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER tenants_no_delete BEFORE DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Tenants may rename themselves / change timezone; status & currency are platform-controlled.
GRANT SELECT ON tenants TO onepos_app, onepos_readonly;
GRANT UPDATE (name, timezone) ON tenants TO onepos_app;

-- audit_logs ---------------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

GRANT SELECT, INSERT ON audit_logs TO onepos_app;
GRANT SELECT ON audit_logs TO onepos_readonly;

-- Platform provisioning -------------------------------------------------------
-- Runs as onepos_platform (BYPASSRLS). Validates input itself; records an audit event.
CREATE FUNCTION platform_create_tenant(p_slug text, p_name text, p_timezone text, p_currency text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'invalid tenant name' USING ERRCODE = '22023';
  END IF;
  IF p_currency NOT IN ('PHP', 'USD', 'JPY') THEN
    RAISE EXCEPTION 'unsupported currency %', p_currency USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'unknown timezone %', p_timezone USING ERRCODE = '22023';
  END IF;

  INSERT INTO tenants (slug, name, status, default_currency, timezone)
  VALUES (p_slug, btrim(p_name), 'ACTIVE', p_currency, p_timezone)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (
    v_id, 'SYSTEM', NULLIF(current_setting('app.user_id', true), '')::uuid,
    'tenant.created', 'tenant', v_id::text,
    NULLIF(current_setting('app.correlation_id', true), ''),
    jsonb_build_object('slug', p_slug)
  );
  RETURN v_id;
END
$$;

GRANT SELECT, INSERT ON tenants TO onepos_platform;
GRANT SELECT, INSERT ON audit_logs TO onepos_platform;
-- Changing owner requires the new owner to hold CREATE on the schema; grant it only for the change.
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION platform_create_tenant(text, text, text, text) OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION platform_create_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text) TO onepos_app;
