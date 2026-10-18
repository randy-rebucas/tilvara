-- Hand-written: onboarding and support (Phase 6 slice 6, ADR-0016).
-- * support_grants: a business gives 1POS support read-only access for at most 72 hours, for a
--   stated purpose; revocable at once; never deleted.
-- * platform_staff: who may use a grant. A platform table (no runtime grants), managed by the ops
--   CLI as the migrator; read only through the support_* / auth_* functions below.
-- * data_exports: a business's copy of its records, made by the worker (onepos_worker) from one
--   snapshot. The worker may now read every exported tenant table, under RLS and inside the
--   tenant of the outbox event (never across tenants), and still writes no table directly.

-- 1. Tenant tables --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_grants', 'data_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON support_grants TO onepos_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON support_grants TO onepos_app;

-- A grant only ever changes once: it is revoked. Its terms are fixed when given.
CREATE FUNCTION app_support_grant_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'this support access was already ended' USING ERRCODE = '23514', CONSTRAINT = 'support_grants_transition';
  END IF;
  IF NEW.revoked_at IS NULL OR (NEW.id, NEW.tenant_id, NEW.purpose, NEW.ticket_ref, NEW.access, NEW.granted_by, NEW.granted_at, NEW.expires_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.purpose, OLD.ticket_ref, OLD.access, OLD.granted_by, OLD.granted_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'support access can only be ended, not changed' USING ERRCODE = '23514', CONSTRAINT = 'support_grants_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_grants_transition BEFORE UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION app_support_grant_transition();

-- The API records requests; only the worker's functions move an export on.
GRANT SELECT, INSERT ON data_exports TO onepos_app;
CREATE FUNCTION app_data_export_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.status = 'REQUESTED' AND NEW.status IN ('READY', 'FAILED')) OR (OLD.status = 'READY' AND NEW.status = 'EXPIRED')) THEN
    RAISE EXCEPTION 'a % data export cannot become %', lower(OLD.status), lower(NEW.status)
      USING ERRCODE = '23514', CONSTRAINT = 'data_exports_transition';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'who asked for an export and when never changes' USING ERRCODE = '23514', CONSTRAINT = 'data_exports_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_exports_transition BEFORE UPDATE ON data_exports
  FOR EACH ROW EXECUTE FUNCTION app_data_export_transition();

-- 2. Platform staff -------------------------------------------------------------------------
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff FORCE ROW LEVEL SECURITY;
-- No policy and no grant to any login role: only the functions below (owned by onepos_platform).

GRANT SELECT, INSERT, UPDATE ON platform_staff TO onepos_platform;
GRANT SELECT ON support_grants TO onepos_platform;
GRANT SELECT, UPDATE ON data_exports TO onepos_platform;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- Ops CLI (migrator only): add or re-activate a staff account. It must already use two-step
-- sign-in, and every support session also needs a session that passed it.
CREATE FUNCTION support_staff_add(p_email text, p_actor text, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'actor and reason are required' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_user FROM users WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE';
  IF v_user IS NULL THEN RAISE EXCEPTION 'no active account with that email' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_mfa_factors WHERE user_id = v_user AND confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'turn on two-step sign-in for this account first' USING ERRCODE = '22023';
  END IF;
  INSERT INTO platform_staff (user_id, status, added_by, added_reason)
  VALUES (v_user, 'ACTIVE', left(btrim(p_actor), 100), left(btrim(p_reason), 500))
  ON CONFLICT (user_id) DO UPDATE
    SET status = 'ACTIVE', added_by = EXCLUDED.added_by, added_reason = EXCLUDED.added_reason, added_at = now(),
        disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'platform.staff.added', 'user', v_user::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500)));
  RETURN v_user;
END $$;

-- Ops CLI: disable a staff account. Any support session it holds stops at its next request.
CREATE FUNCTION support_staff_disable(p_email text, p_actor text, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'actor and reason are required' USING ERRCODE = '22023';
  END IF;
  UPDATE platform_staff s SET status = 'DISABLED', disabled_at = now(), disabled_by = left(btrim(p_actor), 100),
                              disabled_reason = left(btrim(p_reason), 500)
    FROM users u
   WHERE u.id = s.user_id AND lower(u.email) = lower(btrim(p_email)) AND s.status = 'ACTIVE'
  RETURNING s.user_id INTO v_user;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'platform.staff.disabled', 'user', v_user::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500)));
  RETURN v_user;
