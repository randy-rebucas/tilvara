-- Hand-written: subscription billing (ADR-0027; DDL in 0128).
-- * billing_bills / billing_payments / billing_checkouts: tenant tables the business reads (RLS) and
--   nobody writes but the billing_* definer functions below. A bill's status changes once, from OPEN;
--   payments are append-only; a checkout only moves from OPEN.
-- * billing_provider_events: every accepted provider webhook event, once (no runtime access).
-- * The access rule now ends an ACTIVE subscription a week past its paid-until date even if the
--   billing pass stopped (it makes it PAST_DUE at that date, with the same week of grace).
-- * platform_billing_tick(): the worker's hourly pass — renewal bills a week before the paid-until
--   date, a START bill three days before a trial ends, PAST_DUE (7 days of grace) or CANCELED at the
--   paid-until date, stale checkouts and upgrade bills closed. Plans without a price are never billed.
-- * The owner (API, as onepos_app, in the business's context): billing_choose_plan, billing_set_cancel,
--   billing_record_checkout. The provider's webhook (API, signature checked first):
--   billing_apply_provider_payment. Ops (support CLI, migrator only): platform_billing_*,
--   platform_set_plan_price.

-- ACTIVE: until a week past the paid-until date (NULL = set by ops before billing; open-ended).
CREATE OR REPLACE FUNCTION app_subscription_write_allowed() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT CASE s.status
      WHEN 'ACTIVE'   THEN s.current_period_end IS NULL OR s.current_period_end + interval '7 days' > now()
      WHEN 'TRIALING' THEN s.trial_ends_at IS NULL OR s.trial_ends_at > now()
      WHEN 'PAST_DUE' THEN s.grace_ends_at IS NOT NULL AND s.grace_ends_at > now()
      ELSE false END
    FROM subscriptions s WHERE s.tenant_id = app_current_tenant_id()
  ), false)
$$;--> statement-breakpoint

-- Row guards: only the status columns of an OPEN bill change, once; payments never change.
CREATE FUNCTION app_billing_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'bill % is % and cannot change', OLD.number, OLD.status USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.number, NEW.kind, NEW.plan_code, NEW.from_plan_code, NEW.period_start, NEW.period_end,
      NEW.amount, NEW.currency, NEW.issued_at, NEW.due_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.number, OLD.kind, OLD.plan_code, OLD.from_plan_code, OLD.period_start, OLD.period_end,
      OLD.amount, OLD.currency, OLD.issued_at, OLD.due_at) THEN
    RAISE EXCEPTION 'only a bill''s status changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER billing_bills_guard BEFORE UPDATE ON billing_bills FOR EACH ROW EXECUTE FUNCTION app_billing_bill_guard();--> statement-breakpoint
CREATE TRIGGER billing_bills_no_delete BEFORE DELETE ON billing_bills FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER billing_payments_no_mutation BEFORE UPDATE OR DELETE ON billing_payments FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

CREATE FUNCTION app_billing_checkout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' OR (NEW.id, NEW.tenant_id, NEW.bill_id, NEW.provider, NEW.provider_checkout_id, NEW.checkout_url, NEW.amount,
      NEW.created_by, NEW.created_at, NEW.expires_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.bill_id, OLD.provider,
      OLD.provider_checkout_id, OLD.checkout_url, OLD.amount, OLD.created_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'only an open checkout''s status changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER billing_checkouts_guard BEFORE UPDATE ON billing_checkouts FOR EACH ROW EXECUTE FUNCTION app_billing_checkout_guard();--> statement-breakpoint
CREATE TRIGGER billing_checkouts_no_delete BEFORE DELETE ON billing_checkouts FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER billing_provider_events_no_delete BEFORE DELETE ON billing_provider_events FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

ALTER TABLE billing_bills ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_bills FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_bills USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_payments USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE billing_checkouts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_checkouts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_checkouts USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
-- No policy: nobody but the platform role (BYPASSRLS) sees a row.
ALTER TABLE billing_provider_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_provider_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The business reads its bills, payments and checkouts; it writes none of them.
GRANT SELECT ON billing_bills, billing_payments, billing_checkouts TO onepos_app;--> statement-breakpoint
GRANT SELECT ON billing_bills, billing_payments, billing_checkouts TO onepos_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_bills, billing_checkouts TO onepos_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON billing_payments TO onepos_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_provider_events TO onepos_platform;--> statement-breakpoint
GRANT UPDATE (monthly_price) ON plans TO onepos_platform;--> statement-breakpoint
GRANT SELECT (id, slug, name, status) ON tenants TO onepos_platform;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint

