-- Hand-written: isolation, immutability and state machines for suppliers, purchasing and receiving.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines',
                           'supplier_returns', 'supplier_return_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Receiving and supplier-return documents are inventory evidence: never edited, never deleted.
  FOREACH t IN ARRAY ARRAY['goods_receipts', 'goods_receipt_lines', 'supplier_returns', 'supplier_return_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO onepos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['suppliers', 'purchase_orders'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON suppliers TO onepos_app;
GRANT UPDATE (code, name, tin, email, phone, address, payment_terms_days, notes, archived_at, updated_at) ON suppliers TO onepos_app;
GRANT SELECT, INSERT ON purchase_orders TO onepos_app;
GRANT UPDATE (status, supplier_id, expected_on, supplier_ref, notes, approved_by, approved_at, ended_by, ended_at, end_reason, updated_at)
  ON purchase_orders TO onepos_app;
GRANT SELECT, INSERT, UPDATE (line_no, variant_id, quantity, unit_cost), DELETE ON purchase_order_lines TO onepos_app;

-- Purchase order state machine; the order itself is editable only while DRAFT.
CREATE FUNCTION app_purchase_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
    OR (OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status IN ('RECEIVED', 'CLOSED'))
    OR (OLD.status = 'RECEIVED' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'invalid purchase order transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'purchase_orders_transition';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.expected_on IS DISTINCT FROM OLD.expected_on
       OR NEW.supplier_ref IS DISTINCT FROM OLD.supplier_ref OR NEW.notes IS DISTINCT FROM OLD.notes) THEN
    RAISE EXCEPTION 'only a draft purchase order can be edited' USING ERRCODE = '23514', CONSTRAINT = 'purchase_orders_not_draft';
  END IF;
  IF NEW.status = 'CANCELLED' AND EXISTS (SELECT 1 FROM goods_receipts r WHERE r.tenant_id = NEW.tenant_id AND r.purchase_order_id = NEW.id) THEN
    RAISE EXCEPTION 'a purchase order with receipts cannot be cancelled; close it instead'
      USING ERRCODE = '23514', CONSTRAINT = 'purchase_orders_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_transition BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION app_purchase_order_transition();

CREATE FUNCTION app_purchase_order_line_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r purchase_order_lines%ROWTYPE;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.tenant_id = r.tenant_id AND p.id = r.purchase_order_id AND p.status = 'DRAFT') THEN
    RAISE EXCEPTION 'only a draft purchase order can be edited' USING ERRCODE = '23514', CONSTRAINT = 'purchase_orders_not_draft';
  END IF;
  RETURN r;
END $$;
CREATE TRIGGER purchase_order_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION app_purchase_order_line_draft_only();

-- Receiving against an order: the order must be approved and match supplier and branch.
CREATE FUNCTION app_goods_receipt_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM purchase_orders p
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.purchase_order_id AND p.status IN ('APPROVED', 'PARTIALLY_RECEIVED')
          AND p.supplier_id = NEW.supplier_id AND p.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'the purchase order is not open for receiving at this branch from this supplier'
      USING ERRCODE = '23514', CONSTRAINT = 'goods_receipts_order_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipts_check BEFORE INSERT ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION app_goods_receipt_check();

-- Backstop for the API: an order line is never received beyond what was ordered.
CREATE FUNCTION app_goods_receipt_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordered numeric; received numeric; ok boolean;
BEGIN
  IF NEW.purchase_order_line_id IS NOT NULL THEN
    SELECT l.quantity, (l.variant_id = NEW.variant_id AND l.purchase_order_id = r.purchase_order_id) INTO ordered, ok
      FROM purchase_order_lines l JOIN goods_receipts r ON r.tenant_id = l.tenant_id AND r.id = NEW.goods_receipt_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.purchase_order_line_id;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'receipt line does not match the order line' USING ERRCODE = '23514', CONSTRAINT = 'goods_receipt_lines_order_line';
    END IF;
    SELECT coalesce(sum(quantity), 0) INTO received FROM goods_receipt_lines
     WHERE tenant_id = NEW.tenant_id AND purchase_order_line_id = NEW.purchase_order_line_id;
    IF received + NEW.quantity > ordered THEN
      RAISE EXCEPTION 'receipt exceeds the quantity ordered' USING ERRCODE = '23514', CONSTRAINT = 'goods_receipt_lines_within_ordered';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_receipt_lines_check BEFORE INSERT ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION app_goods_receipt_line_check();

-- Backstop: never return to a supplier more than was accepted on that receipt line.
CREATE FUNCTION app_supplier_return_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted numeric; returned numeric; ok boolean;
BEGIN
  IF NEW.goods_receipt_line_id IS NOT NULL THEN
    SELECT l.quantity, l.variant_id = NEW.variant_id INTO accepted, ok FROM goods_receipt_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.goods_receipt_line_id;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'return line does not match the receipt line' USING ERRCODE = '23514', CONSTRAINT = 'supplier_return_lines_receipt_line';
    END IF;
    SELECT coalesce(sum(quantity), 0) INTO returned FROM supplier_return_lines
     WHERE tenant_id = NEW.tenant_id AND goods_receipt_line_id = NEW.goods_receipt_line_id;
    IF returned + NEW.quantity > accepted THEN
      RAISE EXCEPTION 'return exceeds the quantity received' USING ERRCODE = '23514', CONSTRAINT = 'supplier_return_lines_within_received';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_return_lines_check BEFORE INSERT ON supplier_return_lines
  FOR EACH ROW EXECUTE FUNCTION app_supplier_return_line_check();
