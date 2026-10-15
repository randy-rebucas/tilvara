-- Hand-written: tax profile isolation + immutability, statutory discount scheme seed (ADR-0008).

ALTER TABLE tax_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_profiles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

-- History is evidence: a sale's profile must never change after the fact.
CREATE TRIGGER tax_profiles_append_only BEFORE UPDATE OR DELETE ON tax_profiles
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- No backdating (5 minutes of clock-skew tolerance): a new profile can only govern future sales.
CREATE FUNCTION app_tax_profile_not_backdated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_from < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'tax profiles cannot be backdated' USING ERRCODE = '23514', CONSTRAINT = 'tax_profiles_not_backdated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_profiles_not_backdated BEFORE INSERT ON tax_profiles
  FOR EACH ROW EXECUTE FUNCTION app_tax_profile_not_backdated();

GRANT SELECT, INSERT ON tax_profiles TO onepos_app;
GRANT SELECT ON tax_profiles TO onepos_readonly;

-- Statutory schemes are platform data: tenants read, never write.
CREATE TRIGGER discount_schemes_append_only BEFORE DELETE ON discount_schemes
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT ON discount_schemes TO onepos_app, onepos_readonly;

-- Computation verified against RR 5-2017 worked examples (PH_COMPLIANCE_ASSUMPTIONS §7.1) but NOT
-- yet signed off by a PH tax professional → PENDING_PROFESSIONAL_REVIEW (MVP gate #6).
INSERT INTO discount_schemes (code, version, name, effective_from, rate, vat_exempt, base, requires_id, legal_basis) VALUES
  ('SC',  1, 'Senior citizen',          '2010-03-15T00:00:00+08', 0.20, true, 'VAT_EXCLUSIVE', true, 'RA 9994; RR 7-2010'),
  ('PWD', 1, 'Person with disability',  '2016-03-23T00:00:00+08', 0.20, true, 'VAT_EXCLUSIVE', true, 'RA 10754; RR 5-2017');