-- ── Internal steps (no EXECUTE for anyone; called by the definers below, which run as their owner) ──

CREATE FUNCTION billing_issue(p_tenant uuid, p_kind text, p_plan text, p_from_plan text, p_start timestamptz,
                              p_end timestamptz, p_amount numeric, p_due timestamptz)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_number text;
  v_currency text;
BEGIN
  SELECT currency INTO v_currency FROM plans WHERE code = p_plan;
  -- Per business, in order; callers hold the subscription row lock, so two bills never take one number.
  SELECT 'B-' || lpad((count(*) + 1)::text, 6, '0') INTO v_number FROM billing_bills WHERE tenant_id = p_tenant;
  INSERT INTO billing_bills (tenant_id, number, kind, plan_code, from_plan_code, period_start, period_end, amount, currency, due_at)
  VALUES (p_tenant, v_number, p_kind, p_plan, p_from_plan, p_start, p_end, round(p_amount, 2), v_currency, p_due)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (p_tenant, 'SYSTEM', 'billing.bill_issued', 'billing_bill', v_id::text,
          jsonb_build_object('number', v_number, 'kind', p_kind, 'plan', p_plan, 'amount', round(p_amount, 2)::text, 'currency', v_currency));
  INSERT INTO outbox_events (tenant_id, topic, payload)
  VALUES (p_tenant, 'billing.bill_issued', jsonb_build_object('billId', v_id, 'number', v_number));
  RETURN v_id;
END $$;--> statement-breakpoint

CREATE FUNCTION billing_void(p_bill uuid, p_reason text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b billing_bills%ROWTYPE;
BEGIN
  UPDATE billing_bills SET status = 'VOID', voided_at = now(), void_reason = left(p_reason, 300)
   WHERE id = p_bill AND status = 'OPEN' RETURNING * INTO b;
  IF FOUND THEN
    UPDATE billing_checkouts SET status = 'EXPIRED' WHERE tenant_id = b.tenant_id AND bill_id = b.id AND status = 'OPEN';
    INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
    VALUES (b.tenant_id, 'SYSTEM', 'billing.bill_voided', 'billing_bill', b.id::text, jsonb_build_object('number', b.number, 'reason', left(p_reason, 300)));
  END IF;
END $$;--> statement-breakpoint

-- The next period's bill once the paid-until date is a week away (or passed, within grace). NULL when
-- none is due: already open, canceling, lapsed (the owner then chooses a plan), or a plan with no price.
CREATE FUNCTION billing_renewal_due(p_tenant uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s subscriptions%ROWTYPE;
  v_plan text;
  v_price numeric;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND OR s.status NOT IN ('ACTIVE', 'PAST_DUE') OR s.cancel_at_period_end OR s.current_period_end IS NULL THEN RETURN NULL; END IF;
  IF s.status = 'ACTIVE' AND s.current_period_end - interval '7 days' > now() THEN RETURN NULL; END IF;
  IF s.status = 'PAST_DUE' AND (s.grace_ends_at IS NULL OR s.grace_ends_at <= now()) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM billing_bills WHERE tenant_id = p_tenant AND status = 'OPEN' AND kind <> 'UPGRADE') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM billing_bills WHERE tenant_id = p_tenant AND status = 'PAID' AND kind <> 'UPGRADE'
                AND period_start = s.current_period_end) THEN RETURN NULL; END IF;
  SELECT code, monthly_price INTO v_plan, v_price FROM plans WHERE code = s.scheduled_plan_code AND active;
  IF v_plan IS NULL THEN SELECT code, monthly_price INTO v_plan, v_price FROM plans WHERE code = s.plan_code; END IF;
  IF v_price IS NULL OR v_price <= 0 THEN RETURN NULL; END IF;
  RETURN billing_issue(p_tenant, 'RENEWAL', v_plan, NULL, s.current_period_end, s.current_period_end + interval '1 month', v_price, s.current_period_end);
END $$;--> statement-breakpoint

