-- Hand-written: un-bump a kitchen ticket (ADR-0014 amendment, session 15). A station that bumped a
-- ticket by mistake sends its ready items back to preparation. The one exception to "status only moves
-- forward": READY → IN_PREP. Never back from SERVED (the food left the kitchen), never to PENDING or
-- FIRED (what the kitchen saw stays seen); nothing about money or stock depends on READY.
CREATE OR REPLACE FUNCTION app_order_item_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int := array_position(ARRAY['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED'], OLD.status);
  rank_new int := array_position(ARRAY['PENDING', 'FIRED', 'IN_PREP', 'READY', 'SERVED'], NEW.status);
BEGIN
  IF OLD.status <> 'PENDING' AND (NEW.quantity <> OLD.quantity OR NEW.course <> OLD.course) THEN
    RAISE EXCEPTION 'a fired item cannot be changed; void it instead' USING ERRCODE = '23514', CONSTRAINT = 'order_items_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'READY' AND NEW.status = 'IN_PREP') THEN
    IF OLD.status = 'VOIDED'
       OR (NEW.status = 'VOIDED' AND OLD.status = 'PENDING')
       OR (NEW.status <> 'VOIDED' AND NOT (rank_new > rank_old AND (OLD.status <> 'PENDING' OR NEW.status = 'FIRED'))) THEN
      RAISE EXCEPTION 'an item cannot go from % to %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'order_items_transition';
    END IF;
  END IF;
  IF NEW.order_id <> OLD.order_id AND NOT EXISTS (
       SELECT 1 FROM restaurant_orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id AND o.status = 'OPEN') THEN
    RAISE EXCEPTION 'items can only move into an open order' USING ERRCODE = '23514', CONSTRAINT = 'order_items_order_open';
  END IF;
  RETURN NEW;
END $$;
