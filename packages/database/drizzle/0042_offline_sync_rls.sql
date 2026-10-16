-- Hand-written: offline sync (Phase 5 slice 1, ADR-0015).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['terminal_snapshots', 'terminal_transactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
END $$;

-- Snapshots are evidence of what a terminal was told: append-only.
CREATE TRIGGER terminal_snapshots_append_only BEFORE UPDATE OR DELETE ON terminal_snapshots
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT ON terminal_snapshots TO onepos_app;

-- What a terminal sent never changes; only the outcome moves, and RECORDED / DISMISSED are final.
CREATE TRIGGER terminal_transactions_no_delete BEFORE DELETE ON terminal_transactions
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT ON terminal_transactions TO onepos_app;
GRANT UPDATE (status, sale_id, error_code, error_detail, attempts, resolved_at, resolved_by, resolve_reason) ON terminal_transactions TO onepos_app;

CREATE FUNCTION app_terminal_transaction_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'QUARANTINED' OR NEW.status NOT IN ('QUARANTINED', 'RECORDED', 'DISMISSED') THEN
    RAISE EXCEPTION 'a % offline transaction cannot become %', lower(OLD.status), lower(NEW.status)
      USING ERRCODE = '23514', CONSTRAINT = 'terminal_transactions_transition';
  END IF;
  IF NEW.status = 'DISMISSED' AND (NEW.resolved_by IS NULL OR coalesce(btrim(NEW.resolve_reason), '') = '') THEN
    RAISE EXCEPTION 'dismissing an offline transaction needs a person and a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'terminal_transactions_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terminal_transactions_transition BEFORE UPDATE ON terminal_transactions
  FOR EACH ROW EXECUTE FUNCTION app_terminal_transaction_transition();

-- Terminal authentication (ADR-0015 §2). The runtime role cannot read credential hashes, so it asks
-- this function: the terminal's tenant, register and status when the hash matches, nothing otherwise.
-- An active terminal's last_seen_at is stamped.
GRANT SELECT (id, tenant_id, register_id, status, credential_hash), UPDATE (last_seen_at) ON terminals TO onepos_platform;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
CREATE FUNCTION auth_terminal(p_terminal_id uuid, p_credential_hash text)
  RETURNS TABLE (tenant_id uuid, register_id uuid, status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE terminals t SET last_seen_at = now()
   WHERE t.id = p_terminal_id AND t.credential_hash = p_credential_hash AND t.status = 'ACTIVE';
  RETURN QUERY SELECT t.tenant_id, t.register_id, t.status FROM terminals t
                WHERE t.id = p_terminal_id AND t.credential_hash = p_credential_hash;
END $$;
ALTER FUNCTION auth_terminal(uuid, text) OWNER TO onepos_platform;
REVOKE ALL ON FUNCTION auth_terminal(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_terminal(uuid, text) TO onepos_app;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
