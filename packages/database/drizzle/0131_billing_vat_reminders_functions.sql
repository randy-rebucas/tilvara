-- Hand-written: subscription billing, the user's decisions on the open items (session 44, ADR-0027; DDL in 0130).
-- * Tilvara is VAT-registered: prices are VAT-inclusive at 12%, and each bill keeps the VAT inside its
--   amount (`vat_amount`, fixed at issue like the amount). Bills issued before this get theirs here.
-- * Reminders before a bill is due: `billing.reminder` mails three days before and the day before the due
--   date, once each (`reminded_early_at`, `reminded_last_at`), from the hourly pass.
-- * Partial payments stay refused: only a bill's exact amount settles it (billing_take_payment, unchanged).

-- The guard keeps the VAT fixed too; reminder stamps may change while the bill is open.
CREATE OR REPLACE FUNCTION app_billing_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'bill % is % and cannot change', OLD.number, OLD.status USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.number, NEW.kind, NEW.plan_code, NEW.from_plan_code, NEW.period_start, NEW.period_end,
      NEW.amount, NEW.currency, NEW.issued_at, NEW.due_at, NEW.vat_amount)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.number, OLD.kind, OLD.plan_code, OLD.from_plan_code, OLD.period_start, OLD.period_end,
      OLD.amount, OLD.currency, OLD.issued_at, OLD.due_at, OLD.vat_amount) THEN
    RAISE EXCEPTION 'only a bill''s status changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- Bills issued before this migration: their VAT, as billing_issue now computes it (the migrator, under FORCE RLS,
-- would see no rows: NO FORCE for the backfill; the guard is off for it, since paid bills never change otherwise).
ALTER TABLE billing_bills NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_bills DISABLE TRIGGER billing_bills_guard;--> statement-breakpoint
UPDATE billing_bills SET vat_amount = round(amount * 12 / 112, 2) WHERE vat_amount = 0;--> statement-breakpoint
ALTER TABLE billing_bills ENABLE TRIGGER billing_bills_guard;--> statement-breakpoint
ALTER TABLE billing_bills FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_issue(p_tenant uuid, p_kind text, p_plan text, p_from_plan text, p_start timestamptz,
                                         p_end timestamptz, p_amount numeric, p_due timestamptz)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_number text;
  v_currency text;
  v_amount numeric := round(p_amount, 2);
BEGIN
  SELECT currency INTO v_currency FROM plans WHERE code = p_plan;
  -- Per business, in order; callers hold the subscription row lock, so two bills never take one number.
  SELECT 'B-' || lpad((count(*) + 1)::text, 6, '0') INTO v_number FROM billing_bills WHERE tenant_id = p_tenant;
  -- Prices include 12% VAT (Tilvara is VAT-registered): the VAT inside is amount × 12/112.
  INSERT INTO billing_bills (tenant_id, number, kind, plan_code, from_plan_code, period_start, period_end, amount, vat_amount, currency, due_at)
  VALUES (p_tenant, v_number, p_kind, p_plan, p_from_plan, p_start, p_end, v_amount, round(v_amount * 12 / 112, 2), v_currency, p_due)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (p_tenant, 'SYSTEM', 'billing.bill_issued', 'billing_bill', v_id::text,
          jsonb_build_object('number', v_number, 'kind', p_kind, 'plan', p_plan, 'amount', v_amount::text, 'currency', v_currency));
  INSERT INTO outbox_events (tenant_id, topic, payload)
  VALUES (p_tenant, 'billing.bill_issued', jsonb_build_object('billId', v_id, 'number', v_number));
  RETURN v_id;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform_billing_tick() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_expired int := 0; v_stale int := 0; v_past_due int := 0; v_canceled int := 0; v_renewals int := 0; v_starts int := 0; v_early int := 0; v_last int := 0;
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

  -- Reminders before the due date (once each): three days before, and the day before. A bill issued
  -- within the last day (or half day) has just been mailed, so it gets no reminder yet.
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

  RETURN jsonb_build_object('checkoutsExpired', v_expired, 'upgradesVoided', v_stale, 'pastDue', v_past_due,
                            'canceled', v_canceled, 'renewalBills', v_renewals, 'startBills', v_starts,
                            'remindersEarly', v_early, 'remindersLast', v_last);
END $$;--> statement-breakpoint

DROP FUNCTION platform_billing_bills(text);--> statement-breakpoint
CREATE FUNCTION platform_billing_bills(p_slug text)
  RETURNS TABLE (number text, kind text, plan_code text, period_start timestamptz, period_end timestamptz, amount numeric,
                 vat_amount numeric, currency text, status text, due_at timestamptz, paid_at timestamptz, received numeric, unapplied numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.number, b.kind, b.plan_code, b.period_start, b.period_end, b.amount, b.vat_amount, b.currency, b.status, b.due_at, b.paid_at,
         coalesce((SELECT sum(p.amount) FROM billing_payments p WHERE p.tenant_id = b.tenant_id AND p.bill_id = b.id AND p.applied), 0),
         coalesce((SELECT sum(p.amount) FROM billing_payments p WHERE p.tenant_id = b.tenant_id AND p.bill_id = b.id AND NOT p.applied), 0)
    FROM billing_bills b JOIN tenants t ON t.id = b.tenant_id
   WHERE t.slug = lower(btrim(p_slug))
   ORDER BY b.issued_at DESC
$$;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION platform_billing_bills(text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_billing_bills(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_billing_bills(text) TO onepos_migrator;
