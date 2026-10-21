-- Hand-written (session 27, ADR-0022): salons, spas and barber shops. DDL is in 0098.
-- * service staff, their services, hours and time off; appointments and their services: tenant RLS,
--   ordinary operational data (changed in place, audited by the API).
-- * appointment_services: no double-booking of a staff member (GiST exclusion on active rows).
-- * service_package_items: a package's contents (replaced when edited; sold packages keep their copy).
-- * customer_packages, customer_package_items, customer_package_entries, sale_tip_shares: append-only
--   evidence; entries keep one package's balance at zero or more under a per-package lock; tip shares
--   add up to their tip at commit.
-- * customer_notes: edited in place; deleted with anonymisation only (the API).
-- * Permissions appointments.read, appointments.manage, staff.manage; system account 2310 Prepaid
--   service packages in every chart; platform_flag_appointment_reminders() for the worker.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_staff', 'service_staff_services', 'service_staff_hours', 'service_staff_time_off',
                           'appointments', 'appointment_services', 'service_package_items', 'customer_packages',
                           'customer_package_items', 'customer_package_entries', 'sale_tip_shares', 'customer_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly, onepos_worker', t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (display_name, membership_id, commission_rate, color, archived_at, updated_at) ON service_staff TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (commission_rate), DELETE ON service_staff_services TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON service_staff_hours, service_staff_time_off TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (customer_id, guest_name, status, starts_at, ends_at, notes, remind, sale_id, cancel_reason, updated_by, updated_at) ON appointments TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (active), DELETE ON appointment_services TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON service_package_items TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON customer_packages, customer_package_items, customer_package_entries, sale_tip_shares TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (body, pinned, updated_by, updated_at), DELETE ON customer_notes TO onepos_app;--> statement-breakpoint
GRANT UPDATE (service_minutes, package_valid_days) ON product_variants TO onepos_app;--> statement-breakpoint

-- A staff member is never deleted (sales and appointments name them).
CREATE TRIGGER service_staff_no_delete BEFORE DELETE ON service_staff FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER appointments_no_delete BEFORE DELETE ON appointments FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER customer_packages_append_only BEFORE UPDATE OR DELETE ON customer_packages FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER customer_package_items_append_only BEFORE UPDATE OR DELETE ON customer_package_items FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER customer_package_entries_append_only BEFORE UPDATE OR DELETE ON customer_package_entries FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER sale_tip_shares_append_only BEFORE UPDATE OR DELETE ON sale_tip_shares FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint

-- No double-booking: one staff member's active services never overlap (ADR-0022 §4).
ALTER TABLE appointment_services ADD CONSTRAINT appointment_services_no_double_booking
  EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (active);--> statement-breakpoint

-- Package balances: entries of one package are serialised (the API takes the same lock first), a
-- session used is of that package, and no item goes below zero sessions or value.
CREATE FUNCTION app_customer_package_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  left_sessions integer;
  left_value numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('package:' || NEW.customer_package_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM customer_package_items i
                  WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.customer_package_item_id AND i.customer_package_id = NEW.customer_package_id) THEN
    RAISE EXCEPTION 'the entry is not of this package' USING ERRCODE = '23514', CONSTRAINT = 'customer_package_entries_match';
  END IF;
  IF NEW.kind = 'REDEEMED' AND NOT EXISTS (
       SELECT 1 FROM sale_lines l
        WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.sale_line_id AND l.customer_package_id = NEW.customer_package_id
          AND l.quantity = -NEW.sessions AND l.package_value = -NEW.value) THEN
    RAISE EXCEPTION 'the session used does not match its sale line' USING ERRCODE = '23514', CONSTRAINT = 'customer_package_entries_match';
  END IF;
  SELECT coalesce(sum(e.sessions), 0) + NEW.sessions, coalesce(sum(e.value), 0) + NEW.value INTO left_sessions, left_value
    FROM customer_package_entries e
   WHERE e.tenant_id = NEW.tenant_id AND e.customer_package_item_id = NEW.customer_package_item_id;
  IF left_sessions < 0 OR left_value < 0 THEN
    RAISE EXCEPTION 'a package has no sessions left for this' USING ERRCODE = '23514', CONSTRAINT = 'customer_package_balance';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customer_package_entries_check BEFORE INSERT ON customer_package_entries
  FOR EACH ROW EXECUTE FUNCTION app_customer_package_entry();--> statement-breakpoint

-- A tip's shares add up to the tip, checked at commit (the shares are written one statement after the tip).
CREATE FUNCTION app_sale_tip_shares_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tip numeric;
  shared numeric;
