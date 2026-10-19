-- Hand-written: Z-readings (session 16; fiscal gate G2, not BIR-accredited). Append-only, tenant-isolated.
ALTER TABLE z_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE z_readings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON z_readings USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON z_readings TO onepos_app;
GRANT SELECT ON z_readings TO onepos_readonly;
GRANT SELECT ON z_readings TO onepos_worker; -- data export (ADR-0016 slice 6)
CREATE TRIGGER z_readings_append_only BEFORE UPDATE OR DELETE ON z_readings
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
