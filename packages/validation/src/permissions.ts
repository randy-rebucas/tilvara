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
  'inventory.count',
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

/**
 * What a support session may read (ADR-0016 slice 6): the business's read permissions, for the whole
 * business. Support access is read-only; the API refuses every write made with a support token.
 */
export const SUPPORT_PERMISSIONS: readonly PermissionCode[] = [
  'members.read',
  'roles.read',
  'org.read',
  'catalog.read',
  'sales.read',
  'inventory.read',
  'customers.read',
  'reports.read',
  'accounting.read',
  'audit.read',
];

export const isPrivilegedSet = (codes: Iterable<string>): boolean => {
  for (const c of codes) if ((PRIVILEGED_PERMISSIONS as readonly string[]).includes(c)) return true;
  return false;
};

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionCode[];
  /** Restaurant service only: left out for a RETAIL business, added when it changes type. */
  restaurant?: true;
}

const all = PERMISSIONS;

const BRANCH_MANAGER: readonly PermissionCode[] = [
  'members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void',
  'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read',
  'inventory.adjust', 'inventory.transfer', 'restaurant.orders', 'kitchen.operate', 'customers.read',
  'customers.manage', 'reports.read',
];

/** System roles seeded into every new tenant. Tenants may add custom roles later. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: all },
  { key: 'admin', name: 'Administrator', permissions: all.filter((p) => p !== 'subscription.manage') },
  { key: 'branch_manager', name: 'Branch Manager', permissions: BRANCH_MANAGER },
  /** A branch manager who also sets up menus, the floor and the kitchen (session 10; backfilled by migration 0049). */
  { key: 'restaurant_manager', name: 'Restaurant Manager', permissions: [...BRANCH_MANAGER, 'restaurant.manage'], restaurant: true },
  /** The kitchen display only: start, ready, bump, and marking items sold out (session 10; migration 0049). */
  { key: 'kitchen_crew', name: 'Kitchen Crew', permissions: ['kitchen.operate'], restaurant: true },
  {
    key: 'cashier',
    name: 'Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'restaurant.orders'],
  },
  /**
   * A cashier trusted with refunds, voids and discounts, and with adding customers (SPEC §4; session 22,
   * migration 0081). Price overrides and drawer approvals stay with a manager.
   */
  {
    key: 'senior_cashier',
    name: 'Senior Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.discount', 'cash.session', 'customers.read', 'customers.manage', 'restaurant.orders'],
  },
  {
    key: 'inventory_officer',
    name: 'Inventory Officer',
    permissions: ['catalog.read', 'inventory.read', 'inventory.adjust', 'inventory.transfer', 'purchasing.manage', 'reports.read'],
  },
  /** Suppliers, purchase orders, receiving, supplier returns and invoices; no stock corrections (SPEC §4; migration 0081). */
  {
    key: 'purchasing_officer',
    name: 'Purchasing Officer',
    permissions: ['catalog.read', 'inventory.read', 'purchasing.manage', 'reports.read'],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    permissions: ['org.read', 'sales.read', 'inventory.read', 'reports.read', 'accounting.read', 'accounting.post', 'audit.read'],
  },
];

/** The built-in roles a business of this type is given (a RETAIL business has no restaurant roles). */
export const roleTemplatesFor = (businessType: 'RETAIL' | 'RESTAURANT' | 'HYBRID'): readonly RoleTemplate[] =>
  businessType === 'RETAIL' ? ROLE_TEMPLATES.filter((t) => !t.restaurant) : ROLE_TEMPLATES;
