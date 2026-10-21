-- Hand-written (session 25, ADR-0014 amendment "counter service, kitchen printing, tips"). DDL is in 0091.
-- * Counter service: a sale paid first at the counter carries a COUNTER order (the kitchen's copy),
--   created with the sale, fired at once and SETTLED in the same transaction: OPEN → SETTLED is allowed
--   for COUNTER orders only, and a counter order never takes the table-service paths (bill, merge, cancel).
-- * Kitchen printing: a desktop till claims unprinted tickets of its stations (print_claimed_*), prints
--   and marks them printed. Tickets fired before today are marked printed, or the first till set up to
--   print would print the whole history.
-- * Tips: sale_tips (append-only), cash movements TIP / TIP_REFUND / TIP_PAYOUT (DDL), and a
--   TIPS_PAYABLE system account for every legal entity (must match DEFAULT_CHART; ledger.test compares).

ALTER TABLE sale_tips ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sale_tips FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sale_tips USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
CREATE TRIGGER sale_tips_append_only BEFORE UPDATE OR DELETE ON sale_tips FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
GRANT SELECT, INSERT ON sale_tips TO onepos_app;--> statement-breakpoint
GRANT SELECT ON sale_tips TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON sale_tips TO onepos_worker;--> statement-breakpoint

GRANT UPDATE (counter_service) ON restaurant_settings TO onepos_app;--> statement-breakpoint
GRANT UPDATE (print_claimed_at, print_claimed_by, printed_at, print_count) ON kitchen_tickets TO onepos_app;--> statement-breakpoint

ALTER TABLE restaurant_orders ADD CONSTRAINT restaurant_orders_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id);--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_restaurant_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SETTLED', 'CANCELLED', 'MERGED') THEN
    RAISE EXCEPTION 'a % order cannot change', lower(OLD.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  IF NEW.order_type <> OLD.order_type OR NEW.sale_id IS DISTINCT FROM OLD.sale_id THEN
    RAISE EXCEPTION 'an order keeps its type and sale' USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.order_type = 'COUNTER' AND OLD.status = 'OPEN' AND NEW.status = 'SETTLED')
    OR (OLD.order_type <> 'COUNTER' AND OLD.status = 'OPEN' AND NEW.status IN ('BILLED', 'CANCELLED', 'MERGED'))
    OR (OLD.order_type <> 'COUNTER' AND OLD.status = 'BILLED' AND NEW.status IN ('OPEN', 'SETTLED'))) THEN
    RAISE EXCEPTION 'an % order cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'restaurant_orders_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- What a till syncs for counter service changes with the menu and the branch's settings.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menus', 'menu_versions', 'modifier_groups', 'modifier_options', 'kitchen_stations', 'restaurant_settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version()',
                   t || '_bump_catalog_version', t);
  END LOOP;
END $$;--> statement-breakpoint

-- FORCE RLS binds the migrator too (no tenant context here): lifted for the backfills only.
ALTER TABLE kitchen_tickets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE kitchen_tickets SET printed_at = fired_at WHERE printed_at IS NULL;--> statement-breakpoint
ALTER TABLE kitchen_tickets FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id, c.code, c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('TIPS_PAYABLE', '2210', 'Tips payable', 'LIABILITY')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND (a.system_key = c.key OR a.code = c.code));--> statement-breakpoint
-- An entity that already used code 2210 for its own account gets the system account under 2210-TP.
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id, '2210-TP', 'Tips payable', 'LIABILITY', 'TIPS_PAYABLE'
  FROM legal_entities e
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = 'TIPS_PAYABLE');--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
