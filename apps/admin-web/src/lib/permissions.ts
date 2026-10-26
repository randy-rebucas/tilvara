import { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode } from '@1pos/validation/permissions';

export { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode };

export interface PermissionGroup {
  key: string;
  codes: readonly PermissionCode[];
  /** An extension's own codes (ADR-0026): shown while the business has it, or the role holds one of them. */
  extension?: string;
}

/** Permission areas for the role editor, in the order an owner thinks about them. Every code appears once. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { key: 'business', codes: ['tenant.manage', 'subscription.manage', 'members.read', 'members.manage', 'roles.read', 'roles.manage', 'audit.read', 'integrations.manage'] },
  { key: 'locations', codes: ['org.read', 'org.manage', 'terminals.manage', 'tax.manage'] },
  { key: 'catalog', codes: ['catalog.read', 'catalog.manage', 'prices.manage'] },
  { key: 'selling', codes: ['sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'customers.read', 'customers.manage'] },
  { key: 'stock', codes: ['inventory.read', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'purchasing.manage'] },
  { key: 'books', codes: ['reports.read', 'accounting.read', 'accounting.post'] },
];

/**
 * The groups the role editor shows: the base ones, and an extension's while the business has it or the
 * role already holds one of its codes (so saving never drops a grant the editor did not show).
 */
export const permissionGroupsFor = (extensions: readonly string[], held: readonly string[] = []) =>
  PERMISSION_GROUPS.filter((g) => !g.extension || extensions.includes(g.extension) || g.codes.some((c) => held.includes(c)));
