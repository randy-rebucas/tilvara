-- Hand-written: plan catalog seed, subscription RLS, platform subscription functions,
-- and the write-access rule used by every tenant write path.

-- NOTE: prices are PLACEHOLDERS pending a pricing decision; limits are initial proposals.
INSERT INTO plans (code, name, monthly_price, currency, limits, features) VALUES
  ('starter',    'Starter',    '0.0000',    'PHP',
   '{"maxLegalEntities":1,"maxBranches":1,"maxRegisters":2,"maxUsers":5}', '[]'),
  ('growth',     'Growth',     '0.0000',    'PHP',
   '{"maxLegalEntities":3,"maxBranches":5,"maxRegisters":15,"maxUsers":30}', '["restaurant","multi_entity","advanced_reports"]'),
  ('enterprise', 'Enterprise', '0.0000',    'PHP',
   '{"maxLegalEntities":50,"maxBranches":500,"maxRegisters":2000,"maxUsers":5000}', '["restaurant","multi_entity","api_access","advanced_reports"]');

GRANT SELECT ON plans TO onepos_app, onepos_readonly;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE TRIGGER subscriptions_touch_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();
CREATE TRIGGER subscriptions_no_delete BEFORE DELETE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
-- Tenants can read their subscription but never change it themselves.
GRANT SELECT ON subscriptions TO onepos_app, onepos_readonly;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO onepos_platform;
GRANT SELECT ON plans TO onepos_platform;

-- Full access while trialing (until trial end), active, or past due within grace.
-- Anything else (or no subscription at all) → read-only. Fail closed.
CREATE FUNCTION app_subscription_write_allowed() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT CASE s.status
      WHEN 'ACTIVE'   THEN true
      WHEN 'TRIALING' THEN s.trial_ends_at IS NULL OR s.trial_ends_at > now()
      WHEN 'PAST_DUE' THEN s.grace_ends_at IS NOT NULL AND s.grace_ends_at > now()
      ELSE false END
    FROM subscriptions s WHERE s.tenant_id = app_current_tenant_id()
  ), false)
$$;
GRANT EXECUTE ON FUNCTION app_subscription_write_allowed() TO onepos_app;

CREATE FUNCTION platform_start_trial(p_tenant_id uuid, p_plan_code text, p_days int)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_days < 1 OR p_days > 90 THEN RAISE EXCEPTION 'trial length out of range' USING ERRCODE = '22023'; END IF;
  INSERT INTO subscriptions (tenant_id, plan_code, status, trial_ends_at)
  VALUES (p_tenant_id, p_plan_code, 'TRIALING', now() + make_interval(days => p_days))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- For the billing integration (PayMongo webhooks, later) and platform admin tooling.
CREATE FUNCTION platform_set_subscription(p_tenant_id uuid, p_plan_code text, p_status text,
                                          p_period_end timestamptz, p_grace_ends_at timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE subscriptions
     SET plan_code = p_plan_code, status = p_status, current_period_end = p_period_end, grace_ends_at = p_grace_ends_at
   WHERE tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant % has no subscription', p_tenant_id USING ERRCODE = 'P0002'; END IF;
END $$;

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION platform_start_trial(uuid, text, int) OWNER TO onepos_platform;
ALTER FUNCTION platform_set_subscription(uuid, text, text, timestamptz, timestamptz) OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION platform_start_trial(uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_set_subscription(uuid, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_start_trial(uuid, text, int) TO onepos_app;
-- platform_set_subscription is deliberately NOT granted to the runtime role yet: no billing
-- integration exists, and tenants must not be able to upgrade themselves. Grant it to the
-- billing worker role when PayMongo is integrated.
