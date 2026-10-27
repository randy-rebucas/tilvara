-- Hand-written: tenant audit (session 40).
-- * auth_mfa_admin_reset(): an owner/admin of one business may no longer reset the two-step sign-in of
--   someone who is also a member of another business. The reset is account-wide (factors, recovery codes,
--   every session), so it would act on the other business's member without that business knowing; such
--   a person is reset by the support procedure instead (docs/operations/support-mfa-reset.md).
-- * platform_start_trial(): only for the business in context (sign-up sets it first), never any id.

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

CREATE OR REPLACE FUNCTION auth_mfa_admin_reset(p_target uuid, p_actor uuid, p_reason text, p_correlation_id text)
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
  IF EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id <> v_tenant AND user_id = p_target AND status <> 'REMOVED') THEN
    RAISE EXCEPTION 'this person is also in another business; Tilvara support resets their two-step sign-in'
      USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_other_business';
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

CREATE OR REPLACE FUNCTION platform_start_trial(p_tenant_id uuid, p_plan_code text, p_days int)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app_current_tenant_id() THEN
    RAISE EXCEPTION 'a trial starts only for the business in context' USING ERRCODE = '42501';
  END IF;
  IF p_days < 1 OR p_days > 90 THEN RAISE EXCEPTION 'trial length out of range' USING ERRCODE = '22023'; END IF;
  INSERT INTO subscriptions (tenant_id, plan_code, status, trial_ends_at)
  VALUES (p_tenant_id, p_plan_code, 'TRIALING', now() + make_interval(days => p_days))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE CREATE ON SCHEMA public FROM onepos_platform;
