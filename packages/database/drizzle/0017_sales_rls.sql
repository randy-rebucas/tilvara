-- Hand-written: isolation, immutability and state machines for cash, sales and stock.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashier_sessions', 'cash_movements', 'cash_reconciliations', 'sequence_counters',
                           'sales', 'sale_beneficiaries', 'sale_lines', 'sale_tenders', 'stock_movements', 'stock_balances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Financial and inventory evidence: never edited, never deleted. Corrections are new rows.
  FOREACH t IN ARRAY ARRAY['cash_movements', 'sales', 'sale_beneficiaries', 'sale_lines', 'sale_tenders', 'stock_movements'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cashier_sessions', 'cash_reconciliations', 'sequence_counters', 'stock_balances'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON cashier_sessions TO onepos_app;
GRANT UPDATE (status, closed_by, closed_at) ON cashier_sessions TO onepos_app;
GRANT SELECT, INSERT ON cash_reconciliations TO onepos_app;
GRANT UPDATE (approved_by, approved_at, approval_note) ON cash_reconciliations TO onepos_app;
GRANT SELECT, INSERT ON sequence_counters TO onepos_app;
GRANT UPDATE (next_value) ON sequence_counters TO onepos_app;
GRANT SELECT ON stock_balances TO onepos_app;

-- OPEN → CLOSED → RECONCILED, nothing else; a closed session's close stamp is final.
CREATE FUNCTION app_cashier_session_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.status = 'OPEN' AND NEW.status = 'CLOSED') OR (OLD.status = 'CLOSED' AND NEW.status = 'RECONCILED')) THEN
    RAISE EXCEPTION 'invalid cashier session transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'cashier_sessions_transition';
  END IF;
  IF OLD.status = 'CLOSED' AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by) THEN
    RAISE EXCEPTION 'close details are final' USING ERRCODE = '23514', CONSTRAINT = 'cashier_sessions_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashier_sessions_transition BEFORE UPDATE ON cashier_sessions
  FOR EACH ROW EXECUTE FUNCTION app_cashier_session_transition();

-- Cash and sales can only be recorded against an OPEN session (the API checks too; this is the backstop).
CREATE FUNCTION app_require_open_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cashier_sessions s
                  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.cashier_session_id AND s.status = 'OPEN') THEN
    RAISE EXCEPTION 'cashier session is not open' USING ERRCODE = '23514', CONSTRAINT = 'session_not_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movements_require_open_session BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION app_require_open_session();
CREATE TRIGGER sales_require_open_session BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION app_require_open_session();

-- Approval is written exactly once.
CREATE FUNCTION app_reconciliation_approve_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation already approved' USING ERRCODE = '23514', CONSTRAINT = 'cash_reconciliations_approved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_reconciliations_approve_once BEFORE UPDATE ON cash_reconciliations
  FOR EACH ROW EXECUTE FUNCTION app_reconciliation_approve_once();

-- stock_balances = Σ stock_movements, maintained here so the app role can read but never write it.
CREATE FUNCTION app_apply_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, NEW.quantity, now())
  ON CONFLICT (tenant_id, branch_id, variant_id)
  DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now();
  RETURN NEW;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION app_apply_stock_movement() OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION app_apply_stock_movement() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON stock_balances TO onepos_platform;
CREATE TRIGGER stock_movements_apply_balance AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app_apply_stock_movement();
