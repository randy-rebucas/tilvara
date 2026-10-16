-- Hand-written: bills, checks and charges (Phase 4 slice 4, ADR-0014 §8, §9).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_bills', 'order_bill_beneficiaries', 'order_bill_lines', 'order_bill_charges',
                           'order_bill_allocations', 'sale_charges', 'sale_return_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Financial evidence: append-only.
  FOREACH t IN ARRAY ARRAY['order_bill_beneficiaries', 'order_bill_lines', 'order_bill_charges', 'order_bill_allocations', 'sale_charges', 'sale_return_charges'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
END $$;

CREATE TRIGGER order_bills_no_delete BEFORE DELETE ON order_bills FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT, UPDATE (status, voided_by, voided_at, void_reason, settled_at) ON order_bills TO onepos_app;

-- A bill is ACTIVE until every line is paid (SETTLED) or it is reopened before any check (VOIDED).
CREATE FUNCTION app_order_bill_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('SETTLED', 'VOIDED') THEN
    RAISE EXCEPTION 'a % bill cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'order_bills_transition';
  END IF;
  IF NEW.status = 'VOIDED' AND EXISTS (SELECT 1 FROM order_bill_allocations a WHERE a.tenant_id = NEW.tenant_id AND a.order_bill_id = NEW.id) THEN
    RAISE EXCEPTION 'a bill with paid checks cannot be reopened' USING ERRCODE = '23514', CONSTRAINT = 'order_bills_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_bills_transition BEFORE UPDATE ON order_bills
  FOR EACH ROW EXECUTE FUNCTION app_order_bill_transition();

-- A bill line is paid at most once in total: Σ share_num/share_den ≤ 1, summed as exact fractions
-- under the bill row's lock (whoever inserts), and only while the bill is ACTIVE.
CREATE FUNCTION app_order_bill_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
  n numeric := 0;
  d numeric := 1;
  g numeric;
  r record;
BEGIN
  SELECT status INTO bill_status FROM order_bills WHERE tenant_id = NEW.tenant_id AND id = NEW.order_bill_id FOR UPDATE;
  IF bill_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'only an active bill can be paid' USING ERRCODE = '23514', CONSTRAINT = 'order_bill_allocations_bill_active';
  END IF;
  FOR r IN SELECT share_num, share_den FROM order_bill_allocations WHERE tenant_id = NEW.tenant_id AND bill_line_id = NEW.bill_line_id
           UNION ALL SELECT NEW.share_num, NEW.share_den LOOP
    n := n * r.share_den + r.share_num * d;
    d := d * r.share_den;
    g := gcd(n, d);
    n := n / g;
    d := d / g;
  END LOOP;
  IF n > d THEN
    RAISE EXCEPTION 'a bill line cannot be paid more than once' USING ERRCODE = '23514', CONSTRAINT = 'order_bill_allocations_within_line';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_bill_allocations_guard BEFORE INSERT ON order_bill_allocations
  FOR EACH ROW EXECUTE FUNCTION app_order_bill_allocation_guard();

-- Service charge is owed to employees (RA 11360), not revenue: a new system account for every
-- legal entity (new ones are seeded by the API). Must match DEFAULT_CHART (ledger.test compares).
-- FORCE RLS binds the migrator too (no tenant context here): lifted for the backfill only.
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id, c.code, c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('SERVICE_CHARGE_PAYABLE', '2200', 'Service charge payable', 'LIABILITY')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND (a.system_key = c.key OR a.code = c.code));
-- An entity that already used code 2200 for its own account gets the system account under 2200-SC.
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id, '2200-SC', 'Service charge payable', 'LIABILITY', 'SERVICE_CHARGE_PAYABLE'
  FROM legal_entities e
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = 'SERVICE_CHARGE_PAYABLE');
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
