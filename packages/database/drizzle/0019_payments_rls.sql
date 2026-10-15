-- Hand-written: payment intent isolation, state machine and append-only evidence (ADR-0010).

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intents
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- PROCESSING → SUCCEEDED | FAILED | UNKNOWN; UNKNOWN → SUCCEEDED | FAILED; SUCCEEDED → CANCELED (unconsumed).
-- The consuming sale is stamped once, only on a SUCCEEDED intent; amounts and identity never change.
CREATE FUNCTION app_payment_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.method <> OLD.method OR NEW.cashier_session_id <> OLD.cashier_session_id
     OR NEW.client_transaction_id <> OLD.client_transaction_id OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'payment intent identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF OLD.sale_id IS NOT NULL AND (NEW.sale_id IS DISTINCT FROM OLD.sale_id OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a consumed payment intent is final' USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'SUCCEEDED' AND NEW.status = 'CANCELED' AND NEW.sale_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid payment intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_intents_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_intents_transition BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION app_payment_intent_transition();

GRANT SELECT, INSERT ON payment_intents TO onepos_app;
GRANT UPDATE (status, provider_reference, failure_code, sale_id, updated_at) ON payment_intents TO onepos_app;
GRANT SELECT, INSERT ON payment_events TO onepos_app;
GRANT SELECT ON payment_intents, payment_events TO onepos_readonly;
