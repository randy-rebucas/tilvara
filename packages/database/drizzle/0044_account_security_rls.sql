-- Hand-written: account security (Phase 6 slice 1, ADR-0016) — TOTP MFA, password reset and
-- platform-level auth audit events. Like user_sessions, the new tables have no runtime access at
-- all: the app role reaches them only through the SECURITY DEFINER functions below.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_mfa_factors', 'user_mfa_recovery_codes', 'password_reset_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO onepos_platform', t);
  END LOOP;
END $$;

-- The users.privileged_since and user_sessions.mfa_verified_at columns are platform-only as well
-- (users keeps its column-level SELECT grant to the runtime role, which does not include them).

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- Platform-level audit row (no tenant: visible to no tenant). Only auth.* actions.
CREATE FUNCTION auth_record_event(p_user_id uuid, p_action text, p_metadata jsonb, p_correlation_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_action IS NULL OR p_action !~ '^auth\.[a-z_.]+$' THEN
    RAISE EXCEPTION 'auth events only' USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_user_id, p_action, 'user', p_user_id::text, left(p_correlation_id, 200), coalesce(p_metadata, '{}'::jsonb));
END $$;

-- Sessions remember whether they passed a second factor.
DROP FUNCTION auth_create_session(uuid, text, timestamptz, text);
CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz, p_user_agent text, p_mfa boolean DEFAULT false)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_family uuid := uuidv7();
BEGIN
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent, mfa_verified_at)
  VALUES (p_user_id, v_family, p_token_hash, p_expires_at, left(p_user_agent, 300), CASE WHEN p_mfa THEN now() END);
  RETURN v_family;
END $$;

-- As 0003, plus: rotation keeps the MFA mark, and reuse is audited (token theft signal).
CREATE OR REPLACE FUNCTION auth_rotate_session(p_old_hash text, p_new_hash text, p_new_expires timestamptz)
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
    INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
    VALUES (NULL, 'SYSTEM', s.user_id, 'auth.refresh_reuse', 'user', s.user_id::text,
            jsonb_build_object('sessionId', s.family_id));
    RETURN QUERY SELECT 'REUSED'::text, s.user_id, s.family_id; RETURN;
  END IF;
  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, s.user_id, s.family_id; RETURN;
  END IF;
  UPDATE user_sessions SET replaced_at = now() WHERE id = s.id;
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent, mfa_verified_at)
  VALUES (s.user_id, s.family_id, p_new_hash, p_new_expires, s.user_agent, s.mfa_verified_at);
  RETURN QUERY SELECT 'ROTATED'::text, s.user_id, s.family_id;
END $$;

-- As 0003, plus: a lock (5th consecutive failure onwards) is audited.
CREATE OR REPLACE FUNCTION auth_record_login_result(p_user_id uuid, p_success boolean)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count int; v_until timestamptz;
BEGIN
  IF p_success THEN
    UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user_id;
  ELSE
    UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= 5
             THEN now() + least(60, power(2, failed_login_count + 1 - 5)::int) * interval '1 minute'
             ELSE locked_until END
     WHERE id = p_user_id
     RETURNING failed_login_count, locked_until INTO v_count, v_until;
    IF v_count >= 5 THEN
      INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
      VALUES (NULL, 'SYSTEM', p_user_id, 'auth.lockout', 'user', p_user_id::text,
              jsonb_build_object('failedCount', v_count, 'lockedUntil', v_until));
    END IF;
  END IF;
END $$;

