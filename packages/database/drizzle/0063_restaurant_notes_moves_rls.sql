-- Hand-written: notes per course and the history of item moves (session 16; ADR-0014 amendment).
-- * order_course_notes: live while the order is open (insert, update, delete by the app); each
--   ticket fired for the course copies the note into kitchen_tickets.course_note.
-- * order_item_moves: append-only, written only by the trigger below whenever an item's order
--   changes (move items, merge orders), so a report can place an item where it was at a past moment.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_course_notes', 'order_item_moves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_worker', t); -- data export (ADR-0016 slice 6)
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (note, updated_by, updated_at), DELETE ON order_course_notes TO onepos_app;
GRANT SELECT ON order_item_moves TO onepos_app;
CREATE TRIGGER order_item_moves_append_only BEFORE UPDATE OR DELETE ON order_item_moves
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- Notes change only while the order is open (a fired course keeps its copy on the ticket).
CREATE FUNCTION app_order_course_note_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM restaurant_orders
   WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.order_id, OLD.order_id);
  IF s IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'order is %', coalesce(s, 'missing') USING ERRCODE = '23514', CONSTRAINT = 'order_course_notes_order_open';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER order_course_notes_order_open BEFORE INSERT OR UPDATE OR DELETE ON order_course_notes
  FOR EACH ROW EXECUTE FUNCTION app_order_course_note_open();

-- Every change of an item's order is recorded (owned by the platform: the app cannot write history).
CREATE FUNCTION app_record_order_item_move() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO order_item_moves (tenant_id, item_id, from_order_id, to_order_id) VALUES (NEW.tenant_id, NEW.id, OLD.order_id, NEW.order_id);
  RETURN NEW;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION app_record_order_item_move() OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION app_record_order_item_move() FROM PUBLIC;
GRANT INSERT ON order_item_moves TO onepos_platform;
CREATE TRIGGER order_items_record_move AFTER UPDATE OF order_id ON order_items
  FOR EACH ROW WHEN (OLD.order_id IS DISTINCT FROM NEW.order_id) EXECUTE FUNCTION app_record_order_item_move();

-- Push to the floor and the kitchen display (session 16): any change to an order, its items, its
-- tickets or its bill notifies 'onepos_floor' with "<tenant>:<branch>" when the transaction commits
-- (identical notifications in one transaction are folded into one). The API fans it out to the
-- branch's open streams, which carry no data: clients re-read through their normal routes.
CREATE FUNCTION app_notify_floor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; b uuid;
BEGIN
  r := coalesce(NEW, OLD);
  IF TG_TABLE_NAME = 'order_items' THEN
    SELECT o.branch_id INTO b FROM restaurant_orders o WHERE o.tenant_id = r.tenant_id AND o.id = r.order_id;
  ELSE
    b := r.branch_id;
  END IF;
  IF b IS NOT NULL THEN
    PERFORM pg_notify('onepos_floor', r.tenant_id::text || ':' || b::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER restaurant_orders_notify AFTER INSERT OR UPDATE ON restaurant_orders FOR EACH ROW EXECUTE FUNCTION app_notify_floor();
CREATE TRIGGER order_items_notify AFTER INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION app_notify_floor();
CREATE TRIGGER kitchen_tickets_notify AFTER INSERT OR UPDATE ON kitchen_tickets FOR EACH ROW EXECUTE FUNCTION app_notify_floor();
CREATE TRIGGER order_bills_notify AFTER INSERT OR UPDATE ON order_bills FOR EACH ROW EXECUTE FUNCTION app_notify_floor();
CREATE TRIGGER order_course_notes_notify AFTER INSERT OR UPDATE OR DELETE ON order_course_notes FOR EACH ROW EXECUTE FUNCTION app_notify_floor();
