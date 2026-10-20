-- Hand-written (session 22, ADR-0013 amendment): supplier credit/debit notes, payments spread over
-- several invoices, and voiding a mistaken payment.
ALTER TABLE supplier_notes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_notes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_notes USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payment_allocations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_payment_allocations USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT ON supplier_notes, supplier_payment_allocations TO onepos_app;--> statement-breakpoint
GRANT UPDATE (voided_by, voided_at, void_reason) ON supplier_payments TO onepos_app;--> statement-breakpoint
GRANT SELECT ON supplier_notes, supplier_payment_allocations TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON supplier_notes, supplier_payment_allocations TO onepos_worker;--> statement-breakpoint

-- Notes and allocations are evidence: append-only.
CREATE TRIGGER supplier_notes_append_only BEFORE UPDATE OR DELETE ON supplier_notes
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER supplier_payment_allocations_append_only BEFORE UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- A payment stays as recorded; the one change it takes is a void, once, with its reason (never deleted).
DROP TRIGGER supplier_payments_append_only ON supplier_payments;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_supplier_payment_void() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_payments rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['voided_by','voided_at','void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_by','voided_at','void_reason']) THEN
    RAISE EXCEPTION 'a supplier payment is only voided, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER supplier_payments_void BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION app_supplier_payment_void();--> statement-breakpoint

-- Every earlier payment paid exactly one invoice: one allocation each, so "paid" is read from
-- allocations alone. Runs as the migrator under FORCE RLS: the policy is lifted for the back-fill.
ALTER TABLE supplier_payments NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payment_allocations NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO supplier_payment_allocations (tenant_id, supplier_payment_id, supplier_invoice_id, amount, created_at)
SELECT p.tenant_id, p.id, p.supplier_invoice_id, p.amount, p.created_at
  FROM supplier_payments p
 WHERE p.supplier_invoice_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocations a WHERE a.supplier_payment_id = p.id);--> statement-breakpoint
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payment_allocations FORCE ROW LEVEL SECURITY;
