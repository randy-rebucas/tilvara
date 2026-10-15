-- Hand-written: RLS, grants and integrity triggers for the organization tables.
-- Master data is archived (archived_at), never deleted, because sales/invoices reference it.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_entities', 'branches', 'registers', 'terminals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()',
      t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['legal_entities', 'branches', 'registers'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON legal_entities TO onepos_app;
GRANT UPDATE (registered_name, trade_name, tin, vat_status, registered_address, rdo_code,
              price_display, rounding_mode, invoicing_mode, archived_at) ON legal_entities TO onepos_app;
GRANT SELECT, INSERT ON branches TO onepos_app;
GRANT UPDATE (name, address, timezone, bir_branch_code, archived_at) ON branches TO onepos_app;
GRANT SELECT, INSERT ON registers TO onepos_app;
GRANT UPDATE (name, archived_at) ON registers TO onepos_app;
-- Terminal credential hashes are never readable by the runtime role (terminal auth goes
-- through a SECURITY DEFINER lookup in Phase 2).
GRANT SELECT (id, tenant_id, register_id, name, status, credential_hint, last_seen_at, revoked_at, revoke_reason, created_at)
  ON terminals TO onepos_app;
GRANT INSERT ON terminals TO onepos_app;
GRANT UPDATE (name, status, revoked_at, revoke_reason, last_seen_at) ON terminals TO onepos_app;
GRANT SELECT ON legal_entities, branches, registers TO onepos_readonly;
GRANT SELECT (id, tenant_id, register_id, name, status, credential_hint, last_seen_at, revoked_at, revoke_reason, created_at)
  ON terminals TO onepos_readonly;

-- A revoked terminal stays revoked (stolen-device replay protection).
CREATE FUNCTION app_terminal_revocation_is_final() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'terminal % is revoked and cannot be reactivated', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terminals_revocation_final BEFORE UPDATE ON terminals
  FOR EACH ROW EXECUTE FUNCTION app_terminal_revocation_is_final();

-- Role-assignment scopes must reference real org nodes of the same tenant.
CREATE FUNCTION app_validate_membership_scope() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  ok := CASE NEW.scope_type
    WHEN 'TENANT'       THEN NEW.scope_id IS NULL
    WHEN 'LEGAL_ENTITY' THEN EXISTS (SELECT 1 FROM legal_entities WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id)
    WHEN 'BRANCH'       THEN EXISTS (SELECT 1 FROM branches       WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id)
    WHEN 'REGISTER'     THEN EXISTS (SELECT 1 FROM registers      WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id)
    ELSE false
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'scope % % does not exist in this tenant', NEW.scope_type, NEW.scope_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_roles_validate_scope BEFORE INSERT OR UPDATE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION app_validate_membership_scope();
