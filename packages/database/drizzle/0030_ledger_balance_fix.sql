-- Hand-written: the balance check shared by journal_entries and journal_lines read NEW.journal_entry_id
-- inside one CASE expression, which plpgsql resolves for both tables ("record new has no field").
-- Each table's field is now read in its own branch, so only the executed statement is resolved.
CREATE OR REPLACE FUNCTION app_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eid uuid;
  d numeric;
  c numeric;
  n int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    eid := NEW.id;
  ELSE
    eid := NEW.journal_entry_id;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM journal_lines WHERE tenant_id = NEW.tenant_id AND journal_entry_id = eid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'journal entry % does not balance (debit %, credit %, % lines)', eid, d, c, n
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_balanced';
  END IF;
  RETURN NULL;
END $$;