-- As 0003, plus what the guard needs for MFA enforcement.
DROP FUNCTION auth_resolve_context(uuid, uuid, uuid);
CREATE FUNCTION auth_resolve_context(p_user_id uuid, p_family_id uuid, p_tenant_id uuid)
  RETURNS TABLE (session_active boolean, user_active boolean, membership_id uuid, tenant_status text,
                 session_mfa boolean, mfa_enrolled boolean, privileged_since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_sessions s
             WHERE s.family_id = p_family_id AND s.user_id = p_user_id
               AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.expires_at > now()),
    EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.status = 'ACTIVE'),
    (SELECT m.id FROM tenant_memberships m
      WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE'),
    (SELECT t.status FROM tenants t WHERE t.id = p_tenant_id),
    EXISTS (SELECT 1 FROM user_sessions s
             WHERE s.family_id = p_family_id AND s.user_id = p_user_id
               AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.mfa_verified_at IS NOT NULL),
    EXISTS (SELECT 1 FROM user_mfa_factors f WHERE f.user_id = p_user_id AND f.confirmed_at IS NOT NULL),
    (SELECT u.privileged_since FROM users u WHERE u.id = p_user_id)
$$;

-- Start of the MFA grace period: the first time a privileged user without MFA is seen.
CREATE FUNCTION auth_note_privileged(p_user_id uuid)
  RETURNS timestamptz LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET privileged_since = coalesce(privileged_since, now()) WHERE id = p_user_id RETURNING privileged_since
$$;

-- MFA -------------------------------------------------------------------------------------
-- The user's factor (no row when none), with the account's lock state: a second-step code counts
-- towards the same lockout as a password.
CREATE FUNCTION auth_mfa_get(p_user_id uuid)
  RETURNS TABLE (secret_ciphertext text, confirmed boolean, last_used_step int, recovery_codes_left int,
                 user_status text, locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.secret_ciphertext, f.confirmed_at IS NOT NULL, f.last_used_step,
         (SELECT count(*)::int FROM user_mfa_recovery_codes c WHERE c.user_id = p_user_id AND c.used_at IS NULL),
         u.status, u.locked_until
    FROM users u LEFT JOIN user_mfa_factors f ON f.user_id = u.id
   WHERE u.id = p_user_id
$$;

-- A new (unconfirmed) secret; refused while a confirmed factor exists.
CREATE FUNCTION auth_mfa_begin(p_user_id uuid, p_secret_ciphertext text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_mfa_factors WHERE user_id = p_user_id AND confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'two-step sign-in is already on' USING ERRCODE = '55000', CONSTRAINT = 'mfa_already_enabled';
  END IF;
  INSERT INTO user_mfa_factors (user_id, secret_ciphertext) VALUES (p_user_id, p_secret_ciphertext)
  ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, last_used_step = 0, created_at = now();
END $$;

-- Confirm with a first code (its step is spent), store the recovery codes, mark the current session.
CREATE FUNCTION auth_mfa_confirm(p_user_id uuid, p_step int, p_code_hashes text[], p_family_id uuid, p_correlation_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE user_mfa_factors SET confirmed_at = now(), last_used_step = p_step
   WHERE user_id = p_user_id AND confirmed_at IS NULL AND last_used_step < p_step;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_user_id;
  INSERT INTO user_mfa_recovery_codes (user_id, code_hash) SELECT p_user_id, h FROM unnest(p_code_hashes) AS h;
  UPDATE user_sessions SET mfa_verified_at = now()
   WHERE family_id = p_family_id AND user_id = p_user_id AND revoked_at IS NULL AND replaced_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_user_id, 'auth.mfa.enabled', 'user', p_user_id::text, left(p_correlation_id, 200),
          jsonb_build_object('recoveryCodes', coalesce(array_length(p_code_hashes, 1), 0)));
  RETURN true;
END $$;

-- Spend a time step: true only once per step, and only for a later step than the last one used.
CREATE FUNCTION auth_mfa_use_step(p_user_id uuid, p_step int)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE user_mfa_factors SET last_used_step = p_step
   WHERE user_id = p_user_id AND confirmed_at IS NOT NULL AND last_used_step < p_step;
  RETURN FOUND;
END $$;

-- Spend a recovery code: the number left, or -1 when the code is unknown or used.
CREATE FUNCTION auth_mfa_use_recovery(p_user_id uuid, p_code_hash text, p_correlation_id text)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_left int;
BEGIN
  UPDATE user_mfa_recovery_codes SET used_at = now()
   WHERE user_id = p_user_id AND code_hash = p_code_hash AND used_at IS NULL
     AND EXISTS (SELECT 1 FROM user_mfa_factors f WHERE f.user_id = p_user_id AND f.confirmed_at IS NOT NULL);
  IF NOT FOUND THEN RETURN -1; END IF;
  SELECT count(*)::int INTO v_left FROM user_mfa_recovery_codes WHERE user_id = p_user_id AND used_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_user_id, 'auth.mfa.recovery_code_used', 'user', p_user_id::text, left(p_correlation_id, 200),
          jsonb_build_object('left', v_left));
  RETURN v_left;
END $$;

CREATE FUNCTION auth_mfa_disable(p_user_id uuid, p_correlation_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_user_id;
  DELETE FROM user_mfa_factors WHERE user_id = p_user_id;
  IF FOUND THEN
    INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
    VALUES (NULL, 'USER', p_user_id, 'auth.mfa.disabled', 'user', p_user_id::text, left(p_correlation_id, 200));
  END IF;
END $$;

-- Password reset ------------------------------------------------------------------------------
-- The user id when a reset was created, NULL otherwise (unknown/disabled email, or more than 5
-- requests in the last hour). The caller answers the same either way.
CREATE FUNCTION auth_password_reset_create(p_email text, p_token_hash text, p_expires_at timestamptz, p_correlation_id text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT id INTO v_user FROM users WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE' FOR UPDATE;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM password_reset_tokens WHERE user_id = v_user AND created_at > now() - interval '1 hour') >= 5 THEN
    RETURN NULL;
  END IF;
  -- Only the newest link works.
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (v_user, p_token_hash, p_expires_at);
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
  VALUES (NULL, 'USER', v_user, 'auth.password_reset.requested', 'user', v_user::text, left(p_correlation_id, 200));
  RETURN v_user;
END $$;

-- Set a new password with a valid token: unlocks the account and signs out every session.
CREATE FUNCTION auth_password_reset_consume(p_token_hash text, p_password_hash text, p_correlation_id text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r password_reset_tokens%ROWTYPE;
BEGIN
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'password hash must be argon2id' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM password_reset_tokens WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR r.used_at IS NOT NULL OR r.expires_at <= now() THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = r.user_id AND status = 'ACTIVE') THEN RETURN NULL; END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE id = r.id;
  UPDATE users SET password_hash = p_password_hash, failed_login_count = 0, locked_until = NULL WHERE id = r.user_id;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'PASSWORD_RESET'
   WHERE user_id = r.user_id AND revoked_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
  VALUES (NULL, 'USER', r.user_id, 'auth.password_reset.completed', 'user', r.user_id::text, left(p_correlation_id, 200));
  RETURN r.user_id;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_record_event(uuid, text, jsonb, text)',
    'auth_create_session(uuid, text, timestamptz, text, boolean)',
    'auth_rotate_session(text, text, timestamptz)',
    'auth_record_login_result(uuid, boolean)',
    'auth_resolve_context(uuid, uuid, uuid)',
    'auth_note_privileged(uuid)',
    'auth_mfa_get(uuid)',
    'auth_mfa_begin(uuid, text)',
    'auth_mfa_confirm(uuid, int, text[], uuid, text)',
    'auth_mfa_use_step(uuid, int)',
    'auth_mfa_use_recovery(uuid, text, text)',
    'auth_mfa_disable(uuid, text)',
    'auth_password_reset_create(text, text, timestamptz, text)',
    'auth_password_reset_consume(text, text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_app', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
