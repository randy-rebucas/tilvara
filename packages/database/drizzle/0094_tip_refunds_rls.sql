-- Hand-written (session 25, second round: the decisions on tips and offline counter sales). DDL is in 0093.
-- * A voided sale's card tip is given back by cancelling the tip's own charge with the provider, after
--   the void commits (the provider is never called inside a transaction): `sale_tip_refunds`, one per
--   void, CARD (the charge cancelled) or CASH (the provider refused; cash from the void's drawer).
-- * A consumed payment intent stays final, with one exception: a TIP intent whose refund row exists
--   may go SUCCEEDED → CANCELED (the refund row is written first, in the same transaction).
-- * `payment_intents.purpose` (SALE | TIP) tells a tip's charge from the sale's own; existing tip
--   charges are back-filled from `sale_tips`.
-- * `restaurant_orders.till_call_number`: the number an offline till printed for a counter sale.

ALTER TABLE sale_tip_refunds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_tip_refunds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sale_tip_refunds USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
CREATE TRIGGER sale_tip_refunds_append_only BEFORE UPDATE OR DELETE ON sale_tip_refunds FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
GRANT SELECT, INSERT ON sale_tip_refunds TO onepos_app;--> statement-breakpoint
GRANT SELECT ON sale_tip_refunds TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON sale_tip_refunds TO onepos_worker;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.sale_id IS NOT NULL AND (NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.status <> OLD.status) THEN
    -- A voided sale's card tip, given back by cancelling its charge (its refund row comes first).
    IF NOT (OLD.purpose = 'TIP' AND NEW.sale_id = OLD.sale_id AND OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED'
            AND EXISTS (SELECT 1 FROM sale_tip_refunds r WHERE r.tenant_id = OLD.tenant_id AND r.payment_intent_id = OLD.id AND r.method = 'CARD')) THEN
      RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
    END IF;
  ELSIF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint


-- FORCE RLS binds the migrator too (no tenant context here): lifted for the back-fill only.
ALTER TABLE payment_intents NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_tips NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_transition;--> statement-breakpoint
UPDATE payment_intents p SET purpose = 'TIP' WHERE EXISTS (SELECT 1 FROM sale_tips t WHERE t.payment_intent_id = p.id);--> statement-breakpoint
ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_transition;--> statement-breakpoint
ALTER TABLE sale_tips FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
