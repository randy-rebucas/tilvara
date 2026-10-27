-- Hand-written: receipts for subscription payments and the first plan prices (session 44, ADR-0027; DDL in 0132).
-- * billing_seller: Tilvara as issuer (registered name, TIN, address, VAT registration, permit line), one row,
--   set by ops (`support billing-seller`, platform_set_billing_seller, audited); no runtime access.
-- * billing_receipts: a system-generated receipt for every payment that settled a bill, numbered in one series
--   for Tilvara (R-00000001…, gapless: taken under an advisory lock in the paying transaction), seller and buyer
--   copied as they were; append-only. The owners get it by mail (`billing.receipt_issued`) and in the app.
--   Payments settled before this migration get theirs here (not mailed).
-- * First prices (the user's decision, VAT included): Starter 999, Growth 2,499, Enterprise 5,999 a month;
--   only plans still at the placeholder 0 are changed.

ALTER TABLE billing_receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_receipts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_receipts USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
CREATE TRIGGER billing_receipts_no_mutation BEFORE UPDATE OR DELETE ON billing_receipts FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
GRANT SELECT ON billing_receipts TO onepos_app, onepos_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON billing_receipts TO onepos_platform;--> statement-breakpoint

-- No policy: only the platform role (BYPASSRLS) reads or writes it.
ALTER TABLE billing_seller ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_seller FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER billing_seller_no_delete BEFORE DELETE ON billing_seller FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_seller TO onepos_platform;--> statement-breakpoint
GRANT SELECT (id, tenant_id, registered_name, trade_name, tin, registered_address, archived_at, created_at) ON legal_entities TO onepos_platform;--> statement-breakpoint
ALTER TABLE billing_seller NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO billing_seller (registered_name) VALUES ('Tilvara') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE billing_seller FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint

-- The receipt for an applied payment (once per payment). `p_notify`: mail the owners.
CREATE FUNCTION billing_issue_receipt(p_payment uuid, p_notify boolean)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  y billing_payments%ROWTYPE;
  b billing_bills%ROWTYPE;
  s billing_seller%ROWTYPE;
  v_plan text;
  v_id uuid;
  v_number text;
  v_buyer jsonb;
  v_vat numeric;
  v_desc text;
  day text := 'YYYY-MM-DD';
BEGIN
  SELECT * INTO y FROM billing_payments WHERE id = p_payment;
  IF NOT FOUND OR NOT y.applied THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM billing_receipts WHERE payment_id = p_payment;
  IF FOUND THEN RETURN v_id; END IF;
  SELECT * INTO b FROM billing_bills WHERE id = y.bill_id;
  SELECT name INTO v_plan FROM plans WHERE code = b.plan_code;
  SELECT * INTO s FROM billing_seller WHERE id;
  -- One series for Tilvara: the next number under a lock held to the end of this transaction (no gaps, no twins).
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_receipt_number', 0));
  SELECT 'R-' || lpad((coalesce(max(substr(number, 3)::bigint), 0) + 1)::text, 8, '0') INTO v_number FROM billing_receipts;
  SELECT jsonb_build_object('businessName', t.name, 'registeredName', le.registered_name, 'tradeName', le.trade_name,
                            'tin', le.tin, 'address', le.registered_address)
    INTO v_buyer
    FROM tenants t
    LEFT JOIN LATERAL (SELECT l.registered_name, l.trade_name, l.tin, l.registered_address FROM legal_entities l
                        WHERE l.tenant_id = t.id AND l.archived_at IS NULL ORDER BY l.created_at LIMIT 1) le ON true
   WHERE t.id = y.tenant_id;
  v_vat := CASE WHEN coalesce(s.vat_registered, true) THEN b.vat_amount ELSE 0 END;
  v_desc := 'Tilvara ' || v_plan || ' plan' ||
            CASE WHEN b.kind = 'UPGRADE' THEN ' (upgrade), until ' || to_char(b.period_end AT TIME ZONE 'Asia/Manila', day)
                 ELSE ', ' || to_char(b.period_start AT TIME ZONE 'Asia/Manila', day) || ' to ' || to_char(b.period_end AT TIME ZONE 'Asia/Manila', day) END ||
            ' (bill ' || b.number || ')';
  INSERT INTO billing_receipts (tenant_id, bill_id, payment_id, number, seller, buyer, description, amount, vatable_amount, vat_amount, currency, method, reference)
  VALUES (y.tenant_id, b.id, y.id, v_number,
          jsonb_build_object('registeredName', coalesce(s.registered_name, 'Tilvara'), 'tradeName', s.trade_name, 'tin', s.tin,
                             'address', s.address, 'vatRegistered', coalesce(s.vat_registered, true), 'permitNote', s.permit_note),
          v_buyer, v_desc, y.amount, y.amount - v_vat, v_vat, y.currency, y.method, y.reference)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (y.tenant_id, 'SYSTEM', 'billing.receipt_issued', 'billing_receipt', v_id::text, jsonb_build_object('number', v_number, 'bill', b.number));
  IF p_notify THEN
    INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (y.tenant_id, 'billing.receipt_issued', jsonb_build_object('receiptId', v_id));
  END IF;
  RETURN v_id;
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
                             'provider', p_provider, 'by', left(p_by, 100), 'billStatus', b.status));
  IF v_applied THEN
    PERFORM billing_settle(b.id, p_by);
    PERFORM billing_issue_receipt(v_payment, true);
    RETURN 'APPLIED';
  END IF;
  RETURN 'UNAPPLIED';