-- A bill paid in full: the subscription follows it. START/RENEWAL: ACTIVE on the bill's plan until the
-- bill's period end (re-based on today when paid more than a week after the period began, so a long
-- lapse is not charged). UPGRADE: the new plan now, same period.
CREATE FUNCTION billing_settle(p_bill uuid, p_by text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b billing_bills%ROWTYPE;
  s subscriptions%ROWTYPE;
  v_end timestamptz;
  r record;
BEGIN
  SELECT * INTO b FROM billing_bills WHERE id = p_bill FOR UPDATE;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = b.tenant_id FOR UPDATE;
  UPDATE billing_bills SET status = 'PAID', paid_at = now() WHERE id = b.id;
  UPDATE billing_checkouts SET status = 'EXPIRED' WHERE tenant_id = b.tenant_id AND bill_id = b.id AND status = 'OPEN';
  IF b.kind = 'UPGRADE' THEN
    UPDATE subscriptions SET plan_code = b.plan_code, scheduled_plan_code = NULL WHERE id = s.id;
    -- A renewal already issued for the old plan is issued again for the new one.
    FOR r IN SELECT id FROM billing_bills WHERE tenant_id = b.tenant_id AND status = 'OPEN' AND kind <> 'UPGRADE' AND plan_code <> b.plan_code LOOP
      PERFORM billing_void(r.id, 'plan upgraded');
    END LOOP;
    PERFORM billing_renewal_due(b.tenant_id);
    v_end := s.current_period_end;
  ELSE
    v_end := CASE WHEN now() <= b.period_start + interval '7 days' THEN b.period_end ELSE now() + (b.period_end - b.period_start) END;
    UPDATE subscriptions
       SET plan_code = b.plan_code, status = 'ACTIVE', current_period_end = v_end, grace_ends_at = NULL, cancel_at_period_end = false,
           scheduled_plan_code = CASE WHEN scheduled_plan_code = b.plan_code THEN NULL ELSE scheduled_plan_code END
     WHERE id = s.id;
    -- An open upgrade was priced for the period before this one: the owner chooses the plan again.
    FOR r IN SELECT id FROM billing_bills WHERE tenant_id = b.tenant_id AND status = 'OPEN' AND kind = 'UPGRADE' LOOP
      PERFORM billing_void(r.id, 'period renewed');
    END LOOP;
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (b.tenant_id, 'SYSTEM', 'billing.bill_paid', 'billing_bill', b.id::text, jsonb_build_object('number', b.number, 'by', p_by)),
         (b.tenant_id, 'SYSTEM', 'subscription.changed', 'subscription', s.id::text,
          jsonb_build_object('fromPlan', s.plan_code, 'fromStatus', s.status, 'plan', b.plan_code,
                             'status', CASE WHEN b.kind = 'UPGRADE' THEN s.status ELSE 'ACTIVE' END,
                             'periodEnd', v_end, 'actor', 'billing', 'reason', 'Bill ' || b.number || ' paid'));
END $$;--> statement-breakpoint

-- One payment for a bill, kept whatever happens: applied when the bill is open and the amount and
-- currency match, else kept unapplied (audited) for ops to refund or apply.
CREATE FUNCTION billing_take_payment(p_bill uuid, p_amount numeric, p_currency text, p_method text, p_provider text,
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
                             'provider', p_provider, 'by', left(p_by, 100), 'billStatus', b.status));
  IF v_applied THEN
    PERFORM billing_settle(b.id, p_by);
    RETURN 'APPLIED';
  END IF;
  RETURN 'UNAPPLIED';
END $$;--> statement-breakpoint

-- ── The worker's hourly pass ──

CREATE FUNCTION platform_billing_tick() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_expired int := 0; v_stale int := 0; v_past_due int := 0; v_canceled int := 0; v_renewals int := 0; v_starts int := 0;
  v_price numeric;
