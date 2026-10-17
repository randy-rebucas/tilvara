-- Hand-written: two new built-in role templates (session 10), back-filled into every existing
-- business. New businesses get them from ROLE_TEMPLATES at sign-up (@1pos/validation); a unit test
-- checks the arrays below against those templates.
-- * restaurant_manager: the branch manager's permissions plus restaurant.manage (menus, floor, kitchen).
-- * kitchen_crew: kitchen.operate only (the kitchen display and sold-out marks).
-- A business that already made a custom role with one of these keys keeps its own (ON CONFLICT DO NOTHING).
-- Runs as the migrator under FORCE RLS, so the policy is lifted for the back-fill only (see 0014, 0023, 0029).

-- tenants too: the back-fill reads every business, and the migrator sees none under its policy.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

WITH templates(key, name, permissions) AS (
  VALUES
    ('restaurant_manager', 'Restaurant Manager', ARRAY['members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read', 'inventory.adjust', 'inventory.transfer', 'restaurant.orders', 'kitchen.operate', 'customers.read', 'customers.manage', 'reports.read', 'restaurant.manage']),
    ('kitchen_crew', 'Kitchen Crew', ARRAY['kitchen.operate'])
),
added AS (
  INSERT INTO roles (tenant_id, key, name, is_system)
  SELECT t.id, tp.key, tp.name, true FROM tenants t CROSS JOIN templates tp
  ON CONFLICT ON CONSTRAINT roles_tenant_key_unique DO NOTHING
  RETURNING id, tenant_id, key
)
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT a.tenant_id, a.id, unnest(tp.permissions) FROM added a JOIN templates tp ON tp.key = a.key;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
