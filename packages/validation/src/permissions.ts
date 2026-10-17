/**
 * Permission catalog. MUST match the rows seeded in
 * packages/database/drizzle/0003_identity_rls_auth.sql (checked by an integration test).
 */
export const PERMISSIONS = [
  'tenant.manage',
  'subscription.manage',
  'members.read',
  'members.manage',
  'roles.read',
  'roles.manage',
  'org.read',
  'org.manage',
  'terminals.manage',
  'tax.manage',
  'catalog.read',
  'catalog.manage',
  'prices.manage',
  'sales.create',
  'sales.read',
  'sales.refund',
  'sales.void',
  'sales.price_override',
  'sales.discount',
  'cash.session',
  'cash.reconcile',
  'inventory.read',
  'inventory.adjust',
  'inventory.transfer',
  'purchasing.manage',
  'restaurant.manage',
  'restaurant.orders',
  'kitchen.operate',
  'customers.read',
  'customers.manage',
  'reports.read',
  'accounting.read',
  'accounting.post',
  'audit.read',
  'integrations.manage',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Holding any of these (at any scope) makes a member privileged: two-step sign-in is required
 * after the grace period (ADR-0016). Built-in roles that qualify: owner, admin, accountant.
 */
export const PRIVILEGED_PERMISSIONS: readonly PermissionCode[] = [
  'tenant.manage',
  'subscription.manage',
  'members.manage',
  'roles.manage',
  'terminals.manage',
  'tax.manage',
  'accounting.post',
  'integrations.manage',
];

export const isPrivilegedSet = (codes: Iterable<string>): boolean => {
  for (const c of codes) if ((PRIVILEGED_PERMISSIONS as readonly string[]).includes(c)) return true;
  return false;
};

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionCode[];
}

const all = PERMISSIONS;

/** System roles seeded into every new tenant. Tenants may add custom roles later. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: all },
  { key: 'admin', name: 'Administrator', permissions: all.filter((p) => p !== 'subscription.manage') },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    permissions: [
      'members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void',
      'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read',
      'inventory.adjust', 'inventory.transfer', 'restaurant.orders', 'kitchen.operate', 'customers.read',
      'customers.manage', 'reports.read',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'restaurant.orders'],
  },
  {
    key: 'inventory_officer',
    name: 'Inventory Officer',
    permissions: ['catalog.read', 'inventory.read', 'inventory.adjust', 'inventory.transfer', 'purchasing.manage', 'reports.read'],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    permissions: ['org.read', 'sales.read', 'inventory.read', 'reports.read', 'accounting.read', 'accounting.post', 'audit.read'],
  },
];