END $$;

CREATE FUNCTION support_staff_list()
  RETURNS TABLE (user_id uuid, email text, display_name text, status text, added_at timestamptz, added_by text, disabled_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, u.email, u.display_name, s.status, s.added_at, s.added_by, s.disabled_at
    FROM platform_staff s JOIN users u ON u.id = s.user_id ORDER BY s.status, u.email
$$;

-- 3. Using a grant (runtime role) -----------------------------------------------------------
CREATE FUNCTION auth_staff_active(p_user uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM platform_staff s JOIN users u ON u.id = s.user_id
                  WHERE s.user_id = p_user AND s.status = 'ACTIVE' AND u.status = 'ACTIVE')
$$;

-- Open grants, across businesses, for an active staff member (none for anyone else).
CREATE FUNCTION support_list_grants(p_user uuid)
  RETURNS TABLE (grant_id uuid, tenant_id uuid, tenant_name text, tenant_slug text, purpose text, ticket_ref text,
                 granted_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id, g.tenant_id, t.name, t.slug, g.purpose, g.ticket_ref, g.granted_at, g.expires_at
    FROM support_grants g JOIN tenants t ON t.id = g.tenant_id
   WHERE auth_staff_active(p_user)
     AND g.revoked_at IS NULL AND g.expires_at > now() AND t.status IN ('ACTIVE', 'SUSPENDED')
   ORDER BY g.expires_at
$$;

-- Start a support session on a grant: an active staff member, in a live session that passed
-- two-step sign-in, on a grant that is still open. Recorded in the business's audit log (it sees
-- who and when) and at platform level. No row when any condition fails.
CREATE FUNCTION support_open_grant(p_user uuid, p_family uuid, p_grant uuid, p_correlation_id text)
  RETURNS TABLE (tenant_id uuid, tenant_name text, expires_at timestamptz, purpose text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g record; v_name text; v_email text;
BEGIN
  IF NOT auth_staff_active(p_user) OR NOT EXISTS (
       SELECT 1 FROM user_sessions s WHERE s.family_id = p_family AND s.user_id = p_user AND s.revoked_at IS NULL
          AND s.replaced_at IS NULL AND s.expires_at > now() AND s.mfa_verified_at IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT sg.id, sg.tenant_id, sg.expires_at, sg.purpose, t.name INTO g
    FROM support_grants sg JOIN tenants t ON t.id = sg.tenant_id
   WHERE sg.id = p_grant AND sg.revoked_at IS NULL AND sg.expires_at > now() AND t.status IN ('ACTIVE', 'SUSPENDED');
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.display_name, u.email INTO v_name, v_email FROM users u WHERE u.id = p_user;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (g.tenant_id, 'SUPPORT', p_user, 'support.session_opened', 'support_grant', g.id::text, left(p_correlation_id, 200),
          jsonb_build_object('staffName', v_name, 'staffEmail', v_email)),
         (NULL, 'SUPPORT', p_user, 'platform.support.opened', 'support_grant', g.id::text, left(p_correlation_id, 200),
          jsonb_build_object('tenantId', g.tenant_id));
  RETURN QUERY SELECT g.tenant_id, g.name, g.expires_at, g.purpose;
END $$;

-- Every request made with a support token (AuthGuard): is it still allowed?
CREATE FUNCTION auth_resolve_support(p_user uuid, p_family uuid, p_grant uuid)
  RETURNS TABLE (session_active boolean, session_mfa boolean, staff_active boolean, staff_name text,
                 tenant_id uuid, tenant_status text, grant_open boolean, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_sessions s WHERE s.family_id = p_family AND s.user_id = p_user AND s.revoked_at IS NULL
               AND s.replaced_at IS NULL AND s.expires_at > now()),
    EXISTS (SELECT 1 FROM user_sessions s WHERE s.family_id = p_family AND s.user_id = p_user AND s.revoked_at IS NULL
               AND s.replaced_at IS NULL AND s.mfa_verified_at IS NOT NULL),
    auth_staff_active(p_user),
    (SELECT u.display_name FROM users u WHERE u.id = p_user),
    g.tenant_id,
    t.status,
    coalesce(g.revoked_at IS NULL AND g.expires_at > now(), false),
    g.expires_at
  FROM (SELECT 1) one
  LEFT JOIN support_grants g ON g.id = p_grant
  LEFT JOIN tenants t ON t.id = g.tenant_id
$$;

-- 4. Data exports (worker) ------------------------------------------------------------------
-- The tenant is the outbox event's (app.tenant_id set by withTenant), never a parameter.
CREATE FUNCTION data_export_finish(p_id uuid, p_file_key text, p_size bigint, p_sha256 text, p_row_counts jsonb, p_expires_at timestamptz)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := app_current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501'; END IF;
  UPDATE data_exports SET status = 'READY', completed_at = now(), file_key = p_file_key, size_bytes = p_size,
                          sha256 = p_sha256, row_counts = p_row_counts, expires_at = p_expires_at
   WHERE tenant_id = v_tenant AND id = p_id AND status = 'REQUESTED';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (v_tenant, 'SYSTEM', 'data_export.ready', 'data_export', p_id::text,
          jsonb_build_object('sizeBytes', p_size, 'sha256', p_sha256, 'expiresAt', p_expires_at));
  RETURN true;
END $$;

CREATE FUNCTION data_export_fail(p_id uuid, p_error text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := app_current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501'; END IF;
  UPDATE data_exports SET status = 'FAILED', completed_at = now(), error = left(p_error, 500)
   WHERE tenant_id = v_tenant AND id = p_id AND status = 'REQUESTED';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (v_tenant, 'SYSTEM', 'data_export.failed', 'data_export', p_id::text, jsonb_build_object('error', left(p_error, 500)));
  RETURN true;
END $$;

-- The worker's hourly sweep: files past their date are deleted, then the export marked EXPIRED.
CREATE FUNCTION data_export_due_expiry(p_limit int)
  RETURNS TABLE (tenant_id uuid, id uuid, file_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.tenant_id, e.id, e.file_key FROM data_exports e
   WHERE e.status = 'READY' AND e.expires_at <= now() ORDER BY e.expires_at LIMIT least(greatest(p_limit, 1), 500)
$$;

CREATE FUNCTION data_export_mark_expired(p_tenant uuid, p_id uuid)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE data_exports SET status = 'EXPIRED' WHERE tenant_id = p_tenant AND id = p_id AND status = 'READY' AND expires_at <= now();
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (p_tenant, 'SYSTEM', 'data_export.expired', 'data_export', p_id::text, '{}'::jsonb);
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'support_staff_add(text, text, text)', 'support_staff_disable(text, text, text)', 'support_staff_list()',
    'auth_staff_active(uuid)', 'support_list_grants(uuid)', 'support_open_grant(uuid, uuid, uuid, text)',
    'auth_resolve_support(uuid, uuid, uuid)',
    'data_export_finish(uuid, text, bigint, text, jsonb, timestamptz)', 'data_export_fail(uuid, text)',
    'data_export_due_expiry(int)', 'data_export_mark_expired(uuid, uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION support_staff_add(text, text, text), support_staff_disable(text, text, text), support_staff_list() TO onepos_migrator;
GRANT EXECUTE ON FUNCTION auth_staff_active(uuid), support_list_grants(uuid), support_open_grant(uuid, uuid, uuid, text),
  auth_resolve_support(uuid, uuid, uuid) TO onepos_app;
GRANT EXECUTE ON FUNCTION data_export_finish(uuid, text, bigint, text, jsonb, timestamptz), data_export_fail(uuid, text),
  data_export_due_expiry(int), data_export_mark_expired(uuid, uuid) TO onepos_worker;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;

-- 5. What the export reads (worker, under RLS) ---------------------------------------------
-- Every tenant table except internal machinery (EXPORT_EXCLUDED_TABLES in src/export/tables.ts)
-- and secret columns (EXPORT_SECRET_COLUMNS). A later tenant table needs its own GRANT here-after;
-- rls-catalog.test.ts fails until it has one.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname NOT IN ('idempotency_records', 'outbox_events', 'sequence_counters', 'terminals', 'member_invitations')
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO onepos_worker', t);
  END LOOP;
END $$;
GRANT SELECT (id, tenant_id, register_id, name, status, credential_hint, last_seen_at, revoked_at, revoke_reason, created_at)
  ON terminals TO onepos_worker;
GRANT SELECT (id, tenant_id, email, roles, status, invited_by, expires_at, accepted_at, accepted_user_id, revoked_at, created_at)
  ON member_invitations TO onepos_worker;
GRANT SELECT (default_currency, timezone, status) ON tenants TO onepos_worker;
