-- Audit 2026-10-21 (docs/AUDIT-2026-10-21.md): fixes in triggers and definer functions.

-- 1. A lot hold covers the whole pack family (ADR-0025 §5). Opening a box copies its lot code onto the
--    strips and pieces (app_track_stock_lots, UNPACK_IN), so a recall of "box, lot X" must also stop the
--    loose pieces of lot X, and a hold placed on the piece must stop the boxes. The family is every item
--    linked to this one through pack links, either way, archived links included (lot codes copied while
--    a link was active stay on the pieces).
CREATE OR REPLACE FUNCTION app_lot_held(p_tenant uuid, p_branch uuid, p_variant uuid, p_lot_code text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE family(v) AS (
    SELECT p_variant
    UNION
    SELECT CASE WHEN pc.pack_variant_id = f.v THEN pc.piece_variant_id ELSE pc.pack_variant_id END
      FROM family f JOIN pack_conversions pc ON pc.tenant_id = p_tenant AND (pc.pack_variant_id = f.v OR pc.piece_variant_id = f.v))
  SELECT p_lot_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM lot_holds h
     WHERE h.tenant_id = p_tenant AND h.variant_id IN (SELECT v FROM family) AND h.released_at IS NULL
       AND upper(btrim(h.lot_code)) = upper(btrim(p_lot_code)) AND (h.branch_id IS NULL OR h.branch_id = p_branch))
$$;--> statement-breakpoint

-- 2. Floor push (ADR-0014 amendment): marking an item sold out, or available again, reaches the other
--    KDS screens and the floor tablets.
CREATE TRIGGER sold_out_items_notify AFTER INSERT OR UPDATE OR DELETE ON sold_out_items FOR EACH ROW EXECUTE FUNCTION app_notify_floor();--> statement-breakpoint

-- 3. An ended job order (ADR-0024 §3) changes only when its customer is anonymised: the walk-in name and
--    phone, the instructions and the condition notes may be blanked, never set to something else.
CREATE OR REPLACE FUNCTION app_job_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  steps constant text[] := ARRAY['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY'];
  personal constant text[] := ARRAY['customer_name', 'customer_phone', 'special_instructions', 'condition_notes', 'updated_by', 'updated_at'];
BEGIN
  IF OLD.status IN ('CLAIMED', 'CANCELLED', 'DISPOSED') THEN
    IF (to_jsonb(NEW) - personal) = (to_jsonb(OLD) - personal)
       AND (NEW.customer_name IS NULL OR NEW.customer_name IS NOT DISTINCT FROM OLD.customer_name)
       AND (NEW.customer_phone IS NULL OR NEW.customer_phone IS NOT DISTINCT FROM OLD.customer_phone)
       AND (NEW.special_instructions IS NULL OR NEW.special_instructions IS NOT DISTINCT FROM OLD.special_instructions)
       AND (NEW.condition_notes IS NULL OR NEW.condition_notes IS NOT DISTINCT FROM OLD.condition_notes) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this job order has ended and does not change' USING ERRCODE = '23514', CONSTRAINT = 'job_orders_status_final';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (array_position(steps, NEW.status) IS NOT NULL AND array_position(steps, OLD.status) IS NOT NULL
         AND (array_position(steps, NEW.status) > array_position(steps, OLD.status) OR (OLD.status = 'READY' AND NEW.status = 'FOLDING')))
    OR (OLD.status = 'READY' AND NEW.status IN ('OUT_FOR_DELIVERY', 'CLAIMED', 'DISPOSED'))
    OR (OLD.status = 'OUT_FOR_DELIVERY' AND NEW.status IN ('READY', 'CLAIMED'))
    OR NEW.status = 'CANCELLED'
    -- A job paid and handed over before it was marked ready (a same-day counter release).
    OR (array_position(steps, OLD.status) IS NOT NULL AND NEW.status = 'CLAIMED')) THEN
    RAISE EXCEPTION 'a job order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'job_orders_status_move';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 4. An ended stay (ADR-0023) changes only when its customer is anonymised: its notes may be blanked.
