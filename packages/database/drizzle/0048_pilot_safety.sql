-- Hand-written: pilot-safety leftovers (Phase 6, session 10).
-- * auth_mfa_regenerate_recovery(): new recovery codes for a member who keeps two-step sign-in on
--   (privileged members cannot turn it off and on again). Spends a current time step.
-- * Payment intents are recorded only against an OPEN shift, and a shift cannot close while one of
--   its card/QR payments is PROCESSING, UNKNOWN or SUCCEEDED in no sale (ADR-0010 §6). The API
--   checks both first; these triggers are the backstop. The intent insert takes a share lock on the
--   shift row, so a close (which updates that row) waits for it and then sees it.

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- Replace every recovery code, only with a later step than the last one used (the code is spent).
CREATE FUNCTION auth_mfa_regenerate_recovery(p_user_id uuid, p_step int, p_code_hashes text[], p_correlation_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(array_length(p_code_hashes, 1), 0) = 0 THEN
    RAISE EXCEPTION 'recovery codes required' USING ERRCODE = '22023';
  END IF;
  UPDATE user_mfa_factors SET last_used_step = p_step
   WHERE user_id = p_user_id AND confirmed_at IS NOT NULL AND last_used_step < p_step;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_user_id;
  INSERT INTO user_mfa_recovery_codes (user_id, code_hash) SELECT p_user_id, h FROM unnest(p_code_hashes) AS h;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_user_id, 'auth.mfa.recovery_codes_regenerated', 'user', p_user_id::text, left(p_correlation_id, 200),
          jsonb_build_object('recoveryCodes', array_length(p_code_hashes, 1)));
  RETURN true;
END $$;

ALTER FUNCTION auth_mfa_regenerate_recovery(uuid, int, text[], text) OWNER TO onepos_platform;
REVOKE ALL ON FUNCTION auth_mfa_regenerate_recovery(uuid, int, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_mfa_regenerate_recovery(uuid, int, text[], text) TO onepos_app;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;

-- A new intent needs its shift OPEN; FOR SHARE makes a concurrent close wait for this insert.
CREATE FUNCTION app_payment_intent_require_open_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM cashier_sessions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cashier_session_id AND s.status = 'OPEN'
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cashier session is not open' USING ERRCODE = '23514', CONSTRAINT = 'session_not_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_intents_require_open_session BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION app_payment_intent_require_open_session();

-- Leaving OPEN is refused while a charge of the shift belongs to no sale.
CREATE FUNCTION app_cashier_session_payments_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents p
              WHERE p.tenant_id = NEW.tenant_id AND p.cashier_session_id = NEW.id
                AND (p.status IN ('PROCESSING', 'UNKNOWN') OR (p.status = 'SUCCEEDED' AND p.sale_id IS NULL))) THEN
    RAISE EXCEPTION 'card/QR payments on this shift are not settled' USING ERRCODE = '23514', CONSTRAINT = 'payments_outstanding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashier_sessions_payments_settled BEFORE UPDATE OF status ON cashier_sessions
  FOR EACH ROW WHEN (OLD.status = 'OPEN' AND NEW.status IS DISTINCT FROM 'OPEN')
  EXECUTE FUNCTION app_cashier_session_payments_settled();
