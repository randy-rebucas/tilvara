-- Hand-written (Phase 3 exit review): closing a month and posting into it must take turns.
-- The closed-period check used to read the period without a lock, so an entry that passed the
-- check could commit after a concurrent close and land in a closed month. Now every insert makes
-- sure its month's period row exists and holds it FOR SHARE until commit; closing updates that
-- row, so a close waits for postings in flight and a posting waits for a close in flight (and
-- then sees CLOSED and is refused).
CREATE OR REPLACE FUNCTION app_journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  month date := date_trunc('month', NEW.entry_date)::date;
  current_status text;
BEGIN
  INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on)
  VALUES (NEW.tenant_id, NEW.legal_entity_id, month)
  ON CONFLICT (tenant_id, legal_entity_id, starts_on) DO NOTHING;
  SELECT p.status INTO current_status FROM accounting_periods p
   WHERE p.tenant_id = NEW.tenant_id AND p.legal_entity_id = NEW.legal_entity_id AND p.starts_on = month
     FOR SHARE;
  IF current_status = 'CLOSED' THEN
    RAISE EXCEPTION 'the accounting period of % is closed', NEW.entry_date USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_period_closed';
  END IF;
  RETURN NEW;
END $$;