BEGIN
  WITH x AS (UPDATE billing_checkouts SET status = 'EXPIRED' WHERE status = 'OPEN' AND expires_at <= now() RETURNING 1)
  SELECT count(*) INTO v_expired FROM x;

  FOR r IN SELECT id FROM billing_bills WHERE status = 'OPEN' AND kind = 'UPGRADE' AND period_end <= now() LOOP
    PERFORM billing_void(r.id, 'period ended before it was paid');
    v_stale := v_stale + 1;
  END LOOP;

  -- Paid-until date reached: PAST_DUE with a week of grace, or CANCELED when the owner asked to stop.
  FOR r IN SELECT * FROM subscriptions WHERE status = 'ACTIVE' AND current_period_end IS NOT NULL AND current_period_end <= now()
           FOR UPDATE SKIP LOCKED LOOP
    IF r.cancel_at_period_end THEN
      UPDATE subscriptions SET status = 'CANCELED', grace_ends_at = NULL, scheduled_plan_code = NULL WHERE id = r.id;
      PERFORM billing_void(b.id, 'subscription canceled') FROM billing_bills b WHERE b.tenant_id = r.tenant_id AND b.status = 'OPEN';
      INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (r.tenant_id, 'billing.canceled', jsonb_build_object('subscriptionId', r.id));
      v_canceled := v_canceled + 1;
    ELSE
      UPDATE subscriptions SET status = 'PAST_DUE', grace_ends_at = r.current_period_end + interval '7 days' WHERE id = r.id;
      INSERT INTO outbox_events (tenant_id, topic, payload)
      VALUES (r.tenant_id, 'billing.past_due', jsonb_build_object('subscriptionId', r.id, 'graceEndsAt', r.current_period_end + interval '7 days'));
      v_past_due := v_past_due + 1;
    END IF;
    INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
    VALUES (r.tenant_id, 'SYSTEM', 'subscription.changed', 'subscription', r.id::text,
            jsonb_build_object('fromPlan', r.plan_code, 'fromStatus', r.status, 'plan', r.plan_code,
                               'status', CASE WHEN r.cancel_at_period_end THEN 'CANCELED' ELSE 'PAST_DUE' END,
                               'periodEnd', r.current_period_end,
                               'graceEndsAt', CASE WHEN r.cancel_at_period_end THEN NULL ELSE r.current_period_end + interval '7 days' END,
                               'actor', 'billing', 'reason', CASE WHEN r.cancel_at_period_end THEN 'Canceled by the owner' ELSE 'Paid-until date reached' END));
  END LOOP;

  FOR r IN SELECT tenant_id FROM subscriptions
            WHERE status IN ('ACTIVE', 'PAST_DUE') AND NOT cancel_at_period_end AND current_period_end IS NOT NULL
              AND current_period_end - interval '7 days' <= now() LOOP
    IF billing_renewal_due(r.tenant_id) IS NOT NULL THEN v_renewals := v_renewals + 1; END IF;
  END LOOP;

  -- A trial ending within three days gets its first bill, once (a voided one is issued again).
  FOR r IN SELECT s.* FROM subscriptions s
            WHERE s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at - interval '3 days' <= now()
              AND NOT EXISTS (SELECT 1 FROM billing_bills b WHERE b.tenant_id = s.tenant_id AND b.kind <> 'UPGRADE' AND b.status <> 'VOID')
            FOR UPDATE SKIP LOCKED LOOP
    SELECT monthly_price INTO v_price FROM plans WHERE code = r.plan_code;
    IF v_price > 0 THEN
      PERFORM billing_issue(r.tenant_id, 'START', r.plan_code, NULL, greatest(r.trial_ends_at, now()),
                            greatest(r.trial_ends_at, now()) + interval '1 month', v_price, greatest(r.trial_ends_at, now()));
      v_starts := v_starts + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('checkoutsExpired', v_expired, 'upgradesVoided', v_stale, 'pastDue', v_past_due,
                            'canceled', v_canceled, 'renewalBills', v_renewals, 'startBills', v_starts);
END $$;--> statement-breakpoint

