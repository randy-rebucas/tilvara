-- Hand-written: resetting a member's two-step sign-in (session 10; ADR-0016 slice 6 groundwork).
-- * auth_mfa_admin_reset(): an owner/admin (members.manage for the whole business) resets another
--   member of the *current* business (app.tenant_id from withTenant, never a parameter). The member
--   keeps their password; their sessions end; a privileged member must set up a new factor at the
--   next sign-in (business pages stay closed until then). Not for oneself: use a recovery code.
-- * auth_mfa_support_reset(): an owner who lost both phone and recovery codes, by the support
--   procedure (docs/operations/support-mfa-reset.md) with a ticket reference. Only the migrator
--   (ops credentials) may run it; never the runtime role.
-- * auth_members_mfa(): who in the current business has two-step sign-in on (for the member page).
-- Every reset writes a NULL-tenant audit row (the business sees its own member.mfa_reset row too).

GRANT SELECT ON membership_roles, role_permissions TO onepos_platform;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

CREATE FUNCTION auth_mfa_admin_reset(p_target uuid, p_actor uuid, p_reason text, p_correlation_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := app_current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_forbidden'; END IF;
  IF p_target = p_actor THEN
    RAISE EXCEPTION 'use a recovery code to reset your own two-step sign-in' USING ERRCODE = '22023', CONSTRAINT = 'mfa_reset_self';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
      JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
      JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
     WHERE m.tenant_id = v_tenant AND m.user_id = p_actor AND m.status = 'ACTIVE'
       AND mr.scope_type = 'TENANT' AND rp.permission_code = 'members.manage') THEN
    RAISE EXCEPTION 'only someone who manages the whole team can reset two-step sign-in' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = v_tenant AND user_id = p_target AND status <> 'REMOVED') THEN
    RAISE EXCEPTION 'not a member of this business' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_not_member';
  END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_target;
  DELETE FROM user_mfa_factors WHERE user_id = p_target;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'MFA_RESET' WHERE user_id = p_target AND revoked_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_actor, 'auth.mfa.reset', 'user', p_target::text, left(p_correlation_id, 200),
          jsonb_build_object('tenantId', v_tenant, 'reason', left(btrim(p_reason), 500)));
  RETURN true;
END $$;

CREATE FUNCTION auth_mfa_support_reset(p_email text, p_actor text, p_reason text, p_ticket text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_user FROM users WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE';
  IF v_user IS NULL THEN RETURN NULL; END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id = v_user;
  DELETE FROM user_mfa_factors WHERE user_id = v_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'MFA_RESET' WHERE user_id = v_user AND revoked_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'auth.mfa.support_reset', 'user', v_user::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
  RETURN v_user;
END $$;

CREATE FUNCTION auth_members_mfa()
  RETURNS TABLE (user_id uuid, enrolled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id, EXISTS (SELECT 1 FROM user_mfa_factors f WHERE f.user_id = m.user_id AND f.confirmed_at IS NOT NULL)
    FROM tenant_memberships m
   WHERE m.tenant_id = app_current_tenant_id()
$$;

ALTER FUNCTION auth_mfa_admin_reset(uuid, uuid, text, text) OWNER TO onepos_platform;
ALTER FUNCTION auth_mfa_support_reset(text, text, text, text) OWNER TO onepos_platform;
ALTER FUNCTION auth_members_mfa() OWNER TO onepos_platform;
REVOKE ALL ON FUNCTION auth_mfa_admin_reset(uuid, uuid, text, text), auth_mfa_support_reset(text, text, text, text), auth_members_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_mfa_admin_reset(uuid, uuid, text, text), auth_members_mfa() TO onepos_app;
GRANT EXECUTE ON FUNCTION auth_mfa_support_reset(text, text, text, text) TO onepos_migrator;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