CREATE OR REPLACE FUNCTION app_stay_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CHECKED_OUT', 'CANCELLED', 'NO_SHOW') THEN
    IF NEW.notes IS NULL
       AND (to_jsonb(NEW) - ARRAY['notes', 'updated_by', 'updated_at']) = (to_jsonb(OLD) - ARRAY['notes', 'updated_by', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this stay has ended and does not change' USING ERRCODE = '23514', CONSTRAINT = 'stays_status_final';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'BOOKED' AND NEW.status IN ('IN_HOUSE', 'CANCELLED', 'NO_SHOW'))
    OR (OLD.status = 'IN_HOUSE' AND NEW.status = 'CHECKED_OUT')) THEN
    RAISE EXCEPTION 'a stay cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'stays_status_move';
  END IF;
  IF OLD.status = 'IN_HOUSE' AND NEW.arrival_date <> OLD.arrival_date THEN
    RAISE EXCEPTION 'an in-house stay keeps its arrival date' USING ERRCODE = '23514', CONSTRAINT = 'stays_arrival_fixed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 5. Store credit never turns into drawer cash (ADR-0018): a return of a sale paid partly with store
--    credit gives that share back as credit to the customer who paid with it, and the rest as the refund
--    method says. Such a RETURN entry is at most the refund, and with the earlier returns of the sale at
--    most the credit the sale used. A refund wholly to credit is checked as before.
CREATE OR REPLACE FUNCTION app_customer_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.customer_id::text || ':' || NEW.legal_entity_id::text, 0));
  IF NEW.kind = 'RETURN' THEN
    -- What a return put back onto a guest's folio (ADR-0023) is not store credit.
    IF NOT EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method = 'STORE_CREDIT'
         AND r.amount_due + coalesce((SELECT sum(e.amount) FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.sale_return_id = r.id AND e.kind = 'CHARGE_RETURN'), 0) = NEW.amount
         AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) AND NOT EXISTS (
      SELECT 1 FROM sale_returns r JOIN sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.sale_return_id AND r.refund_method <> 'STORE_CREDIT'
         AND NEW.amount > 0 AND s.customer_id = NEW.customer_id
         AND NEW.amount <= r.amount_due + coalesce((SELECT sum(e.amount) FROM folio_entries e WHERE e.tenant_id = NEW.tenant_id AND e.sale_return_id = r.id AND e.kind = 'CHARGE_RETURN'), 0)
         AND NEW.amount + coalesce((SELECT sum(c.amount) FROM customer_credit_entries c JOIN sale_returns o ON o.tenant_id = c.tenant_id AND o.id = c.sale_return_id
                                     WHERE c.tenant_id = NEW.tenant_id AND c.kind = 'RETURN' AND o.sale_id = r.sale_id), 0)
             <= (SELECT coalesce(sum(t.amount), 0) FROM sale_tenders t WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = r.sale_id AND t.method = 'STORE_CREDIT')
         AND r.legal_entity_id = NEW.legal_entity_id AND r.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its return' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  ELSIF NEW.kind = 'FOLIO_PAYMENT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM folio_payments p JOIN folios f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id
        JOIN stays s ON s.tenant_id = f.tenant_id AND s.id = f.stay_id
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.folio_payment_id AND p.method = 'STORE_CREDIT' AND p.amount = -NEW.amount
         AND s.customer_id = NEW.customer_id AND p.legal_entity_id = NEW.legal_entity_id AND p.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its folio payment' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM sales s
       WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id AND s.customer_id = NEW.customer_id
         AND s.legal_entity_id = NEW.legal_entity_id AND s.branch_id = NEW.branch_id
         AND -NEW.amount = (SELECT coalesce(sum(t.amount), 0) FROM sale_tenders t WHERE t.tenant_id = NEW.tenant_id AND t.sale_id = s.id AND t.method = 'STORE_CREDIT')
    ) THEN
      RAISE EXCEPTION 'the store credit does not match its sale' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_entries_match';
    END IF;
  END IF;
  SELECT coalesce(sum(amount), 0) + NEW.amount INTO balance
    FROM customer_credit_entries
   WHERE tenant_id = NEW.tenant_id AND customer_id = NEW.customer_id AND legal_entity_id = NEW.legal_entity_id;
  IF balance < 0 THEN
    RAISE EXCEPTION 'store credit cannot go below zero' USING ERRCODE = '23514', CONSTRAINT = 'customer_credit_balance';
  END IF;
  RETURN NEW;
END $$;
