-- Hand-written: double-entry ledger (ADR-0013).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'accounting_periods', 'journal_entries', 'journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Posted entries are evidence: corrections are reversals and new entries, never edits.
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['accounts', 'accounting_periods'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (code, name, archived_at) ON accounts TO onepos_app;
GRANT SELECT, INSERT, UPDATE (status, closed_by, closed_at) ON accounting_periods TO onepos_app;

-- System accounts are what automatic postings rely on: never archived.
CREATE FUNCTION app_account_protect_system() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.system_key IS NOT NULL AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'system account % cannot be archived', OLD.system_key USING ERRCODE = '23514', CONSTRAINT = 'accounts_system_protected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_protect_system BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app_account_protect_system();

-- Nothing is posted into a closed month.
CREATE FUNCTION app_journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_periods p
              WHERE p.tenant_id = NEW.tenant_id AND p.legal_entity_id = NEW.legal_entity_id
                AND p.starts_on = date_trunc('month', NEW.entry_date)::date AND p.status = 'CLOSED') THEN
    RAISE EXCEPTION 'the accounting period of % is closed', NEW.entry_date USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_period_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app_journal_period_open();

-- Σ debit = Σ credit with at least two lines, checked at commit for every entry touched,
-- whoever inserts (the posting package checks first; this is the backstop).
CREATE FUNCTION app_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eid uuid := CASE WHEN TG_TABLE_NAME = 'journal_entries' THEN NEW.id ELSE NEW.journal_entry_id END;
  d numeric;
  c numeric;
  n int;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM journal_lines WHERE tenant_id = NEW.tenant_id AND journal_entry_id = eid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'journal entry % does not balance (debit %, credit %, % lines)', eid, d, c, n
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_balanced';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_journal_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_journal_balanced();

-- Every existing legal entity gets the default chart (new ones are seeded by the API).
-- Must match DEFAULT_CHART in @1pos/accounting (an integration test compares them).
-- FORCE RLS binds the migrator too (no tenant context here): lifted for the backfill only.
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id, c.code, c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('CASH_ON_HAND', '1010', 'Cash on hand', 'ASSET'),
   ('PAYMENT_CLEARING', '1020', 'Card/QR clearing', 'ASSET'),
   ('INVENTORY', '1200', 'Inventory', 'ASSET'),
   ('INVENTORY_IN_TRANSIT', '1210', 'Inventory in transit', 'ASSET'),
   ('GRNI', '2010', 'Goods received not invoiced', 'LIABILITY'),
   ('OUTPUT_VAT', '2100', 'Output VAT payable', 'LIABILITY'),
   ('CASH_TRANSFERS', '3900', 'Cash fund transfers', 'EQUITY'),
   ('SALES', '4000', 'Sales', 'REVENUE'),
   ('SALES_RETURNS', '4010', 'Sales returns', 'REVENUE'),
   ('STATUTORY_DISCOUNTS', '4020', 'SC/PWD discounts', 'REVENUE'),
   ('COGS', '5000', 'Cost of goods sold', 'EXPENSE'),
   ('PURCHASES_NON_STOCK', '5050', 'Purchases – non-stock items', 'EXPENSE'),
   ('PURCHASE_PRICE_VARIANCE', '5060', 'Purchase price variance', 'EXPENSE'),
   ('INVENTORY_ADJUSTMENTS', '5100', 'Inventory adjustments', 'EXPENSE'),
   ('INVENTORY_WASTE', '5110', 'Spoilage and waste', 'EXPENSE'),
   ('TRANSIT_LOSS', '5120', 'Transit losses', 'EXPENSE'),
   ('CASH_OVER_SHORT', '5200', 'Cash over/short', 'EXPENSE')
 ) AS c(key, code, name, type);
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