BEGIN
  SELECT t.amount INTO tip FROM sale_tips t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.sale_tip_id;
  SELECT coalesce(sum(s.amount), 0) INTO shared FROM sale_tip_shares s WHERE s.tenant_id = NEW.tenant_id AND s.sale_tip_id = NEW.sale_tip_id;
  IF shared <> tip THEN
    RAISE EXCEPTION 'a tip''s shares add up to the tip' USING ERRCODE = '23514', CONSTRAINT = 'sale_tip_shares_total';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_tip_shares_total AFTER INSERT ON sale_tip_shares
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_sale_tip_shares_total();--> statement-breakpoint

-- The offline till's snapshot carries the branch's staff (ADR-0022 §5).
CREATE TRIGGER service_staff_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON service_staff
  FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version();--> statement-breakpoint

-- Permissions: in the catalog, and in the built-in roles of every business (templates, ADR-0022 §4).
INSERT INTO permissions (code, description) VALUES
  ('appointments.read', 'See the appointment calendar and service staff'),
  ('appointments.manage', 'Book, change and cancel appointments'),
  ('staff.manage', 'Manage service staff, their hours and commission rates');--> statement-breakpoint
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
  FROM roles r JOIN tenants t ON t.id = r.tenant_id
  CROSS JOIN (VALUES ('appointments.read'), ('appointments.manage'), ('staff.manage')) AS p(code)
 WHERE r.is_system AND (
       r.key IN ('owner', 'admin')
    OR (r.key IN ('branch_manager', 'restaurant_manager'))
    OR (r.key IN ('cashier', 'senior_cashier') AND p.code <> 'staff.manage'))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The salon roles for businesses that already take appointments (HYBRID); others get them when they
-- change type (BusinessService). A unit test checks these arrays against ROLE_TEMPLATES.
WITH templates(key, name, permissions) AS (
  VALUES
    ('front_desk', 'Front Desk', ARRAY['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'customers.manage', 'appointments.read', 'appointments.manage']),
    ('stylist', 'Stylist', ARRAY['catalog.read', 'appointments.read', 'customers.read'])
),
added AS (
  INSERT INTO roles (tenant_id, key, name, is_system)
  SELECT t.id, tp.key, tp.name, true FROM tenants t CROSS JOIN templates tp
   WHERE t.business_type IN ('SALON', 'HYBRID')
  ON CONFLICT ON CONSTRAINT roles_tenant_key_unique DO NOTHING
  RETURNING id, tenant_id, key
)
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT a.tenant_id, a.id, unnest(tp.permissions) FROM added a JOIN templates tp ON tp.key = a.key;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The new system account in every existing chart (the same row `seedChart` gives a new entity).
ALTER TABLE legal_entities NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO accounts (tenant_id, legal_entity_id, code, name, type, system_key)
SELECT e.tenant_id, e.id,
       CASE WHEN EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.code = c.code) THEN c.code || '-SYS' ELSE c.code END,
       c.name, c.type, c.key
  FROM legal_entities e
 CROSS JOIN (VALUES
   ('PREPAID_SERVICES', '2310', 'Prepaid service packages', 'LIABILITY')
 ) AS c(key, code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.legal_entity_id = e.id AND a.system_key = c.key);--> statement-breakpoint
ALTER TABLE legal_entities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Reminders (ADR-0022 §10): the worker's hourly pass marks each BOOKED appointment once, when it
-- starts within 24 hours and more than an hour from now, for an active customer with an email, and
-- writes one appointment.reminder event (ids only) per appointment.
GRANT SELECT, UPDATE (reminded_at) ON appointments TO onepos_platform;--> statement-breakpoint
GRANT SELECT ON customers TO onepos_platform;--> statement-breakpoint
CREATE FUNCTION platform_flag_appointment_reminders() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN
    UPDATE appointments a SET reminded_at = now()
      FROM customers c
     WHERE c.tenant_id = a.tenant_id AND c.id = a.customer_id
       AND a.status = 'BOOKED' AND a.remind AND a.reminded_at IS NULL
       AND a.starts_at > now() + interval '1 hour' AND a.starts_at <= now() + interval '24 hours'
       AND c.email IS NOT NULL AND c.anonymised_at IS NULL AND c.archived_at IS NULL
    RETURNING a.tenant_id, a.id
  LOOP
    INSERT INTO outbox_events (tenant_id, topic, payload)
    VALUES (r.tenant_id, 'appointment.reminder', jsonb_build_object('appointmentId', r.id));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION platform_flag_appointment_reminders() OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_flag_appointment_reminders() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_flag_appointment_reminders() TO onepos_worker;
