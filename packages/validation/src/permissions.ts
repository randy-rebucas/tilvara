/**
 * Permission catalog: the base codes plus the codes each extension adds (ADR-0026). MUST match the
 * rows seeded in packages/database/drizzle/0003_identity_rls_auth.sql and by each extension's
 * migration (checked by an integration test).
 */
import {
  extensionManifest,
  extensionPermissions,
  extensionPrivileged,
  extensionSupport,
  type ExtensionManifest,
  type ExtensionPermission,
} from './extensions.js';

/** What every business has (the retail base). */
export const CORE_PERMISSIONS = [
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
  'customers.read',
  'customers.manage',
  'reports.read',
  'accounting.read',
  'accounting.post',
  'audit.read',
  'integrations.manage',
] as const;

export type PermissionCode = (typeof CORE_PERMISSIONS)[number] | ExtensionPermission;

export const PERMISSIONS: readonly PermissionCode[] = [...CORE_PERMISSIONS, ...extensionPermissions()];

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Holding any of these (at any scope) makes a member privileged: two-step sign-in is required
 * after the grace period (ADR-0016). Built-in roles that qualify: owner, admin, accountant.
 */
export const PRIVILEGED_PERMISSIONS: readonly PermissionCode[] = [
  ...extensionPrivileged(),
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
  ...extensionSupport(),
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

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionCode[];
}

const all = CORE_PERMISSIONS;

const BRANCH_MANAGER: readonly PermissionCode[] = [
  'members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void',
  'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read',
  'inventory.adjust', 'inventory.transfer', 'customers.read',
  'customers.manage', 'reports.read',
];

/** System roles seeded into every new tenant (base codes only). Tenants may add custom roles later. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: all },
  { key: 'admin', name: 'Administrator', permissions: all.filter((p) => p !== 'subscription.manage') },
  { key: 'branch_manager', name: 'Branch Manager', permissions: BRANCH_MANAGER },
  {
    key: 'cashier',
    name: 'Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read'],
  },
  /**
   * A cashier trusted with refunds, voids and discounts, and with adding customers (SPEC §4; session 22,
   * migration 0081). Price overrides and drawer approvals stay with a manager.
   */
  {
    key: 'senior_cashier',
    name: 'Senior Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.discount', 'cash.session', 'customers.read', 'customers.manage'],
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

/** Whether these codes make a member privileged (ADR-0016). */
export const isPrivilegedSet = (codes: Iterable<string>): boolean => {
  for (const c of codes) if ((PRIVILEGED_PERMISSIONS as readonly string[]).includes(c)) return true;
  return false;
};

/**
 * The built-in roles of a business with these extensions on: the base roles plus each extension's
 * (ADR-0026). Seeding is additive, so switching an extension on adds its roles and nothing else.
 * Switching on also gives the business's Owner and Administrator roles every code of the extension
 * (the API does it; those roles hold every base code).
 */
export const roleTemplatesFor = (extensions: readonly string[] = [], list?: readonly ExtensionManifest[]): readonly RoleTemplate[] => [
  ...ROLE_TEMPLATES,
  ...extensions.flatMap((code) => (extensionManifest(code, list)?.roleTemplates ?? []) as readonly RoleTemplate[]),
];
