-- Hand-written: fourth audit (docs/AUDIT-2026-10-31.md), database fixes (DDL in 0136).
-- * Ops' own words stay out of the business's log (#1): a business's audit rows say `support` (actor/by) and a
--   reason code; who, why and the ticket go into a NULL-tenant platform row. Every reason the billing functions
--   write into a business's log is now a code (the admin words them): BILL_PAID, PLAN_UPGRADED, OTHER_PLAN_CHOSEN,
--   PERIOD_RENEWED, STALE_UPGRADE, SUBSCRIPTION_CANCELED, OWNER_CANCELED, CANCEL_AT_PERIOD_END, PAID_UNTIL_REACHED,
--   DOWNGRADE_OVER_LIMITS, PAID_PERIOD_STARTED, CHANGED_BY_SUPPORT. Past rows keep their words (append-only).
-- * An upgrade during a trial already paid for charges for the paid month only, not the trial days (#8).
-- * A bill paid before its period starts no longer changes the plan at once (#10): the plan waits in
--   `scheduled_plan_code` and the hourly pass applies it when the paid period starts.
-- * `support subscription-set` voids the business's open bills and clears a stop or a scheduled plan (#11).
-- * The hourly pass closes at the provider the pages it expires (#12) and locks the subscription before voiding a
--   stale upgrade, the same order as the webhook (#14, which now locks the subscription first too).
-- * An upgrade worth less than ₱20 (below the provider's minimum) applies at once, unbilled (#13).
-- * auth_mfa_disable also takes the two-step mark off the person's sessions (#16).
-- * The API may mark a payment whose cancel it sends (#5, payment_intents.cancel_requested_at).

-- #5: the API marks a payment whose cancel it sends (payment_intents.cancel_requested_at, 0136).
GRANT UPDATE (cancel_requested_at) ON payment_intents TO onepos_app;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint

-- The code a void reason is written under in the business's log (void_reason itself keeps the words: the API
-- shows them to the owner, masking ops' own).
CREATE FUNCTION billing_reason_code(p_reason text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_reason LIKE 'ops:%' THEN 'CHANGED_BY_SUPPORT'
    WHEN p_reason = 'plan upgraded' THEN 'PLAN_UPGRADED'
    WHEN p_reason = 'another plan chosen' THEN 'OTHER_PLAN_CHOSEN'
    WHEN p_reason = 'period renewed' THEN 'PERIOD_RENEWED'
    WHEN p_reason = 'period ended before it was paid' THEN 'STALE_UPGRADE'
    WHEN p_reason = 'subscription canceled' THEN 'SUBSCRIPTION_CANCELED'
    WHEN p_reason = 'canceled by the owner' THEN 'OWNER_CANCELED'
    ELSE left(p_reason, 100) END
$$;--> statement-breakpoint

-- Who paid or settled, as the business's log shows it: ops' login becomes `support`.
CREATE FUNCTION billing_public_by(p_by text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_by LIKE 'ops:%' THEN 'support' ELSE left(p_by, 100) END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_void(p_bill uuid, p_reason text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b billing_bills%ROWTYPE;
BEGIN
  UPDATE billing_bills SET status = 'VOID', voided_at = now(), void_reason = left(p_reason, 300)
   WHERE id = p_bill AND status = 'OPEN' RETURNING * INTO b;
  IF FOUND THEN
    PERFORM billing_expire_checkouts(b.tenant_id, b.id);
    INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
    VALUES (b.tenant_id, 'SYSTEM', 'billing.bill_voided', 'billing_bill', b.id::text,
            jsonb_build_object('number', b.number, 'reason', billing_reason_code(p_reason)));
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_take_payment(p_bill uuid, p_amount numeric, p_currency text, p_method text, p_provider text,
                                     p_reference text, p_received_at timestamptz, p_by text, p_note text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b billing_bills%ROWTYPE;
  v_applied boolean;
  v_payment uuid;
BEGIN
  SELECT * INTO b FROM billing_bills WHERE id = p_bill;
  PERFORM 1 FROM subscriptions WHERE tenant_id = b.tenant_id FOR UPDATE;
  SELECT * INTO b FROM billing_bills WHERE id = p_bill FOR UPDATE;
  IF EXISTS (SELECT 1 FROM billing_payments WHERE tenant_id = b.tenant_id AND provider = p_provider AND reference = p_reference) THEN
    RETURN 'DUPLICATE';
  END IF;
  v_applied := b.status = 'OPEN' AND round(p_amount, 2) = b.amount AND p_currency = b.currency;
  INSERT INTO billing_payments (tenant_id, bill_id, amount, currency, method, provider, reference, applied, recorded_by, note, received_at)
  VALUES (b.tenant_id, b.id, round(p_amount, 2), p_currency, p_method, p_provider, p_reference, v_applied, left(p_by, 100), left(p_note, 500), p_received_at)
  RETURNING id INTO v_payment;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (b.tenant_id, 'SYSTEM', CASE WHEN v_applied THEN 'billing.payment_recorded' ELSE 'billing.payment_unapplied' END, 'billing_payment', v_payment::text,
          jsonb_build_object('bill', b.number, 'amount', round(p_amount, 2)::text, 'currency', p_currency, 'method', p_method,
                             'provider', p_provider, 'by', billing_public_by(p_by), 'billStatus', b.status));
  IF v_applied THEN
    PERFORM billing_settle(b.id, p_by);
    PERFORM billing_issue_receipt(v_payment, true);
    RETURN 'APPLIED';
  END IF;
  RETURN 'UNAPPLIED';
END $$;--> statement-breakpoint

-- As 0135, with reason codes (#1) and a plan paid for a period not yet started kept for that period (#10).
CREATE OR REPLACE FUNCTION billing_renewal_due(p_tenant uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s subscriptions%ROWTYPE;
  v_plan text;
  v_price numeric;
  v_limits jsonb;
  v_over text;
  v_anchor timestamptz;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR s.status NOT IN ('ACTIVE', 'PAST_DUE') OR s.cancel_at_period_end OR s.current_period_end IS NULL THEN RETURN NULL; END IF;
  IF s.status = 'ACTIVE' AND s.current_period_end - interval '7 days' > now() THEN RETURN NULL; END IF;
  IF s.status = 'PAST_DUE' AND (s.grace_ends_at IS NULL OR s.grace_ends_at <= now()) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM billing_bills WHERE tenant_id = p_tenant AND status = 'OPEN' AND kind <> 'UPGRADE') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM billing_bills WHERE tenant_id = p_tenant AND status = 'PAID' AND kind <> 'UPGRADE'
                AND period_start = s.current_period_end) THEN RETURN NULL; END IF;
  SELECT code, monthly_price, limits INTO v_plan, v_price, v_limits FROM plans WHERE code = s.scheduled_plan_code AND active;
  IF v_plan IS NOT NULL AND v_plan <> s.plan_code THEN
    v_over := billing_over_limits(p_tenant, v_limits);
    IF v_over IS NOT NULL THEN
      -- Chosen when it fitted; the business has grown since: it stays on its plan, and the owners are told.
      UPDATE subscriptions SET scheduled_plan_code = NULL WHERE id = s.id;
      INSERT INTO outbox_events (tenant_id, topic, payload)
      VALUES (p_tenant, 'billing.downgrade_dropped', jsonb_build_object('subscriptionId', s.id, 'plan', v_plan, 'limit', v_over));
      INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
      VALUES (p_tenant, 'SYSTEM', 'subscription.changed', 'subscription', s.id::text,
              jsonb_build_object('fromPlan', s.plan_code, 'fromStatus', s.status, 'plan', s.plan_code, 'status', s.status,
                                 'periodEnd', s.current_period_end, 'actor', 'billing',
                                 'reason', 'DOWNGRADE_OVER_LIMITS', 'scheduledPlan', v_plan, 'limit', v_over));
      v_plan := NULL;
    END IF;
  END IF;
  IF v_plan IS NULL THEN SELECT code, monthly_price INTO v_plan, v_price FROM plans WHERE code = s.plan_code; END IF;
  IF v_price IS NULL OR v_price <= 0 THEN RETURN NULL; END IF;
  v_anchor := billing_anchor_for(s.billing_anchor_at, s.current_period_end);
  IF v_anchor IS DISTINCT FROM s.billing_anchor_at THEN
    UPDATE subscriptions SET billing_anchor_at = v_anchor WHERE id = s.id;
  END IF;
  RETURN billing_issue(p_tenant, 'RENEWAL', v_plan, NULL, s.current_period_end, billing_period_end(v_anchor, s.current_period_end),
                       v_price, s.current_period_end);
END $$;--> statement-breakpoint

-- As 0135. A bill paid before its period starts (a renewal paid early, a first bill paid during the trial) keeps
-- the plan in force until then: its plan waits in scheduled_plan_code and the hourly pass applies it (#10).
CREATE OR REPLACE FUNCTION billing_settle(p_bill uuid, p_by text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b billing_bills%ROWTYPE;
  s subscriptions%ROWTYPE;
  v_end timestamptz;
  v_anchor timestamptz;
  v_defer boolean := false;
  r record;
BEGIN
  SELECT * INTO b FROM billing_bills WHERE id = p_bill FOR UPDATE;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = b.tenant_id FOR UPDATE;
  UPDATE billing_bills SET status = 'PAID', paid_at = now() WHERE id = b.id;
  PERFORM billing_expire_checkouts(b.tenant_id, b.id);
  IF b.kind = 'UPGRADE' THEN
    UPDATE subscriptions SET plan_code = b.plan_code, scheduled_plan_code = NULL WHERE id = s.id;
    -- A renewal already issued for the old plan is issued again for the new one.
    FOR r IN SELECT id FROM billing_bills WHERE tenant_id = b.tenant_id AND status = 'OPEN' AND kind <> 'UPGRADE' AND plan_code <> b.plan_code LOOP
      PERFORM billing_void(r.id, 'plan upgraded');
    END LOOP;
    PERFORM billing_renewal_due(b.tenant_id);
    v_end := s.current_period_end;
  ELSE
    IF now() <= b.period_start + interval '7 days' THEN
      v_end := b.period_end;
      v_anchor := CASE WHEN b.kind = 'START' THEN b.period_start ELSE billing_anchor_for(s.billing_anchor_at, b.period_start) END;
      v_defer := b.period_start > now() AND b.plan_code <> s.plan_code;
    ELSE
      -- Paid long after the period began: a full period from today (a long lapse is not charged).
      v_anchor := now();
      v_end := billing_period_end(v_anchor, v_anchor);
    END IF;
    UPDATE subscriptions
       SET plan_code = CASE WHEN v_defer THEN s.plan_code ELSE b.plan_code END,
           status = 'ACTIVE', current_period_end = v_end, grace_ends_at = NULL, cancel_at_period_end = false,
           billing_anchor_at = v_anchor,
           scheduled_plan_code = CASE WHEN v_defer THEN b.plan_code
                                      WHEN scheduled_plan_code = b.plan_code THEN NULL ELSE scheduled_plan_code END
     WHERE id = s.id;
    -- An open upgrade was priced for the period before this one: the owner chooses the plan again.
    FOR r IN SELECT id FROM billing_bills WHERE tenant_id = b.tenant_id AND status = 'OPEN' AND kind = 'UPGRADE' LOOP
      PERFORM billing_void(r.id, 'period renewed');
    END LOOP;
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (b.tenant_id, 'SYSTEM', 'billing.bill_paid', 'billing_bill', b.id::text, jsonb_build_object('number', b.number, 'by', billing_public_by(p_by))),
         (b.tenant_id, 'SYSTEM', 'subscription.changed', 'subscription', s.id::text,
          jsonb_strip_nulls(jsonb_build_object('fromPlan', s.plan_code, 'fromStatus', s.status,
                             'plan', CASE WHEN v_defer THEN s.plan_code ELSE b.plan_code END,
                             'scheduledPlan', CASE WHEN v_defer THEN b.plan_code END,
                             'status', CASE WHEN b.kind = 'UPGRADE' THEN s.status ELSE 'ACTIVE' END,
                             'periodEnd', v_end, 'actor', 'billing', 'reason', 'BILL_PAID', 'bill', b.number)));
END $$;--> statement-breakpoint

-- As 0135, with #8: time before a first month paid ahead (a START bill paid during the trial; its period starts
-- when the trial ends) is the trial's, free, so it is not counted as time no paid bill covers.
CREATE OR REPLACE FUNCTION billing_unused_share(p_tenant uuid, p_end timestamptz) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_share numeric := 0;
  v_covered numeric := 0;
  v_left numeric;
  v_from timestamptz;
BEGIN
  SELECT greatest(now(), coalesce(min(period_start), now())) INTO v_from FROM billing_bills
   WHERE tenant_id = p_tenant AND status = 'PAID' AND kind = 'START' AND period_start > now();
  FOR r IN SELECT period_start, period_end FROM billing_bills
            WHERE tenant_id = p_tenant AND status = 'PAID' AND kind <> 'UPGRADE' AND period_end > now() AND period_end <= p_end LOOP
    v_share := v_share + extract(epoch FROM r.period_end - greatest(r.period_start, now())) / extract(epoch FROM r.period_end - r.period_start);
    v_covered := v_covered + extract(epoch FROM r.period_end - greatest(r.period_start, v_from));
  END LOOP;
  v_left := extract(epoch FROM p_end - v_from) - v_covered;
  IF v_left > 0 THEN
    v_share := v_share + least(1, v_left / extract(epoch FROM p_end - (p_end - interval '1 month')));
  END IF;
  RETURN v_share;
END $$;--> statement-breakpoint

-- As 0135, with #13: an upgrade worth less than ₱20 (below what the payment provider takes) applies at once.
CREATE OR REPLACE FUNCTION billing_choose_plan(p_plan text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  s subscriptions%ROWTYPE;
  np plans%ROWTYPE;
  cp plans%ROWTYPE;
  b billing_bills%ROWTYPE;
  v_amount numeric;
  v_start timestamptz;
  v_kind text;
  v_bill uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no subscription' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO np FROM plans WHERE code = p_plan AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_NOT_AVAILABLE: no active plan %', p_plan USING ERRCODE = '22023'; END IF;
  IF np.monthly_price <= 0 THEN RAISE EXCEPTION 'PLAN_NOT_PRICED: plan % has no price yet', p_plan USING ERRCODE = '22023'; END IF;

  IF s.status = 'ACTIVE' AND s.current_period_end IS NOT NULL AND s.current_period_end > now() THEN
    SELECT * INTO cp FROM plans WHERE code = s.plan_code;
    SELECT * INTO b FROM billing_bills WHERE tenant_id = v_tenant AND status = 'OPEN' AND kind = 'UPGRADE';
    IF FOUND AND b.plan_code = p_plan AND p_plan <> s.plan_code AND np.monthly_price > cp.monthly_price THEN
      -- The same upgrade again (a double click, a retry after no answer): the bill already open, its page and number.
      RETURN jsonb_build_object('effect', 'BILL', 'billId', b.id);
    END IF;
    IF FOUND THEN PERFORM billing_void(b.id, 'another plan chosen'); END IF;
    IF p_plan <> s.plan_code AND np.monthly_price > cp.monthly_price THEN
      v_amount := round((np.monthly_price - cp.monthly_price) * billing_unused_share(v_tenant, s.current_period_end), 2);
      IF v_amount < 20 THEN
        UPDATE subscriptions SET plan_code = p_plan, scheduled_plan_code = NULL WHERE id = s.id;
        RETURN jsonb_build_object('effect', 'NOW');
      END IF;
      v_bill := billing_issue(v_tenant, 'UPGRADE', p_plan, s.plan_code, now(), s.current_period_end, v_amount, now());
      RETURN jsonb_build_object('effect', 'BILL', 'billId', v_bill);
    END IF;
    UPDATE subscriptions SET scheduled_plan_code = CASE WHEN p_plan = s.plan_code THEN NULL ELSE p_plan END WHERE id = s.id;
    PERFORM billing_void(id, 'another plan chosen') FROM billing_bills
      WHERE tenant_id = v_tenant AND status = 'OPEN' AND kind <> 'UPGRADE' AND plan_code <> p_plan;
    PERFORM billing_renewal_due(v_tenant);
    RETURN jsonb_build_object('effect', CASE WHEN p_plan = s.plan_code THEN 'UNCHANGED' ELSE 'AT_RENEWAL' END, 'at', s.current_period_end);
  END IF;

  SELECT * INTO b FROM billing_bills WHERE tenant_id = v_tenant AND status = 'OPEN' AND kind <> 'UPGRADE';
  IF FOUND AND b.plan_code = p_plan THEN RETURN jsonb_build_object('effect', 'BILL', 'billId', b.id); END IF;
  IF FOUND THEN
    v_start := b.period_start;
    v_kind := b.kind;
    PERFORM billing_void(b.id, 'another plan chosen');
  ELSIF s.status = 'TRIALING' AND s.trial_ends_at > now() THEN
    v_start := s.trial_ends_at; v_kind := 'START';
  ELSIF s.status = 'PAST_DUE' AND s.grace_ends_at > now() AND s.current_period_end IS NOT NULL THEN
    v_start := s.current_period_end; v_kind := 'RENEWAL';
  ELSE
    v_start := now(); v_kind := 'START';
  END IF;
  UPDATE subscriptions SET scheduled_plan_code = NULL WHERE id = s.id;
  v_bill := billing_issue(v_tenant, v_kind, p_plan, NULL, v_start,
                          billing_period_end(CASE WHEN v_kind = 'RENEWAL' THEN s.billing_anchor_at END, v_start),
                          np.monthly_price, greatest(v_start, now()));
  RETURN jsonb_build_object('effect', 'BILL', 'billId', v_bill);
END $$;--> statement-breakpoint

-- As 0129, locking the bill's subscription before its checkout (#14): the same order as voids and plan changes.
CREATE OR REPLACE FUNCTION billing_apply_provider_payment(p_provider text, p_event_id text, p_event_type text, p_checkout_id text,
                                               p_payment_ref text, p_amount numeric, p_currency text, p_method text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c billing_checkouts%ROWTYPE;
  v_outcome text;
BEGIN
  IF p_provider NOT IN ('PAYMONGO', 'DEV') THEN RAISE EXCEPTION 'unknown provider' USING ERRCODE = '22023'; END IF;
  INSERT INTO billing_provider_events (provider, event_id, event_type, outcome) VALUES (p_provider, p_event_id, left(p_event_type, 100), 'RECEIVED')
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'DUPLICATE'; END IF;
  SELECT * INTO c FROM billing_checkouts WHERE provider = p_provider AND provider_checkout_id = p_checkout_id;
  IF NOT FOUND THEN
    v_outcome := 'UNKNOWN_CHECKOUT';
  ELSIF p_payment_ref IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    v_outcome := 'NO_PAYMENT';
  ELSE
    PERFORM 1 FROM subscriptions WHERE tenant_id = c.tenant_id FOR UPDATE;
    -- Money came through this page (first, while it is still open: settling closes the bill's other pages).
    UPDATE billing_checkouts SET status = 'PAID' WHERE id = c.id AND status = 'OPEN';
    v_outcome := billing_take_payment(c.bill_id, p_amount, upper(p_currency),
                                      CASE WHEN p_method IN ('CARD', 'GCASH', 'MAYA', 'GRABPAY', 'QRPH', 'BANK_TRANSFER') THEN p_method ELSE 'OTHER' END,
                                      p_provider, p_payment_ref, now(), lower(p_provider), NULL);
  END IF;
  UPDATE billing_provider_events SET outcome = v_outcome WHERE provider = p_provider AND event_id = p_event_id;
  RETURN v_outcome;
END $$;--> statement-breakpoint

-- As 0129, with ops' words kept in a platform row (#1): the business's log gets `support` only.
CREATE OR REPLACE FUNCTION platform_billing_record_payment(p_slug text, p_number text, p_amount numeric, p_method text, p_reference text,
                                                p_received_at timestamptz, p_actor text, p_reason text, p_ticket text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bill uuid;
  v_tenant uuid;
  v_currency text;
  v_outcome text;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('BANK_TRANSFER', 'CARD', 'GCASH', 'MAYA', 'GRABPAY', 'QRPH', 'CASH', 'OTHER') THEN
    RAISE EXCEPTION 'method must be BANK_TRANSFER, CARD, GCASH, MAYA, GRABPAY, QRPH, CASH or OTHER' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'the amount must be more than zero' USING ERRCODE = '22023'; END IF;
  IF coalesce(btrim(p_reference), '') = '' THEN RAISE EXCEPTION 'the bank''s or wallet''s reference is required' USING ERRCODE = '22023'; END IF;
  IF p_received_at IS NULL OR p_received_at > now() + interval '1 day' THEN RAISE EXCEPTION 'the date received is required, not in the future' USING ERRCODE = '22023'; END IF;
  SELECT b.id, b.tenant_id, b.currency INTO v_bill, v_tenant, v_currency FROM billing_bills b JOIN tenants t ON t.id = b.tenant_id
   WHERE t.slug = lower(btrim(p_slug)) AND b.number = upper(btrim(p_number));
  IF v_bill IS NULL THEN RAISE EXCEPTION 'no bill % for the business %', p_number, p_slug USING ERRCODE = 'P0002'; END IF;
  v_outcome := billing_take_payment(v_bill, p_amount, v_currency, p_method, 'MANUAL', btrim(p_reference), p_received_at,
                                    'ops:' || left(btrim(p_actor), 90), left(btrim(p_reason), 300) || ' (ticket ' || left(btrim(p_ticket), 100) || ')');
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', 'support.billing_payment', 'billing_bill', v_bill::text,
          jsonb_build_object('tenantId', v_tenant, 'number', upper(btrim(p_number)), 'amount', round(p_amount, 2)::text, 'outcome', v_outcome,
                             'actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
  RETURN v_outcome;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform_billing_void_bill(p_slug text, p_number text, p_actor text, p_reason text, p_ticket text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b billing_bills%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 OR coalesce(btrim(p_ticket), '') = '' THEN
    RAISE EXCEPTION 'actor, reason and ticket are required' USING ERRCODE = '22023';
  END IF;
  SELECT b2.* INTO b FROM billing_bills b2 JOIN tenants t ON t.id = b2.tenant_id WHERE t.slug = lower(btrim(p_slug)) AND b2.number = upper(btrim(p_number));
  IF NOT FOUND THEN RAISE EXCEPTION 'no bill % for the business %', p_number, p_slug USING ERRCODE = 'P0002'; END IF;
  IF b.status <> 'OPEN' THEN RAISE EXCEPTION 'bill % is %; only an open bill can be voided', b.number, b.status USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM subscriptions WHERE tenant_id = b.tenant_id FOR UPDATE;
  PERFORM billing_void(b.id, 'ops:' || left(btrim(p_actor), 90) || ': ' || left(btrim(p_reason), 150) || ' (ticket ' || left(btrim(p_ticket), 50) || ')');
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', 'support.billing_void', 'billing_bill', b.id::text,
          jsonb_build_object('tenantId', b.tenant_id, 'number', b.number,
                             'actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
END $$;--> statement-breakpoint

-- As 0127, plus #1 (the business's log says `support` and CHANGED_BY_SUPPORT; who, why and the ticket go into a
-- platform row) and #11 (open bills voided, a stop or a scheduled plan cleared: what ops sets is what holds).
CREATE OR REPLACE FUNCTION platform_change_subscription(p_slug text, p_plan_code text, p_status text, p_trial_ends_at timestamptz,
                                             p_period_end timestamptz, p_grace_ends_at timestamptz,
                                             p_actor text, p_reason text, p_ticket text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_before subscriptions%ROWTYPE;
  v_id uuid;
  v_voided int := 0;
  r record;
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
           grace_ends_at = CASE WHEN p_status = 'PAST_DUE' THEN p_grace_ends_at END,
           cancel_at_period_end = false, scheduled_plan_code = NULL
     WHERE id = v_before.id
    RETURNING id INTO v_id;
    -- A bill issued for the state ops replaced would, once paid, undo the change (a comp cut short, a canceled
    -- business made active again): void them, which closes their pages too. The hourly pass bills what is due next.
    FOR r IN SELECT id FROM billing_bills WHERE tenant_id = v_tenant AND status = 'OPEN' LOOP
      PERFORM billing_void(r.id, 'ops:' || left(btrim(p_actor), 90) || ': subscription changed (ticket ' || left(btrim(p_ticket), 50) || ')');
      v_voided := v_voided + 1;
    END LOOP;
  END IF;

  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (v_tenant, 'SYSTEM', NULL, 'subscription.changed', 'subscription', v_id::text,
          jsonb_build_object(
            'fromPlan', v_before.plan_code, 'fromStatus', v_before.status,
            'plan', p_plan_code, 'status', p_status,
            'trialEndsAt', CASE WHEN p_status = 'TRIALING' THEN p_trial_ends_at END,
            'periodEnd', p_period_end,
            'graceEndsAt', CASE WHEN p_status = 'PAST_DUE' THEN p_grace_ends_at END,
            'actor', 'support', 'reason', 'CHANGED_BY_SUPPORT')),
         (NULL, 'SYSTEM', NULL, 'support.subscription_changed', 'subscription', v_id::text,
          jsonb_build_object('tenantId', v_tenant, 'fromPlan', v_before.plan_code, 'fromStatus', v_before.status,
                             'plan', p_plan_code, 'status', p_status, 'periodEnd', p_period_end, 'billsVoided', v_voided,
                             'actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'ticket', left(btrim(p_ticket), 100)));
  RETURN v_tenant;
END $$;--> statement-breakpoint

-- As 0135, with reason codes (#1), the expired pages closed at the provider (#12), the subscription locked before
-- a stale upgrade is voided (#14), and a plan paid for applied when its period starts (#10).
CREATE OR REPLACE FUNCTION platform_billing_tick() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_expired int := 0; v_stale int := 0; v_past_due int := 0; v_canceled int := 0; v_renewals int := 0; v_starts int := 0;
  v_early int := 0; v_last int := 0; v_errors int := 0; v_plans int := 0;
  v_price numeric;
  v_start timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('platform_billing_tick', 0)) THEN
    RETURN jsonb_build_object('skipped', 1);
  END IF;

  BEGIN
    WITH x AS (
      UPDATE billing_checkouts SET status = 'EXPIRED' WHERE status = 'OPEN' AND expires_at <= now()
      RETURNING id, tenant_id, provider, provider_checkout_id),
    ev AS (
      INSERT INTO outbox_events (tenant_id, topic, payload)
      SELECT x.tenant_id, 'billing.checkout_expired', jsonb_build_object('checkoutId', x.id, 'provider', x.provider, 'providerCheckoutId', x.provider_checkout_id)
        FROM x
      RETURNING 1)
    SELECT count(*) INTO v_expired FROM x;
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    RAISE WARNING 'billing pass: expiring stale checkouts failed: %', SQLERRM;
  END;

  FOR r IN SELECT id, tenant_id FROM billing_bills WHERE status = 'OPEN' AND kind = 'UPGRADE' AND period_end <= now() LOOP
    BEGIN
      PERFORM 1 FROM subscriptions WHERE tenant_id = r.tenant_id FOR UPDATE;
      PERFORM billing_void(r.id, 'period ended before it was paid');
      v_stale := v_stale + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: voiding a stale upgrade failed: %', r.tenant_id, SQLERRM;
    END;
  END LOOP;

  -- A plan paid for a period that has now started (a renewal paid early, a first bill paid during the trial).
  FOR r IN SELECT s.* FROM subscriptions s
            WHERE s.status = 'ACTIVE' AND s.scheduled_plan_code IS NOT NULL AND s.scheduled_plan_code <> s.plan_code
              AND EXISTS (SELECT 1 FROM billing_bills b
                           WHERE b.tenant_id = s.tenant_id AND b.status = 'PAID' AND b.kind <> 'UPGRADE'
                             AND b.plan_code = s.scheduled_plan_code AND b.period_start <= now() AND b.period_end > now())
            FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      UPDATE subscriptions SET plan_code = r.scheduled_plan_code, scheduled_plan_code = NULL WHERE id = r.id;
      INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
      VALUES (r.tenant_id, 'SYSTEM', 'subscription.changed', 'subscription', r.id::text,
              jsonb_build_object('fromPlan', r.plan_code, 'fromStatus', r.status, 'plan', r.scheduled_plan_code, 'status', r.status,
                                 'periodEnd', r.current_period_end, 'actor', 'billing', 'reason', 'PAID_PERIOD_STARTED'));
      v_plans := v_plans + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: applying the paid plan failed: %', r.tenant_id, SQLERRM;
    END;
  END LOOP;

  -- Paid-until date reached: PAST_DUE with a week of grace, or CANCELED when the owner asked to stop.
  FOR r IN SELECT * FROM subscriptions WHERE status = 'ACTIVE' AND current_period_end IS NOT NULL AND current_period_end <= now()
           FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      IF r.cancel_at_period_end THEN
        UPDATE subscriptions SET status = 'CANCELED', grace_ends_at = NULL, scheduled_plan_code = NULL WHERE id = r.id;
        PERFORM billing_void(b.id, 'subscription canceled') FROM billing_bills b WHERE b.tenant_id = r.tenant_id AND b.status = 'OPEN';
        INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (r.tenant_id, 'billing.canceled', jsonb_build_object('subscriptionId', r.id));
      ELSE
        UPDATE subscriptions SET status = 'PAST_DUE', grace_ends_at = r.current_period_end + interval '7 days' WHERE id = r.id;
        INSERT INTO outbox_events (tenant_id, topic, payload)
        VALUES (r.tenant_id, 'billing.past_due', jsonb_build_object('subscriptionId', r.id, 'graceEndsAt', r.current_period_end + interval '7 days'));
      END IF;
      INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
      VALUES (r.tenant_id, 'SYSTEM', 'subscription.changed', 'subscription', r.id::text,
              jsonb_build_object('fromPlan', r.plan_code, 'fromStatus', r.status, 'plan', r.plan_code,
                                 'status', CASE WHEN r.cancel_at_period_end THEN 'CANCELED' ELSE 'PAST_DUE' END,
                                 'periodEnd', r.current_period_end,
                                 'graceEndsAt', CASE WHEN r.cancel_at_period_end THEN NULL ELSE r.current_period_end + interval '7 days' END,
                                 'actor', 'billing', 'reason', CASE WHEN r.cancel_at_period_end THEN 'CANCEL_AT_PERIOD_END' ELSE 'PAID_UNTIL_REACHED' END));
      IF r.cancel_at_period_end THEN v_canceled := v_canceled + 1; ELSE v_past_due := v_past_due + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: paid-until date step failed: %', r.tenant_id, SQLERRM;
    END;
  END LOOP;

  FOR r IN SELECT tenant_id FROM subscriptions
            WHERE status IN ('ACTIVE', 'PAST_DUE') AND NOT cancel_at_period_end AND current_period_end IS NOT NULL
              AND current_period_end - interval '7 days' <= now() LOOP
    BEGIN
      IF billing_renewal_due(r.tenant_id) IS NOT NULL THEN v_renewals := v_renewals + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: renewal bill failed: %', r.tenant_id, SQLERRM;
    END;
  END LOOP;

  -- A trial ending within three days (or ended within the last week) gets its first bill, once (a voided one is
  -- issued again). A trial that lapsed long ago gets none: its owner chooses a plan when they come back.
  FOR r IN SELECT s.* FROM subscriptions s
            WHERE s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at - interval '3 days' <= now()
              AND s.trial_ends_at > now() - interval '7 days'
              AND NOT EXISTS (SELECT 1 FROM billing_bills b WHERE b.tenant_id = s.tenant_id AND b.kind <> 'UPGRADE' AND b.status <> 'VOID')
            FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      SELECT monthly_price INTO v_price FROM plans WHERE code = r.plan_code;
      IF v_price > 0 THEN
        v_start := greatest(r.trial_ends_at, now());
        PERFORM billing_issue(r.tenant_id, 'START', r.plan_code, NULL, v_start, billing_period_end(v_start, v_start), v_price, v_start);
        v_starts := v_starts + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: first bill failed: %', r.tenant_id, SQLERRM;
    END;
  END LOOP;

  -- Reminders before the due date (once each): three days before, and the day before. A bill issued
  -- within the last day (or half day) has just been mailed, so it gets no reminder yet.
  BEGIN
    WITH x AS (
      UPDATE billing_bills SET reminded_early_at = now()
       WHERE status = 'OPEN' AND reminded_early_at IS NULL AND reminded_last_at IS NULL
         AND due_at > now() + interval '1 day' AND due_at <= now() + interval '3 days' AND issued_at <= now() - interval '1 day'
      RETURNING id, tenant_id)
    INSERT INTO outbox_events (tenant_id, topic, payload)
    SELECT tenant_id, 'billing.reminder', jsonb_build_object('billId', id, 'when', 'EARLY') FROM x;
    GET DIAGNOSTICS v_early = ROW_COUNT;
    WITH x AS (
      UPDATE billing_bills SET reminded_last_at = now()
       WHERE status = 'OPEN' AND reminded_last_at IS NULL
         AND due_at > now() AND due_at <= now() + interval '1 day' AND issued_at <= now() - interval '12 hours'
      RETURNING id, tenant_id)
    INSERT INTO outbox_events (tenant_id, topic, payload)
    SELECT tenant_id, 'billing.reminder', jsonb_build_object('billId', id, 'when', 'LAST') FROM x;
    GET DIAGNOSTICS v_last = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_early := 0;
    v_last := 0;
    v_errors := v_errors + 1;
    RAISE WARNING 'billing pass: reminders failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('checkoutsExpired', v_expired, 'upgradesVoided', v_stale, 'plansApplied', v_plans, 'pastDue', v_past_due,
                            'canceled', v_canceled, 'renewalBills', v_renewals, 'startBills', v_starts,
                            'remindersEarly', v_early, 'remindersLast', v_last, 'errors', v_errors);
END $$;--> statement-breakpoint

-- #16: turning two-step sign-in off also takes the two-step mark off every
-- session of the person, so a session verified earlier no longer counts as verified if a role later
-- requires it again. Same signature, owner and grants as 0044 (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION auth_mfa_disable(p_user_id uuid, p_correlation_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_user_id;
  DELETE FROM user_mfa_factors WHERE user_id = p_user_id;
  IF FOUND THEN
    UPDATE user_sessions SET mfa_verified_at = NULL WHERE user_id = p_user_id AND mfa_verified_at IS NOT NULL;
    INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id)
    VALUES (NULL, 'USER', p_user_id, 'auth.mfa.disabled', 'user', p_user_id::text, left(p_correlation_id, 200));
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  -- Plain helpers (no definer): run with the rights of the billing definers that call them.
  FOREACH f IN ARRAY ARRAY['billing_reason_code(text)', 'billing_public_by(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_platform', f);
  END LOOP;
END $$;--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM onepos_platform;
