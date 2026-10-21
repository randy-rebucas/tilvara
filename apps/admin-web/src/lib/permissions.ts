import { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode } from '@1pos/validation/permissions';
import { servesAppointments, servesLaundry, servesLodging, servesPharmacy, type BusinessType } from './business-type';

export { PERMISSIONS, PRIVILEGED_PERMISSIONS, type PermissionCode };

/**
 * Permission areas for the role editor, in the order an owner thinks about them. Every code appears once.
 * `salon`: appointments and service staff (ADR-0022), shown only to a business that takes appointments.
 * `lodging`: rooms, stays, folios and housekeeping (ADR-0023), shown only to a business with rooms.
 * `laundry`: job orders, machines and deliveries (ADR-0024), shown only to a laundry.
 * `pharmacy`: prescriptions, the books, dangerous drugs and the pharmacy set-up (ADR-0025), shown only to a pharmacy.
 */
export const PERMISSION_GROUPS: readonly { key: string; codes: readonly PermissionCode[]; salon?: true; lodging?: true; laundry?: true; pharmacy?: true }[] = [
  { key: 'business', codes: ['tenant.manage', 'subscription.manage', 'members.read', 'members.manage', 'roles.read', 'roles.manage', 'audit.read', 'integrations.manage'] },
  { key: 'locations', codes: ['org.read', 'org.manage', 'terminals.manage', 'tax.manage'] },
  { key: 'catalog', codes: ['catalog.read', 'catalog.manage', 'prices.manage'] },
  { key: 'selling', codes: ['sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'customers.read', 'customers.manage'] },
  { key: 'stock', codes: ['inventory.read', 'inventory.adjust', 'inventory.count', 'inventory.transfer', 'purchasing.manage'] },
  { key: 'restaurant', codes: ['restaurant.manage', 'restaurant.orders', 'kitchen.operate'] },
  { key: 'salon', codes: ['appointments.read', 'appointments.manage', 'staff.manage'], salon: true },
  { key: 'lodging', codes: ['lodging.read', 'lodging.manage', 'lodging.rates', 'lodging.housekeeping', 'lodging.setup'], lodging: true },
  { key: 'laundry', codes: ['laundry.read', 'laundry.manage', 'laundry.release_override', 'laundry.deliver', 'laundry.dispose', 'laundry.setup'], laundry: true },
  { key: 'pharmacy', codes: ['pharmacy.read', 'pharmacy.dispense', 'pharmacy.dangerous_drugs', 'pharmacy.setup'], pharmacy: true },
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
      (!g.lodging || servesLodging(businessType) || g.codes.some((c) => held.includes(c))) &&
      (!g.laundry || servesLaundry(businessType) || g.codes.some((c) => held.includes(c))) &&
      (!g.pharmacy || servesPharmacy(businessType) || g.codes.some((c) => held.includes(c))),
  );