END $$;--> statement-breakpoint

-- Tilvara's details on receipts from now on (receipts already issued keep theirs). Audited as a platform event.
CREATE FUNCTION platform_set_billing_seller(p_registered_name text, p_trade_name text, p_tin text, p_address text,
                                           p_vat_registered boolean, p_permit_note text, p_actor text, p_reason text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'actor and reason are required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_registered_name), '') = '' THEN RAISE EXCEPTION 'the registered name is required' USING ERRCODE = '22023'; END IF;
  IF p_tin IS NOT NULL AND btrim(p_tin) !~ '^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$' THEN
    RAISE EXCEPTION 'the TIN must look like 123-456-789-00000' USING ERRCODE = '22023';
  END IF;
  INSERT INTO billing_seller (id, registered_name, trade_name, tin, address, vat_registered, permit_note, updated_at)
  VALUES (true, btrim(p_registered_name), nullif(btrim(p_trade_name), ''), nullif(btrim(p_tin), ''), nullif(btrim(p_address), ''),
          coalesce(p_vat_registered, true), nullif(btrim(p_permit_note), ''), now())
  ON CONFLICT (id) DO UPDATE SET registered_name = EXCLUDED.registered_name, trade_name = EXCLUDED.trade_name, tin = EXCLUDED.tin,
    address = EXCLUDED.address, vat_registered = EXCLUDED.vat_registered, permit_note = EXCLUDED.permit_note, updated_at = now();
  INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', 'billing.seller_changed', 'billing_seller', 'tilvara',
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500)));
END $$;--> statement-breakpoint

CREATE FUNCTION platform_billing_seller()
  RETURNS TABLE (registered_name text, trade_name text, tin text, address text, vat_registered boolean, permit_note text, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT registered_name, trade_name, tin, address, vat_registered, permit_note, updated_at FROM billing_seller WHERE id
$$;--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'billing_issue_receipt(uuid, boolean)',
    'platform_set_billing_seller(text, text, text, text, boolean, text, text, text)',
    'platform_billing_seller()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_set_billing_seller(text, text, text, text, boolean, text, text, text), platform_billing_seller() TO onepos_migrator;--> statement-breakpoint

-- Receipts for the payments already applied, in the order they were made (the migrator, under FORCE RLS,
-- would see none: NO FORCE while it reads them). Not mailed.
ALTER TABLE billing_payments NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT y.id FROM billing_payments y WHERE y.applied
             AND NOT EXISTS (SELECT 1 FROM billing_receipts x WHERE x.payment_id = y.id)
           ORDER BY y.created_at, y.id LOOP
    PERFORM billing_issue_receipt(r.id, false);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE billing_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- First prices, VAT included (the user's decision, 2026-10-27): below the usual Philippine cloud POS
-- subscriptions for the same reach. Only plans still at the placeholder 0. The platform audit row (no business)
-- is written as the migrator: NO FORCE on audit_logs for it.
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('starter', 999.00), ('growth', 2499.00), ('enterprise', 5999.00)) AS v(code, price) LOOP
    IF EXISTS (SELECT 1 FROM plans WHERE code = r.code AND monthly_price = 0) THEN
      UPDATE plans SET monthly_price = r.price WHERE code = r.code;
      INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type, resource_id, metadata)
      VALUES (NULL, 'SYSTEM', 'plan.price_changed', 'plan', r.code,
              jsonb_build_object('from', '0', 'to', r.price::text, 'actor', 'migration 0133', 'reason', 'First prices (session 44)'));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
