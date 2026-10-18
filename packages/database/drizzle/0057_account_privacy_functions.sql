-- Hand-written: a person's own account (privacy pack gaps, ADR-0016 slice 8 follow-up).
-- * email_change_tokens: a credential table like password_reset_tokens (no runtime access).
-- * auth_email_change_request/confirm: change one's sign-in email through a link sent to the new
--   address. Confirming signs out every session; the old address is told.
-- * auth_account_closure_blockers/auth_account_close: a person closes their own account. It is
--   blocked now (status DISABLED, closed_at set, sessions ended, second factor and pending links
--   removed) and anonymised later, once the retention schedule allows (not built: waits on the DPO).
--   Refused while they are still a member of a business or active 1POS support staff.
-- * platform_account_disable/enable: the ops CLI's audited replacement for the reviewed SQL in
--   security-incident.md 2.1 (migrator only, never the runtime role).
-- Every change writes a NULL-tenant audit row; none of them records an email address.

ALTER TABLE email_change_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_change_tokens FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_change_tokens TO onepos_platform;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- 1. Email change ----------------------------------------------------------------------------
-- CREATED, or why not: SAME_EMAIL, EMAIL_TAKEN, NOT_ACTIVE, TOO_MANY (5 an hour).
CREATE FUNCTION auth_email_change_request(p_user uuid, p_new_email text, p_token_hash text, p_expires_at timestamptz, p_correlation_id text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_email text; v_new text := lower(btrim(p_new_email));
BEGIN
  SELECT email INTO v_email FROM users WHERE id = p_user AND status = 'ACTIVE' FOR UPDATE;
  IF v_email IS NULL THEN RETURN 'NOT_ACTIVE'; END IF;
  IF lower(v_email) = v_new THEN RETURN 'SAME_EMAIL'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = v_new) THEN RETURN 'EMAIL_TAKEN'; END IF;
  IF (SELECT count(*) FROM email_change_tokens WHERE user_id = p_user AND created_at > now() - interval '1 hour') >= 5 THEN
    RETURN 'TOO_MANY';
  END IF;
  -- Only the newest link works.
  UPDATE email_change_tokens SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at) VALUES (p_user, v_new, p_token_hash, p_expires_at);
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
  VALUES (NULL, 'USER', p_user, 'auth.email_change.requested', 'user', p_user::text, left(p_correlation_id, 200));
  RETURN 'CREATED';
END $$;

-- CHANGED (with the old address, to tell it), INVALID (unknown, used or expired link, or the
-- account is no longer active) or EMAIL_TAKEN (another account took the address meanwhile).
CREATE FUNCTION auth_email_change_confirm(p_token_hash text, p_correlation_id text)
  RETURNS TABLE (outcome text, user_id uuid, old_email text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r email_change_tokens%ROWTYPE; v_old text;
BEGIN
  SELECT * INTO r FROM email_change_tokens t WHERE t.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR r.used_at IS NOT NULL OR r.expires_at <= now() THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT u.email INTO v_old FROM users u WHERE u.id = r.user_id AND u.status = 'ACTIVE' FOR UPDATE;
  IF v_old IS NULL THEN RETURN QUERY SELECT 'INVALID'::text, NULL::uuid, NULL::text; RETURN; END IF;
  UPDATE email_change_tokens SET used_at = now() WHERE id = r.id;
  BEGIN
    UPDATE users SET email = r.new_email WHERE id = r.user_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'EMAIL_TAKEN'::text, r.user_id, NULL::text; RETURN;
  END;
  -- The old address can no longer reset the password, and every session signs in again.
  UPDATE password_reset_tokens SET used_at = now() WHERE password_reset_tokens.user_id = r.user_id AND used_at IS NULL;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'EMAIL_CHANGED'
   WHERE user_sessions.user_id = r.user_id AND revoked_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
  VALUES (NULL, 'USER', r.user_id, 'auth.email_change.completed', 'user', r.user_id::text, left(p_correlation_id, 200));
  RETURN QUERY SELECT 'CHANGED'::text, r.user_id, v_old;
END $$;

-- 2. Account closure -------------------------------------------------------------------------
-- What stands in the way of closing: each business the person still belongs to (any status but
-- REMOVED: an owner or admin must remove them, or the business be closed), and active staff status.
CREATE FUNCTION auth_account_closure_blockers(p_user uuid)
  RETURNS TABLE (kind text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'MEMBERSHIP', t.name FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user AND m.status <> 'REMOVED'
  UNION ALL
  SELECT 'STAFF', NULL FROM platform_staff s WHERE s.user_id = p_user AND s.status = 'ACTIVE'
  ORDER BY 1, 2
$$;

CREATE FUNCTION auth_account_close(p_user uuid, p_correlation_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = p_user AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account is not active' USING ERRCODE = '55000', CONSTRAINT = 'account_not_active'; END IF;
  IF EXISTS (SELECT 1 FROM auth_account_closure_blockers(p_user)) THEN
    RAISE EXCEPTION 'still a member of a business, or support staff' USING ERRCODE = '55000', CONSTRAINT = 'account_closure_blocked';
  END IF;
  UPDATE users SET status = 'DISABLED', closed_at = now() WHERE id = p_user;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'ACCOUNT_CLOSED' WHERE user_id = p_user AND revoked_at IS NULL;
  -- Credentials with no further use go now; the account row itself waits for anonymisation.
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_user;
  DELETE FROM user_mfa_factors WHERE user_id = p_user;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  UPDATE email_change_tokens SET used_at = now() WHERE user_id = p_user AND used_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
  VALUES (NULL, 'USER', p_user, 'auth.account.closed', 'user', p_user::text, left(p_correlation_id, 200));
END $$;

-- 3. Ops CLI (migrator only) -----------------------------------------------------------------
-- Block sign-in and end every session at its next request. NULL when no active account has the email.
CREATE FUNCTION platform_account_disable(p_email text, p_actor text, p_reason text, p_ticket text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  UPDATE users SET status = 'DISABLED' WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE' RETURNING id INTO v_user;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'ACCOUNT_DISABLED' WHERE user_id = v_user AND revoked_at IS NULL;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;
  UPDATE email_change_tokens SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'platform.user.disabled', 'user', v_user::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
  RETURN v_user;
END $$;

-- Let a blocked account sign in again (a closed one too: the person asked to come back). Its
-- sessions stay ended; the person signs in, or resets the password, afresh.
CREATE FUNCTION platform_account_enable(p_email text, p_actor text, p_reason text, p_ticket text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid; v_closed timestamptz;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  SELECT id, closed_at INTO v_user, v_closed FROM users WHERE lower(email) = lower(btrim(p_email)) AND status = 'DISABLED' FOR UPDATE;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  UPDATE users SET status = 'ACTIVE', closed_at = NULL, failed_login_count = 0, locked_until = NULL WHERE id = v_user;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'platform.user.enabled', 'user', v_user::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100),
                             'wasClosed', v_closed IS NOT NULL));
  RETURN v_user;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_email_change_request(uuid, text, text, timestamptz, text)',
    'auth_email_change_confirm(text, text)',
    'auth_account_closure_blockers(uuid)',
    'auth_account_close(uuid, text)',
    'platform_account_disable(text, text, text, text)',
    'platform_account_enable(text, text, text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION auth_email_change_request(uuid, text, text, timestamptz, text), auth_email_change_confirm(text, text),
  auth_account_closure_blockers(uuid), auth_account_close(uuid, text) TO onepos_app;
GRANT EXECUTE ON FUNCTION platform_account_disable(text, text, text, text), platform_account_enable(text, text, text, text) TO onepos_migrator;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
