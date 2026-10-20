-- Hand-written: two new built-in role templates (session 22, SPEC §4), back-filled into every existing
-- business. New businesses get them from ROLE_TEMPLATES at sign-up (@1pos/validation); a unit test
-- checks the arrays below against those templates.
-- * senior_cashier: the cashier's permissions plus refunds, voids, discounts and adding customers.
-- * purchasing_officer: suppliers, purchase orders, receiving, supplier returns and invoices.
-- A business that already made a custom role with one of these keys keeps its own (ON CONFLICT DO NOTHING).
-- Runs as the migrator under FORCE RLS, so the policy is lifted for the back-fill only (see 0049).

-- tenants too: the back-fill reads every business, and the migrator sees none under its policy.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

WITH templates(key, name, permissions) AS (
  VALUES
    ('senior_cashier', 'Senior Cashier', ARRAY['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.discount', 'cash.session', 'customers.read', 'customers.manage', 'restaurant.orders']),
    ('purchasing_officer', 'Purchasing Officer', ARRAY['catalog.read', 'inventory.read', 'purchasing.manage', 'reports.read'])
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
