-- Hand-written: identity RLS, grants, permission catalog seed, and the auth
-- SECURITY DEFINER functions. Credentials and sessions are never readable by the
-- runtime role directly; all access goes through the narrow functions below.

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- users --------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- Visible: yourself, and members of the current tenant (tenant_memberships is itself RLS-scoped).
CREATE POLICY users_visible ON users FOR SELECT
  USING (id = app_current_user_id() OR id IN (SELECT user_id FROM tenant_memberships));
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app_current_user_id()) WITH CHECK (id = app_current_user_id());
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
-- No password_hash / lockout columns for the runtime role.
GRANT SELECT (id, email, display_name, status, last_login_at, created_at, updated_at) ON users TO onepos_app, onepos_readonly;
GRANT UPDATE (display_name) ON users TO onepos_app;

-- user_sessions: no direct access for the runtime role at all.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;

-- permissions: global read-only catalog -----------------------------------------
GRANT SELECT ON permissions TO onepos_app, onepos_readonly;

INSERT INTO permissions (code, description) VALUES
  ('tenant.manage',            'Edit tenant profile and settings'),
  ('subscription.manage',      'Manage subscription plan and billing'),
  ('members.read',             'View team members'),
  ('members.manage',           'Invite, suspend and assign roles to members'),
  ('roles.read',               'View roles and permissions'),
  ('roles.manage',             'Create and edit custom roles'),
  ('org.read',                 'View legal entities, branches and registers'),
  ('org.manage',               'Manage legal entities, branches and registers'),
  ('terminals.manage',         'Register and revoke POS terminals'),
  ('tax.manage',               'Manage tax profiles and tax categories'),
  ('catalog.read',             'View products and categories'),
  ('catalog.manage',           'Create and edit products, variants and barcodes'),
  ('prices.manage',            'Manage price lists and prices'),
  ('sales.create',             'Ring up sales at a register'),
  ('sales.read',               'View sales and receipts'),
  ('sales.refund',             'Process returns and refunds'),
  ('sales.void',               'Void transactions'),
  ('sales.price_override',     'Override prices at checkout'),
  ('sales.discount',           'Apply manual discounts'),
  ('cash.session',             'Open and close own cashier session'),
  ('cash.reconcile',           'Approve cash reconciliation variances'),
  ('inventory.read',           'View stock levels and movements'),
  ('inventory.adjust',         'Post stock adjustments, counts and waste'),
  ('inventory.transfer',       'Create and receive stock transfers'),
  ('purchasing.manage',        'Manage suppliers, purchase orders and receiving'),
  ('restaurant.manage',        'Configure menus, modifiers, tables and stations'),
  ('restaurant.orders',        'Take and manage restaurant orders'),
  ('kitchen.operate',          'Operate the kitchen display'),
  ('customers.read',           'View customers'),
  ('customers.manage',         'Create and edit customers'),
  ('reports.read',             'View business reports'),
  ('accounting.read',          'View ledgers and financial reports'),
  ('accounting.post',          'Post manual journal entries and close periods'),
  ('audit.read',               'View the audit log'),
  ('integrations.manage',      'Manage integrations and API keys');

-- Tenant-scoped identity tables ----------------------------------------------------
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_memberships
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE TRIGGER tenant_memberships_touch_updated_at BEFORE UPDATE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
GRANT SELECT, INSERT ON tenant_memberships TO onepos_app;
GRANT UPDATE (status) ON tenant_memberships TO onepos_app;
GRANT SELECT ON tenant_memberships TO onepos_readonly;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON roles TO onepos_app;
GRANT UPDATE (name, archived_at) ON roles TO onepos_app;
GRANT SELECT ON roles TO onepos_readonly;

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, DELETE ON role_permissions TO onepos_app;
GRANT SELECT ON role_permissions TO onepos_readonly;

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_roles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, DELETE ON membership_roles TO onepos_app;
GRANT SELECT ON membership_roles TO onepos_readonly;

-- Auth functions (SECURITY DEFINER, owned by onepos_platform) ------------------------
GRANT SELECT, INSERT, UPDATE ON users, user_sessions TO onepos_platform;
GRANT SELECT ON tenant_memberships TO onepos_platform;

