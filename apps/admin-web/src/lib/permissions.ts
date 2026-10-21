import { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode } from '@1pos/validation/permissions';
import { servesAppointments, servesLodging, type BusinessType } from './business-type';

export { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode };

/**
 * Permission areas for the role editor, in the order an owner thinks about them. Every code appears once.
 * `salon`: appointments and service staff (ADR-0022), shown only to a business that takes appointments.
 * `lodging`: rooms, stays, folios and housekeeping (ADR-0023), shown only to a business with rooms.
 */
export const PERMISSION_GROUPS: readonly { key: string; codes: readonly PermissionCode[]; salon?: true; lodging?: true }[] = [
  { key: 'business', codes: ['tenant.manage', 'subscription.manage', 'members.read', 'members.manage', 'roles.read', 'roles.manage', 'audit.read', 'integrations.manage'] },
  { key: 'locations', codes: ['org.read', 'org.manage', 'terminals.manage', 'tax.manage'] },
  { key: 'catalog', codes: ['catalog.read', 'catalog.manage', 'prices.manage'] },
  { key: 'selling', codes: ['sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'customers.read', 'customers.manage'] },
  { key: 'stock', codes: ['inventory.read', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'purchasing.manage'] },
  { key: 'restaurant', codes: ['restaurant.manage', 'restaurant.orders', 'kitchen.operate'] },
  { key: 'salon', codes: ['appointments.read', 'appointments.manage', 'staff.manage'], salon: true },
  { key: 'lodging', codes: ['lodging.read', 'lodging.manage', 'lodging.rates', 'lodging.housekeeping', 'lodging.setup'], lodging: true },
  { key: 'books', codes: ['reports.read', 'accounting.read', 'accounting.post'] },
];

/**
 * The areas the role editor shows for this business: the salon area only when it takes appointments,
 * the lodging area only when it has rooms, or either when the role already holds one of its codes (so
 * nothing it has is hidden from view).
 */
export const permissionGroupsFor = (businessType: BusinessType | undefined, held: readonly string[] = []) =>
  PERMISSION_GROUPS.filter(
    (g) =>
      (!g.salon || servesAppointments(businessType) || g.codes.some((c) => held.includes(c))) &&
      (!g.lodging || servesLodging(businessType) || g.codes.some((c) => held.includes(c))),
  );
