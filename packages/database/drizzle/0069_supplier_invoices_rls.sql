-- Hand-written: supplier invoices, the receipts they cover, and supplier payments (session 16, ADR-0013 amendment).
ALTER TABLE supplier_invoices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_invoices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_invoices USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE supplier_invoice_receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_invoice_receipts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_invoice_receipts USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_payments USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON supplier_invoices, supplier_invoice_receipts, supplier_payments TO onepos_app;--> statement-breakpoint
GRANT UPDATE (status, cancelled_by, cancelled_at, cancel_reason) ON supplier_invoices TO onepos_app;--> statement-breakpoint
GRANT UPDATE (active) ON supplier_invoice_receipts TO onepos_app;--> statement-breakpoint
GRANT SELECT ON supplier_invoices, supplier_invoice_receipts, supplier_payments TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON supplier_invoices, supplier_invoice_receipts, supplier_payments TO onepos_worker;--> statement-breakpoint

-- Payments are evidence: append-only.
CREATE TRIGGER supplier_payments_append_only BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- An invoice only goes OPEN → CANCELLED, with nothing else changed; never deleted.
CREATE OR REPLACE FUNCTION app_supplier_invoice_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_invoices rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'OPEN' OR NEW.status <> 'CANCELLED'
     OR (to_jsonb(NEW) - ARRAY['status','cancelled_by','cancelled_at','cancel_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','cancelled_by','cancelled_at','cancel_reason']) THEN
    RAISE EXCEPTION 'a supplier invoice only goes from OPEN to CANCELLED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER supplier_invoices_transition BEFORE UPDATE OR DELETE ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_transition();--> statement-breakpoint

-- A covered receipt is only released (active true → false) when its invoice is cancelled.
CREATE OR REPLACE FUNCTION app_supplier_invoice_receipt_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_invoice_receipts rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.active OR NEW.active OR (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'a covered receipt is only released once, with its invoice' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = NEW.supplier_invoice_id AND i.status = 'CANCELLED') THEN
    RAISE EXCEPTION 'a covered receipt is released only when its invoice is cancelled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER supplier_invoice_receipts_release BEFORE UPDATE OR DELETE ON supplier_invoice_receipts
  FOR EACH ROW EXECUTE FUNCTION app_supplier_invoice_receipt_release();--> statement-breakpoint

-- New system accounts in every existing chart (the same rows `seedChart` gives a new entity).
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- An entity that already used one of these codes for its own account gets the system account under <code>-SYS.
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.code = c.code) THEN c.code || '-SYS' ELSE c.code END,
       c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('CASH_IN_BANK', '1030', 'Cash in bank', 'ASSET'),
   ('INPUT_VAT', '1300', 'Input VAT', 'ASSET'),
   ('ACCOUNTS_PAYABLE', '2000', 'Accounts payable – trade', 'LIABILITY')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = c.key);--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