-- ── The owner, through the API (onepos_app, in the business's own context) ──

-- Choosing a plan. Paid period running: a dearer plan is billed now for the rest of the period
-- (prorated; the plan changes when that bill is paid); one costing no more starts at the next renewal.
-- Otherwise (trial, past due, canceled, lapsed): the period's bill is (re)issued for that plan.
-- The API checks the plan's limits against what the business has first.
CREATE FUNCTION billing_choose_plan(p_plan text)
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
    PERFORM billing_void(id, 'another plan chosen') FROM billing_bills WHERE tenant_id = v_tenant AND status = 'OPEN' AND kind = 'UPGRADE';
    IF p_plan <> s.plan_code AND np.monthly_price > cp.monthly_price THEN
      v_amount := round((np.monthly_price - cp.monthly_price)
                        * least(1, extract(epoch FROM s.current_period_end - now())
                                   / extract(epoch FROM s.current_period_end - (s.current_period_end - interval '1 month'))), 2);
      IF v_amount <= 0 THEN
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
  v_bill := billing_issue(v_tenant, v_kind, p_plan, NULL, v_start, v_start + interval '1 month', np.monthly_price, greatest(v_start, now()));
  RETURN jsonb_build_object('effect', 'BILL', 'billId', v_bill);
END $$;--> statement-breakpoint

-- Stop at the paid-until date (open renewal bill voided), or keep going (the renewal is issued again).
CREATE FUNCTION billing_set_cancel(p_cancel boolean)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  s subscriptions%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM subscriptions WHERE tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND OR s.status <> 'ACTIVE' OR s.current_period_end IS NULL OR s.current_period_end <= now() THEN
    RAISE EXCEPTION 'NOT_ACTIVE: only a paid subscription can be stopped or resumed' USING ERRCODE = '55000';
  END IF;
  UPDATE subscriptions SET cancel_at_period_end = p_cancel, scheduled_plan_code = CASE WHEN p_cancel THEN NULL ELSE scheduled_plan_code END WHERE id = s.id;
  IF p_cancel THEN
    PERFORM billing_void(id, 'canceled by the owner') FROM billing_bills WHERE tenant_id = v_tenant AND status = 'OPEN';
  ELSE
    PERFORM billing_renewal_due(v_tenant);
  END IF;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (v_tenant, 'USER', nullif(current_setting('app.user_id', true), '')::uuid,
          CASE WHEN p_cancel THEN 'subscription.cancel_requested' ELSE 'subscription.resumed' END, 'subscription', s.id::text,
          jsonb_build_object('periodEnd', s.current_period_end));
END $$;--> statement-breakpoint

-- A hosted payment page opened for one of this business's open bills (after the provider answered).
CREATE FUNCTION billing_record_checkout(p_bill uuid, p_provider text, p_checkout_id text, p_url text, p_amount numeric,
                                        p_expires_at timestamptz, p_member uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_current_tenant_id();
  b billing_bills%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501'; END IF;
  SELECT * INTO b FROM billing_bills WHERE id = p_bill AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bill not found' USING ERRCODE = 'P0002'; END IF;
  IF b.status <> 'OPEN' THEN RAISE EXCEPTION 'BILL_NOT_OPEN: bill % is %', b.number, b.status USING ERRCODE = '55000'; END IF;
  IF p_amount <> b.amount THEN RAISE EXCEPTION 'checkout amount differs from the bill' USING ERRCODE = '22023'; END IF;
  INSERT INTO billing_checkouts (tenant_id, bill_id, provider, provider_checkout_id, checkout_url, amount, created_by, expires_at)
  VALUES (v_tenant, b.id, p_provider, p_checkout_id, p_url, b.amount, p_member, p_expires_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;--> statement-breakpoint

-- The provider's webhook (signature checked by the API first). Each event once; the payment must belong
-- to a checkout Tilvara opened, and settles its bill only for the bill's exact amount and currency.
CREATE FUNCTION billing_apply_provider_payment(p_provider text, p_event_id text, p_event_type text, p_checkout_id text,
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
    -- Money came through this page (first, while it is still open: settling closes the bill's other pages).
    UPDATE billing_checkouts SET status = 'PAID' WHERE id = c.id AND status = 'OPEN';
    v_outcome := billing_take_payment(c.bill_id, p_amount, upper(p_currency),
                                      CASE WHEN p_method IN ('CARD', 'GCASH', 'MAYA', 'GRABPAY', 'QRPH', 'BANK_TRANSFER') THEN p_method ELSE 'OTHER' END,
                                      p_provider, p_payment_ref, now(), lower(p_provider), NULL);
  END IF;
  UPDATE billing_provider_events SET outcome = v_outcome WHERE provider = p_provider AND event_id = p_event_id;
  RETURN v_outcome;
END $$;--> statement-breakpoint

-- ── Ops (support CLI; the migrator only) ──

CREATE FUNCTION platform_billing_bills(p_slug text)
  RETURNS TABLE (number text, kind text, plan_code text, period_start timestamptz, period_end timestamptz, amount numeric,
                 currency text, status text, due_at timestamptz, paid_at timestamptz, received numeric, unapplied numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.number, b.kind, b.plan_code, b.period_start, b.period_end, b.amount, b.currency, b.status, b.due_at, b.paid_at,
         coalesce((SELECT sum(p.amount) FROM billing_payments p WHERE p.tenant_id = b.tenant_id AND p.bill_id = b.id AND p.applied), 0),
         coalesce((SELECT sum(p.amount) FROM billing_payments p WHERE p.tenant_id = b.tenant_id AND p.bill_id = b.id AND NOT p.applied), 0)
    FROM billing_bills b JOIN tenants t ON t.id = b.tenant_id
   WHERE t.slug = lower(btrim(p_slug))
   ORDER BY b.issued_at DESC
$$;--> statement-breakpoint

CREATE FUNCTION platform_billing_record_payment(p_slug text, p_number text, p_amount numeric, p_method text, p_reference text,
                                                p_received_at timestamptz, p_actor text, p_reason text, p_ticket text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bill uuid;
  v_currency text;
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
  SELECT b.id, b.currency INTO v_bill, v_currency FROM billing_bills b JOIN tenants t ON t.id = b.tenant_id
   WHERE t.slug = lower(btrim(p_slug)) AND b.number = upper(btrim(p_number));
  IF v_bill IS NULL THEN RAISE EXCEPTION 'no bill % for the business %', p_number, p_slug USING ERRCODE = 'P0002'; END IF;
  RETURN billing_take_payment(v_bill, p_amount, v_currency, p_method, 'MANUAL', btrim(p_reference), p_received_at,
                              'ops:' || left(btrim(p_actor), 90), left(btrim(p_reason), 300) || ' (ticket ' || left(btrim(p_ticket), 100) || ')');
END $$;--> statement-breakpoint

CREATE FUNCTION platform_billing_void_bill(p_slug text, p_number text, p_actor text, p_reason text, p_ticket text)
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
END $$;--> statement-breakpoint

-- A plan's monthly price. Bills already issued keep theirs. Audited as a platform event (no tenant).
CREATE FUNCTION platform_set_plan_price(p_plan text, p_price numeric, p_actor text, p_reason text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_before numeric;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'actor and reason are required' USING ERRCODE = '22023';
  END IF;
  IF p_price IS NULL OR p_price < 0 OR p_price <> round(p_price, 2) THEN
    RAISE EXCEPTION 'the price must be zero or more, in centavos at most' USING ERRCODE = '22023';
  END IF;
  SELECT monthly_price INTO v_before FROM plans WHERE code = p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no plan %', p_plan USING ERRCODE = 'P0002'; END IF;
  UPDATE plans SET monthly_price = p_price WHERE code = p_plan;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', 'plan.price_changed', 'plan', p_plan,
          jsonb_build_object('from', v_before::text, 'to', p_price::text, 'actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500)));
END $$;--> statement-breakpoint

-- What `support subscription-show` prints: the same rule as app_subscription_write_allowed.
CREATE OR REPLACE FUNCTION platform_subscription_of(p_slug text)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_status text, plan_code text, status text,
                 trial_ends_at timestamptz, current_period_end timestamptz, grace_ends_at timestamptz, writable boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status, s.plan_code, s.status, s.trial_ends_at, s.current_period_end, s.grace_ends_at,
         coalesce(CASE s.status
           WHEN 'ACTIVE'   THEN s.current_period_end IS NULL OR s.current_period_end + interval '7 days' > now()
           WHEN 'TRIALING' THEN s.trial_ends_at IS NULL OR s.trial_ends_at > now()
           WHEN 'PAST_DUE' THEN s.grace_ends_at IS NOT NULL AND s.grace_ends_at > now()
           ELSE false END, false)
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
   WHERE t.slug = lower(btrim(p_slug))
$$;--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'billing_issue(uuid, text, text, text, timestamptz, timestamptz, numeric, timestamptz)',
    'billing_void(uuid, text)',
    'billing_renewal_due(uuid)',
    'billing_settle(uuid, text)',
    'billing_take_payment(uuid, numeric, text, text, text, text, timestamptz, text, text)',
    'platform_billing_tick()',
    'billing_choose_plan(text)',
    'billing_set_cancel(boolean)',
    'billing_record_checkout(uuid, text, text, text, numeric, timestamptz, uuid)',
    'billing_apply_provider_payment(text, text, text, text, text, numeric, text, text)',
    'platform_billing_bills(text)',
    'platform_billing_record_payment(text, text, numeric, text, text, timestamptz, text, text, text)',
    'platform_billing_void_bill(text, text, text, text, text)',
    'platform_set_plan_price(text, numeric, text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION platform_billing_tick() TO onepos_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_choose_plan(text), billing_set_cancel(boolean),
  billing_record_checkout(uuid, text, text, text, numeric, timestamptz, uuid),
  billing_apply_provider_payment(text, text, text, text, text, numeric, text, text) TO onepos_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_billing_tick(), platform_billing_bills(text),
  platform_billing_record_payment(text, text, numeric, text, text, timestamptz, text, text, text),
  platform_billing_void_bill(text, text, text, text, text), platform_set_plan_price(text, numeric, text, text) TO onepos_migrator;
