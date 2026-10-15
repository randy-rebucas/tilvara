-- Hand-written: return documents are tenant-isolated, append-only, and refunded from an open drawer.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sale_returns', 'sale_return_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
END $$;

CREATE TRIGGER sale_returns_require_open_session BEFORE INSERT ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION app_require_open_session();

-- Backstop for the API's check: never return more than was sold on a line.
CREATE FUNCTION app_return_within_sold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold numeric; returned numeric;
BEGIN
  SELECT quantity INTO sold FROM sale_lines WHERE tenant_id = NEW.tenant_id AND id = NEW.sale_line_id;
  SELECT coalesce(sum(quantity), 0) INTO returned FROM sale_return_lines WHERE tenant_id = NEW.tenant_id AND sale_line_id = NEW.sale_line_id;
  IF returned + NEW.quantity > sold THEN
    RAISE EXCEPTION 'return exceeds the quantity sold' USING ERRCODE = '23514', CONSTRAINT = 'sale_return_lines_within_sold';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_return_lines_within_sold BEFORE INSERT ON sale_return_lines
  FOR EACH ROW EXECUTE FUNCTION app_return_within_sold();
