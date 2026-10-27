-- Hand-written: third audit (docs/AUDIT-2026-10-27.md), database fixes (DDL in 0134).
-- * Count sheets (#7, ADR-0012 amendment 3): the costing trigger numbers each balance's movements
--   (`stock_balances.movement_seq`, `stock_movements.balance_seq`, under the balance lock). A sheet line keeps the
--   number it was frozen at (`frozen_seq`), so the API posts each line against the book quantity when it was
--   counted: frozen + the movements after the freeze that happened by then (inventory.service.ts).
-- * Billing: the same upgrade chosen again returns its open bill (#4); a voided or settled bill's open payment
--   pages are closed at the provider through the outbox (`billing.checkout_expired`, #3; the dev page asks
--   billing_dev_checkout_open); periods end on the anchor's day of the month in Asia/Manila
--   (`subscriptions.billing_anchor_at`, #19); an upgrade after an early-paid renewal pays for the paid period
--   too (#18); a scheduled downgrade the business no longer fits is dropped at renewal (#17,
--   `billing.downgrade_dropped`); the hourly pass runs once at a time, each business on its own savepoint, and
--   counts failures (`errors`, #5); START bills only for trials that ended in the last week (#20).
-- * Data export (#6): the worker no longer reads ops' own words (billing_payments.note / recorded_by,
--   billing_bills.void_reason).
-- * auth_api_key (#22): a key's scopes are cut to what its creator holds business-wide now.
-- * auth_terminal (#28): returns the business's status (the API refuses all but ACTIVE and SUSPENDED).

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint

-- 1. Costing trigger: as 0126, plus the balance's movement number --------------------------------------
CREATE OR REPLACE FUNCTION app_cost_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b stock_balances%ROWTYPE;
  q_after numeric;
  v_after numeric;
  avg_after numeric;
  counted numeric;
  expected numeric;
  rp numeric;
  policy text;
  alerts boolean;
  o record;
  out_value numeric;
BEGIN
  -- A row for another business than the one in context is refused before anything is read or written as
  -- the platform role (session 2026-10-27): RLS checks the row only after this BEFORE trigger has run.
  PERFORM app_assert_row_tenant(NEW.tenant_id);
  -- Pack openings (ADR-0020): each movement is the opening's packs out or pieces in, once.
  IF NEW.type IN ('UNPACK_OUT', 'UNPACK_IN') THEN
    SELECT p.branch_id, p.packs, p.pieces, c.pack_variant_id, c.piece_variant_id INTO o
      FROM pack_openings p JOIN pack_conversions c ON c.tenant_id = p.tenant_id AND c.id = p.conversion_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.pack_opening_id;
    IF o.branch_id IS DISTINCT FROM NEW.branch_id
       OR (NEW.type = 'UNPACK_OUT' AND (NEW.variant_id <> o.pack_variant_id OR NEW.quantity <> -o.packs))
       OR (NEW.type = 'UNPACK_IN' AND (NEW.variant_id <> o.piece_variant_id OR NEW.quantity <> o.pieces))
       OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = NEW.type) THEN
      RAISE EXCEPTION 'pack movement does not match its opening' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
    END IF;
  END IF;

  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, value, avg_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, 0, 0, 0, now())
  ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING;
  SELECT * INTO b FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id
   FOR UPDATE;

  IF NEW.type = 'COUNT' THEN
    SELECT l.counted_quantity, l.expected_quantity INTO counted, expected FROM stock_count_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.stock_count_line_id AND l.variant_id = NEW.variant_id;
    IF counted IS NULL THEN
      RAISE EXCEPTION 'count movement without its count line' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_count_link';
    END IF;
    -- From a count sheet: the difference against the book quantity when the line was counted (the API works
    -- it out from the frozen quantity, audit 45 #7); else set on hand to the count.
    NEW.quantity := counted - coalesce(expected, b.quantity);
    IF NEW.quantity = 0 THEN
      RETURN NULL; -- nothing to move
    END IF;
    NEW.unit_cost := NULL;
  END IF;
  q_after := b.quantity + NEW.quantity;

  IF NEW.quantity < 0 THEN
    NEW.unit_cost := b.avg_cost;
    NEW.value := CASE WHEN q_after = 0 THEN -b.value ELSE round(NEW.quantity * b.avg_cost, 4) END;
    v_after := b.value + NEW.value;
    avg_after := b.avg_cost;
    NEW.below_zero := q_after < 0;
  ELSE
    IF NEW.type = 'RETURN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.sale_line_id = NEW.sale_line_id AND m.type = 'SALE'
       ORDER BY m.created_at, m.id LIMIT 1;
    ELSIF NEW.type = 'TRANSFER_IN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.stock_transfer_line_id = NEW.stock_transfer_line_id AND m.type = 'TRANSFER_OUT';
    ELSIF NEW.type = 'UNPACK_IN' THEN
      -- The pieces carry what the packs took out (the packs leave first, in the same transaction).
      SELECT m.value INTO out_value FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = 'UNPACK_OUT';
      IF out_value IS NULL THEN
        RAISE EXCEPTION 'pieces from a pack that has not left stock' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
      END IF;
      NEW.unit_cost := round(-out_value / NEW.quantity, 4);
    ELSIF NEW.type = 'COUNT' THEN
      SELECT CASE WHEN b.avg_cost > 0 THEN b.avg_cost ELSE coalesce(v.reference_cost, 0) END INTO NEW.unit_cost
        FROM product_variants v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
    END IF;
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'inbound stock movement (%) needs a unit cost', NEW.type
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_unit_cost_required';
    END IF;
    IF NEW.type = 'UNPACK_IN' AND b.quantity >= 0 THEN
      -- Exactly the packs' value, so an opening moves no value in the books.
      v_after := b.value - out_value;
      avg_after := round(v_after / q_after, 4);
    ELSIF b.quantity > 0 THEN
      v_after := b.value + round(NEW.quantity * NEW.unit_cost, 4);
      avg_after := round(v_after / q_after, 4);
    ELSE
      avg_after := NEW.unit_cost;
      v_after := round(q_after * NEW.unit_cost, 4);
    END IF;
    NEW.value := v_after - b.value;
    NEW.below_zero := false;
  END IF;

  -- This movement's place in the balance's order, taken under the lock (whatever the caller sent).
  NEW.balance_seq := b.movement_seq + 1;
  UPDATE stock_balances
     SET quantity = q_after, value = v_after, avg_cost = avg_after, movement_seq = b.movement_seq + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id;

  -- Alerts: only when going down, and only on the crossing, so a busy day mails once per item.
  IF NEW.quantity < 0 THEN
    SELECT s.negative_stock_policy, s.low_stock_alerts INTO policy, alerts FROM inventory_settings s
     WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id;
    policy := coalesce(policy, 'ALLOW');
    alerts := coalesce(alerts, true);
    IF alerts THEN
      SELECT r.reorder_point INTO rp FROM reorder_points r
       WHERE r.tenant_id = NEW.tenant_id AND r.branch_id = NEW.branch_id AND r.variant_id = NEW.variant_id;
      IF rp IS NOT NULL AND b.quantity > rp AND q_after <= rp THEN
        INSERT INTO outbox_events (tenant_id, topic, payload)
        VALUES (NEW.tenant_id, 'stock.low', jsonb_build_object(
          'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
          'quantity', q_after::text, 'reorderPoint', rp::text));
      END IF;
    END IF;
    IF policy <> 'ALLOW' AND b.quantity >= 0 AND q_after < 0 THEN
      INSERT INTO outbox_events (tenant_id, topic, payload)
      VALUES (NEW.tenant_id, 'stock.below_zero', jsonb_build_object(
        'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
        'quantity', q_after::text, 'saleId', NEW.sale_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 2. API keys: scopes the creator still holds business-wide (as 0126 otherwise) -------------------------
GRANT SELECT (id, tenant_id, archived_at) ON roles TO onepos_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_api_key(p_prefix text, p_key_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid, name text, scopes text[], created_by uuid, tenant_status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE api_keys k SET last_used_at = now()
   WHERE k.prefix = p_prefix AND k.key_hash = p_key_hash AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute');
  RETURN QUERY
    SELECT k.id, k.tenant_id, k.name,
           -- A key never reads more than the person who made it may read now (a demoted creator's key loses the scope).
           ARRAY(SELECT x.scope FROM unnest(k.scopes) WITH ORDINALITY AS x(scope, n)
                  WHERE EXISTS (SELECT 1 FROM membership_roles mr
                                  JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.archived_at IS NULL
                                  JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
                                 WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id AND mr.scope_type = 'TENANT'
                                   AND rp.permission_code = x.scope)
                  ORDER BY x.n),
           k.created_by, t.status
      FROM api_keys k
      JOIN tenants t ON t.id = k.tenant_id
      JOIN tenant_memberships m ON m.tenant_id = k.tenant_id AND m.user_id = k.created_by AND m.status = 'ACTIVE'
      JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
     WHERE k.prefix = p_prefix AND k.key_hash = p_key_hash AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now());
END $$;--> statement-breakpoint

-- 3. Terminals: the business's status too (the API refuses a till of a business being closed) ----------
DROP FUNCTION auth_terminal(uuid, text);--> statement-breakpoint
CREATE FUNCTION auth_terminal(p_terminal_id uuid, p_credential_hash text)
  RETURNS TABLE (tenant_id uuid, register_id uuid, status text, tenant_status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE terminals t SET last_seen_at = now()
   WHERE t.id = p_terminal_id AND t.credential_hash = p_credential_hash AND t.status = 'ACTIVE'
     AND EXISTS (SELECT 1 FROM tenants x WHERE x.id = t.tenant_id AND x.status IN ('ACTIVE', 'SUSPENDED'));
  RETURN QUERY SELECT t.tenant_id, t.register_id, t.status, x.status
                 FROM terminals t JOIN tenants x ON x.id = t.tenant_id
                WHERE t.id = p_terminal_id AND t.credential_hash = p_credential_hash;
END $$;--> statement-breakpoint
ALTER FUNCTION auth_terminal(uuid, text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_terminal(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_terminal(uuid, text) TO onepos_app;--> statement-breakpoint

-- 4. Data export: ops' own words stay out of the business's copy --------------------------------------
-- The worker reads every other column (mails need none of these); EXPORT_SECRET_COLUMNS lists them.
REVOKE SELECT ON billing_bills, billing_payments FROM onepos_worker;--> statement-breakpoint
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'billing_bills' AND column_name <> 'void_reason';
  EXECUTE format('GRANT SELECT (%s) ON billing_bills TO onepos_worker', cols);
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'billing_payments' AND column_name NOT IN ('note', 'recorded_by');
  EXECUTE format('GRANT SELECT (%s) ON billing_payments TO onepos_worker', cols);
END $$;--> statement-breakpoint

-- 5. Billing ----------------------------------------------------------------------------------------
GRANT SELECT (id, tenant_id, archived_at) ON registers TO onepos_platform;--> statement-breakpoint

-- The anchor a period starting at p_start counts from: p_anchor when p_start is on its sequence (the anchor's
-- day of the month, n months on, in Philippine time), else p_start itself (a new sequence).
CREATE FUNCTION billing_anchor_for(p_anchor timestamptz, p_start timestamptz) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  a timestamp;
  s timestamp;
  n int;
BEGIN
  IF p_anchor IS NULL OR p_anchor > p_start THEN RETURN p_start; END IF;
  a := p_anchor AT TIME ZONE 'Asia/Manila';
  s := p_start AT TIME ZONE 'Asia/Manila';
  n := ((extract(year FROM s) - extract(year FROM a)) * 12 + extract(month FROM s) - extract(month FROM a))::int;
  IF a + make_interval(months => n) = s THEN RETURN p_anchor; END IF;
  RETURN p_start;
END $$;--> statement-breakpoint

-- Where the period starting at p_start ends: the next date on the anchor's sequence (Jan 31 → Feb 28 → Mar 31).
CREATE FUNCTION billing_period_end(p_anchor timestamptz, p_start timestamptz) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  a timestamp := billing_anchor_for(p_anchor, p_start) AT TIME ZONE 'Asia/Manila';
  s timestamp := p_start AT TIME ZONE 'Asia/Manila';
  n int;
BEGIN
  n := ((extract(year FROM s) - extract(year FROM a)) * 12 + extract(month FROM s) - extract(month FROM a))::int;
  RETURN (a + make_interval(months => n + 1)) AT TIME ZONE 'Asia/Manila';
END $$;--> statement-breakpoint

-- The first plan limit (as the API's usageOf counts) the business has more of than p_limits allow; NULL if none.
CREATE FUNCTION billing_over_limits(p_tenant uuid, p_limits jsonb) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT u.k FROM (VALUES
      (1, 'maxLegalEntities', (SELECT count(*) FROM legal_entities WHERE tenant_id = p_tenant AND archived_at IS NULL)),
      (2, 'maxBranches', (SELECT count(*) FROM branches WHERE tenant_id = p_tenant AND archived_at IS NULL)),
      (3, 'maxRegisters', (SELECT count(*) FROM registers WHERE tenant_id = p_tenant AND archived_at IS NULL)),
      (4, 'maxUsers', (SELECT count(*) FROM tenant_memberships WHERE tenant_id = p_tenant AND status IN ('ACTIVE', 'SUSPENDED'))
                    + (SELECT count(*) FROM member_invitations WHERE tenant_id = p_tenant AND status = 'PENDING' AND expires_at > now()))
    ) AS u(n, k, used)
   WHERE p_limits ? u.k AND u.used > (p_limits ->> u.k)::numeric
   ORDER BY u.n LIMIT 1
$$;--> statement-breakpoint

-- What is left of the paid time, in months of the plan: each paid period's unused share (a renewal paid early
-- counts in full), plus time no paid bill covers (set by ops) at a month's rate, at most one month.
CREATE FUNCTION billing_unused_share(p_tenant uuid, p_end timestamptz) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_share numeric := 0;
  v_covered numeric := 0;
  v_left numeric;
BEGIN
  FOR r IN SELECT period_start, period_end FROM billing_bills
            WHERE tenant_id = p_tenant AND status = 'PAID' AND kind <> 'UPGRADE' AND period_end > now() AND period_end <= p_end LOOP
    v_share := v_share + extract(epoch FROM r.period_end - greatest(r.period_start, now())) / extract(epoch FROM r.period_end - r.period_start);
    v_covered := v_covered + extract(epoch FROM r.period_end - greatest(r.period_start, now()));
  END LOOP;
  v_left := extract(epoch FROM p_end - now()) - v_covered;
  IF v_left > 0 THEN
    v_share := v_share + least(1, v_left / extract(epoch FROM p_end - (p_end - interval '1 month')));
  END IF;
  RETURN v_share;
END $$;--> statement-breakpoint

-- Closes a bill's open payment pages; the worker closes each at the provider (`billing.checkout_expired`).
CREATE FUNCTION billing_expire_checkouts(p_tenant uuid, p_bill uuid) RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH x AS (
    UPDATE billing_checkouts SET status = 'EXPIRED'
     WHERE tenant_id = p_tenant AND bill_id = p_bill AND status = 'OPEN'
    RETURNING id, provider, provider_checkout_id),
  ev AS (
    INSERT INTO outbox_events (tenant_id, topic, payload)
    SELECT p_tenant, 'billing.checkout_expired', jsonb_build_object('checkoutId', x.id, 'provider', x.provider, 'providerCheckoutId', x.provider_checkout_id)
      FROM x
    RETURNING 1)
  SELECT count(*)::int FROM x
$$;--> statement-breakpoint

-- The dev simulator's page (BILLING_PROVIDER=dev) pays only while its checkout is open, as PayMongo's would.
CREATE FUNCTION billing_dev_checkout_open(p_checkout_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT status = 'OPEN' FROM billing_checkouts WHERE provider = 'DEV' AND provider_checkout_id = p_checkout_id), false)
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
    VALUES (b.tenant_id, 'SYSTEM', 'billing.bill_voided', 'billing_bill', b.id::text, jsonb_build_object('number', b.number, 'reason', left(p_reason, 300)));
  END IF;
END $$;--> statement-breakpoint

-- As 0129, with the anchored period end (#19) and a scheduled downgrade the business no longer fits dropped (#17).
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
                                 'reason', 'Move to ' || v_plan || ' dropped: the business has more than it allows (' || v_over || ')'));
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

-- As 0129: the bill's other pages closed at the provider too (#3), and the anchor kept (#19).
CREATE OR REPLACE FUNCTION billing_settle(p_bill uuid, p_by text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b billing_bills%ROWTYPE;
  s subscriptions%ROWTYPE;
  v_end timestamptz;
  v_anchor timestamptz;
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
    ELSE
      -- Paid long after the period began: a full period from today (a long lapse is not charged).
      v_anchor := now();
      v_end := billing_period_end(v_anchor, v_anchor);
    END IF;
    UPDATE subscriptions
       SET plan_code = b.plan_code, status = 'ACTIVE', current_period_end = v_end, grace_ends_at = NULL, cancel_at_period_end = false,
           billing_anchor_at = v_anchor,
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

-- As 0129, with #4 (the same upgrade again returns its open bill), #18 (proration over the paid time) and #19.
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
  v_bill := billing_issue(v_tenant, v_kind, p_plan, NULL, v_start,
                          billing_period_end(CASE WHEN v_kind = 'RENEWAL' THEN s.billing_anchor_at END, v_start),
                          np.monthly_price, greatest(v_start, now()));
  RETURN jsonb_build_object('effect', 'BILL', 'billId', v_bill);
END $$;--> statement-breakpoint

-- The worker's hourly pass (as 0131), once at a time (#5): a second caller while one runs is told `skipped`.
-- Each business (and each set-based step) runs on its own savepoint: one that fails is rolled back alone,
-- logged (WARNING) and counted in `errors`, which the worker exports; the rest of the pass commits.
-- START bills only for trials that ended within the last week (#20): an older lapse chooses a plan itself.
CREATE OR REPLACE FUNCTION platform_billing_tick() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_expired int := 0; v_stale int := 0; v_past_due int := 0; v_canceled int := 0; v_renewals int := 0; v_starts int := 0;
  v_early int := 0; v_last int := 0; v_errors int := 0;
  v_price numeric;
  v_start timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('platform_billing_tick', 0)) THEN
    RETURN jsonb_build_object('skipped', 1);
  END IF;

  BEGIN
    WITH x AS (UPDATE billing_checkouts SET status = 'EXPIRED' WHERE status = 'OPEN' AND expires_at <= now() RETURNING 1)
    SELECT count(*) INTO v_expired FROM x;
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    RAISE WARNING 'billing pass: expiring stale checkouts failed: %', SQLERRM;
  END;

  FOR r IN SELECT id, tenant_id FROM billing_bills WHERE status = 'OPEN' AND kind = 'UPGRADE' AND period_end <= now() LOOP
    BEGIN
      PERFORM billing_void(r.id, 'period ended before it was paid');
      v_stale := v_stale + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'billing pass: business %: voiding a stale upgrade failed: %', r.tenant_id, SQLERRM;
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
                                 'actor', 'billing', 'reason', CASE WHEN r.cancel_at_period_end THEN 'Canceled by the owner' ELSE 'Paid-until date reached' END));
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

  RETURN jsonb_build_object('checkoutsExpired', v_expired, 'upgradesVoided', v_stale, 'pastDue', v_past_due,
                            'canceled', v_canceled, 'renewalBills', v_renewals, 'startBills', v_starts,
                            'remindersEarly', v_early, 'remindersLast', v_last, 'errors', v_errors);
END $$;--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'billing_expire_checkouts(uuid, uuid)',
    'billing_dev_checkout_open(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  -- Plain helpers (no definer): run with the rights of the billing definers that call them.
  FOREACH f IN ARRAY ARRAY[
    'billing_anchor_for(timestamptz, timestamptz)',
    'billing_period_end(timestamptz, timestamptz)',
    'billing_over_limits(uuid, jsonb)',
    'billing_unused_share(uuid, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_platform', f);
  END LOOP;
END $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_dev_checkout_open(text) TO onepos_app;--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint

-- Anchors of the subscriptions already paid: the start of the paid bill that set the paid-until date, else that
-- date itself (the migrator, under FORCE RLS, would see no rows: NO FORCE while it reads and writes them).
ALTER TABLE subscriptions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_bills NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE subscriptions s
   SET billing_anchor_at = coalesce(
         (SELECT b.period_start FROM billing_bills b
           WHERE b.tenant_id = s.tenant_id AND b.status = 'PAID' AND b.kind <> 'UPGRADE' AND b.period_end = s.current_period_end
           ORDER BY b.issued_at DESC LIMIT 1),
         s.current_period_end)
 WHERE s.current_period_end IS NOT NULL AND s.billing_anchor_at IS NULL;--> statement-breakpoint
ALTER TABLE billing_bills FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