CREATE FUNCTION auth_register_user(p_email text, p_display_name text, p_password_hash text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_display_name IS NULL OR length(btrim(p_display_name)) = 0 OR length(p_display_name) > 200 THEN
    RAISE EXCEPTION 'invalid display name' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'password hash must be argon2id' USING ERRCODE = '22023';
  END IF;
  INSERT INTO users (email, display_name, password_hash)
  VALUES (lower(btrim(p_email)), btrim(p_display_name), p_password_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION auth_get_login_record(p_email text)
  RETURNS TABLE (user_id uuid, password_hash text, status text, locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, password_hash, status, locked_until FROM users WHERE lower(email) = lower(btrim(p_email))
$$;

-- Failure: count++, lock 1,2,4… minutes (capped at 60) from the 5th consecutive failure.
CREATE FUNCTION auth_record_login_result(p_user_id uuid, p_success boolean)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user_id;
  ELSE
    UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= 5
             THEN now() + least(60, power(2, failed_login_count + 1 - 5)::int) * interval '1 minute'
             ELSE locked_until END
     WHERE id = p_user_id;
  END IF;
END $$;

CREATE FUNCTION auth_list_memberships(p_user_id uuid)
  RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_slug text, tenant_name text, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, t.id, t.slug, t.name, t.status
    FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id AND m.status = 'ACTIVE' AND t.status IN ('ACTIVE', 'SUSPENDED')
   ORDER BY t.name
$$;

CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz, p_user_agent text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_family uuid := uuidv7();
BEGIN
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent)
  VALUES (p_user_id, v_family, p_token_hash, p_expires_at, left(p_user_agent, 300));
  RETURN v_family;
END $$;

-- Rotate a refresh token. Presenting an already-rotated or revoked token revokes the
-- whole family (token theft signal). Row lock makes concurrent refreshes safe: exactly
-- one wins, the other sees replaced_at and triggers reuse revocation.
CREATE FUNCTION auth_rotate_session(p_old_hash text, p_new_hash text, p_new_expires timestamptz)
  RETURNS TABLE (outcome text, user_id uuid, family_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s user_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM user_sessions WHERE refresh_token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF s.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'REVOKED'::text, s.user_id, s.family_id; RETURN;
  END IF;
  IF s.replaced_at IS NOT NULL THEN
    UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'REFRESH_TOKEN_REUSE'
     WHERE user_sessions.family_id = s.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'REUSED'::text, s.user_id, s.family_id; RETURN;
  END IF;
  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, s.user_id, s.family_id; RETURN;
  END IF;
  UPDATE user_sessions SET replaced_at = now() WHERE id = s.id;
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent)
  VALUES (s.user_id, s.family_id, p_new_hash, p_new_expires, s.user_agent);
  RETURN QUERY SELECT 'ROTATED'::text, s.user_id, s.family_id;
END $$;

CREATE FUNCTION auth_revoke_session(p_family_id uuid, p_user_id uuid, p_reason text)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = p_reason
   WHERE family_id = p_family_id AND user_id = p_user_id AND revoked_at IS NULL
$$;

-- Everything the request guard needs, in one round trip.
CREATE FUNCTION auth_resolve_context(p_user_id uuid, p_family_id uuid, p_tenant_id uuid)
  RETURNS TABLE (session_active boolean, user_active boolean, membership_id uuid, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_sessions s
             WHERE s.family_id = p_family_id AND s.user_id = p_user_id
               AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.expires_at > now()),
    EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.status = 'ACTIVE'),
    (SELECT m.id FROM tenant_memberships m
      WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE'),
    (SELECT t.status FROM tenants t WHERE t.id = p_tenant_id)
$$;

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_register_user(text, text, text)',
    'auth_get_login_record(text)',
    'auth_record_login_result(uuid, boolean)',
    'auth_list_memberships(uuid)',
    'auth_create_session(uuid, text, timestamptz, text)',
    'auth_rotate_session(text, text, timestamptz)',
    'auth_revoke_session(uuid, uuid, text)',
    'auth_resolve_context(uuid, uuid, uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_app', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
