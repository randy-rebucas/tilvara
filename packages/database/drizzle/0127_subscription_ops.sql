-- Hand-written: subscription audit (2026-10-27).
-- * platform_change_subscription(): the ops CLI's audited way to change a business's plan or status
--   (`support subscription-set`), replacing hand-typed platform_set_subscription in the runbooks. It
--   refuses what makes no sense (an inactive plan, a trial without its end, payment past due without a
--   grace end, active without a paid-until date, any of those dates already past) and writes a
--   `subscription.changed` row in the business's own audit log (from/to, who, why, ticket).
--   platform_set_subscription stays for the billing integration (D6) and the tests.
-- * platform_subscription_of(): what `support subscription-show` prints.
-- * webhook_enqueue: no deliveries for a business whose plan no longer includes `api_access` (its API
--   keys were already refused); the endpoints are kept and resume after an upgrade.

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

CREATE FUNCTION platform_subscription_of(p_slug text)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_status text, plan_code text, status text,
                 trial_ends_at timestamptz, current_period_end timestamptz, grace_ends_at timestamptz, writable boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status, s.plan_code, s.status, s.trial_ends_at, s.current_period_end, s.grace_ends_at,
         coalesce(CASE s.status
           WHEN 'ACTIVE'   THEN true
           WHEN 'TRIALING' THEN s.trial_ends_at IS NULL OR s.trial_ends_at > now()
           WHEN 'PAST_DUE' THEN s.grace_ends_at IS NOT NULL AND s.grace_ends_at > now()
           ELSE false END, false)
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
   WHERE t.slug = lower(btrim(p_slug))
$$;

CREATE FUNCTION platform_change_subscription(p_slug text, p_plan_code text, p_status text, p_trial_ends_at timestamptz,
                                             p_period_end timestamptz, p_grace_ends_at timestamptz,
                                             p_actor text, p_reason text, p_ticket text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_before subscriptions%ROWTYPE;
  v_id uuid;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_tenant FROM tenants WHERE slug = lower(btrim(p_slug));
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business with the address %', p_slug USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = p_plan_code AND active) THEN
    RAISE EXCEPTION 'no active plan %', p_plan_code USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED') THEN
    RAISE EXCEPTION 'status must be TRIALING, ACTIVE, PAST_DUE or CANCELED' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'TRIALING' AND (p_trial_ends_at IS NULL OR p_trial_ends_at <= now()) THEN
    RAISE EXCEPTION 'a trial needs its end, in the future (to end a trial, set CANCELED)' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'ACTIVE' AND (p_period_end IS NULL OR p_period_end <= now()) THEN
    RAISE EXCEPTION 'an active subscription needs the date it is paid until, in the future' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'PAST_DUE' AND (p_grace_ends_at IS NULL OR p_grace_ends_at <= now()) THEN
    RAISE EXCEPTION 'past due needs the end of its grace period, in the future (after it, set CANCELED)' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before FROM subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO subscriptions (tenant_id, plan_code, status, trial_ends_at, current_period_end, grace_ends_at)
    VALUES (v_tenant, p_plan_code, p_status, CASE WHEN p_status = 'TRIALING' THEN p_trial_ends_at END,
            p_period_end, CASE WHEN p_status = 'PAST_DUE' THEN p_grace_ends_at END)
    RETURNING id INTO v_id;
  ELSE
    UPDATE subscriptions
       SET plan_code = p_plan_code, status = p_status,
           trial_ends_at = CASE WHEN p_status = 'TRIALING' THEN p_trial_ends_at ELSE trial_ends_at END,
           current_period_end = p_period_end,
           grace_ends_at = CASE WHEN p_status = 'PAST_DUE' THEN p_grace_ends_at END
     WHERE id = v_before.id
    RETURNING id INTO v_id;
  END IF;

  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (v_tenant, 'SYSTEM', NULL, 'subscription.changed', 'subscription', v_id::text,
          jsonb_build_object(
            'fromPlan', v_before.plan_code, 'fromStatus', v_before.status,
            'plan', p_plan_code, 'status', p_status,
            'trialEndsAt', CASE WHEN p_status = 'TRIALING' THEN p_trial_ends_at END,
            'periodEnd', p_period_end,
            'graceEndsAt', CASE WHEN p_status = 'PAST_DUE' THEN p_grace_ends_at END,
            'actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
  RETURN v_tenant;
END $$;

CREATE OR REPLACE FUNCTION webhook_enqueue(p_event_id uuid) RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ins AS (
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, topic, payload)
    SELECT e.tenant_id, w.id, e.id, e.topic, e.payload
      FROM outbox_events e JOIN webhook_endpoints w ON w.tenant_id = e.tenant_id AND w.enabled AND e.topic = ANY (w.topics)
     WHERE e.id = p_event_id AND e.tenant_id = app_current_tenant_id() AND e.status = 'PROCESSING'
       AND EXISTS (SELECT 1 FROM subscriptions s JOIN plans p ON p.code = s.plan_code
                    WHERE s.tenant_id = e.tenant_id AND p.features ? 'api_access')
    ON CONFLICT (endpoint_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_subscription_of(text)',
    'platform_change_subscription(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_migrator', f);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM onepos_platform;
