-- Hand-written: customers, their marketing consent history and store credit (session 20, ADR-0018).
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON customers USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE customer_consent_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_consent_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON customer_consent_events USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE customer_credit_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_entries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON customer_credit_entries USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON customers, customer_consent_events, customer_credit_entries TO onepos_app;--> statement-breakpoint
GRANT UPDATE (code, display_name, phone, email, tin, address, notes, marketing_consent, marketing_consent_at, updated_at, archived_at, anonymised_at) ON customers TO onepos_app;--> statement-breakpoint
GRANT SELECT ON customers, customer_consent_events, customer_credit_entries TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON customers, customer_consent_events, customer_credit_entries TO onepos_worker;--> statement-breakpoint

-- Consent history and store credit are evidence: append-only.
CREATE TRIGGER customer_consent_events_append_only BEFORE UPDATE OR DELETE ON customer_consent_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER customer_credit_entries_append_only BEFORE UPDATE OR DELETE ON customer_credit_entries
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- A customer is never deleted (sales point at them); once anonymised, nothing comes back.
CREATE OR REPLACE FUNCTION app_customer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customers rows are never deleted; anonymise instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.anonymised_at IS NOT NULL THEN
    RAISE EXCEPTION 'an anonymised customer cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'customers_anonymised_final';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customers_guard BEFORE UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION app_customer_guard();--> statement-breakpoint

-- Store credit: each entry matches its document, and a balance never goes below zero. The lock
-- serialises entries of one customer with one legal entity (the API takes the same lock first).
CREATE OR REPLACE FUNCTION app_customer_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.customer_id::text || ':' || NEW.legal_entity_id::text, 0));
  IF NEW.kind = 'RETURN' THEN
    IF NOT EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method = 'STORE_CREDIT'
         AND r.amount_due = NEW.amount AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its return' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM sales s
       WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id AND s.customer_id = NEW.customer_id
         AND s.legal_entity_id = NEW.legal_entity_id AND s.branch_id = NEW.branch_id
         AND -NEW.amount = (SELECT coalesce(sum(t.amount), 0) FROM sale_tenders t WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = s.id AND t.method = 'STORE_CREDIT')
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its sale' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  END IF;
  SELECT coalesce(sum(amount), 0) + NEW.amount INTO balance
    FROM customer_credit_entries
   WHERE tenant_id = NEW.tenant_id AND customer_id = NEW.customer_id AND legal_entity_id = NEW.legal_entity_id;
  IF balance < 0 THEN
    RAISE EXCEPTION 'store credit cannot go below zero' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_balance';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customer_credit_entries_check BEFORE INSERT ON customer_credit_entries
  FOR EACH ROW EXECUTE FUNCTION app_customer_credit_entry();--> statement-breakpoint

-- The new system account in every existing chart (the same row `seedChart` gives a new entity).
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- An entity that already used the code for its own account gets the system account under <code>-SYS.
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.code = c.code) THEN c.code || '-SYS' ELSE c.code END,
       c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('CUSTOMER_STORE_CREDIT', '2300', 'Customer store credit', 'LIABILITY')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = c.key);--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
