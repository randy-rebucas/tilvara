/**
 * Permission catalog. MUST match the rows seeded in
 * packages/database/drizzle/0003_identity_rls_auth.sql (checked by an integration test).
 */
import { servesAppointments, servesLaundry, servesLodging, servesPharmacy, servesTables, type BusinessType } from './auth.js';

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
  'appointments.read',
  'appointments.manage',
  'staff.manage',
  'lodging.read',
  'lodging.manage',
  'lodging.rates',
  'lodging.housekeeping',
  'lodging.setup',
  'laundry.read',
  'laundry.manage',
  'laundry.release_override',
  'laundry.deliver',
  'laundry.dispose',
  'laundry.setup',
  'pharmacy.read',
  'pharmacy.dispense',
  'pharmacy.dangerous_drugs',
  'pharmacy.setup',
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
  /** Dispensing dangerous drugs (ADR-0025 §9). */
  'pharmacy.dangerous_drugs',
  /** Recording pharmacist licences (ADR-0025 §9; audit decision A3, 2026-10-21). */
  'pharmacy.setup',
  /** Disposing of unclaimed laundry, which forfeits down payments to income (ADR-0024; decision A3). */
  'laundry.dispose',
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
  'appointments.read',
  'lodging.read',
  'laundry.read',
  'reports.read',
  'accounting.read',
  'audit.read',
];

/**
 * Privileged codes that only count where the business has that industry (decision A3): built-in
 * managers hold the laundry codes in every business (migration 0104), but disposing of laundry is
 * only possible in a laundry, so a retail branch manager is not made privileged by it.
 */
const PRIVILEGED_ONLY_FOR: Partial<Record<PermissionCode, (type: BusinessType) => boolean>> = {
  'laundry.dispose': servesLaundry,
  'pharmacy.setup': servesPharmacy,
};

/** Whether these codes make a member privileged; with `businessType`, industry codes count only where that industry is served. */
export const isPrivilegedSet = (codes: Iterable<string>, businessType?: BusinessType): boolean => {
  for (const c of codes) {
    if (!(PRIVILEGED_PERMISSIONS as readonly string[]).includes(c)) continue;
    const only = PRIVILEGED_ONLY_FOR[c as PermissionCode];
    if (businessType === undefined || !only || only(businessType)) return true;
  }
  return false;
};

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionCode[];
  /** Restaurant service only: left out for a business that does not serve tables, added when it changes type. */
  restaurant?: true;
  /** Appointments only (ADR-0022): left out for a business without them, added when it changes type. */
  salon?: true;
  /**
   * Rooms and stays only (ADR-0023): left out for a business without them, added when it changes type.
   * A template marked both (the front desk) serves either industry: `roleTemplatesFor` keeps the codes
   * of the industries the business has.
   */
  lodging?: true;
  /** Job orders and deliveries only (ADR-0024): left out for a business without them, added when it changes type. */
  laundry?: true;
  /** Prescriptions only (ADR-0025): left out for a business without them, added when it changes type. */
  pharmacy?: true;
}

/** The appointment codes (ADR-0022) and the lodging codes (ADR-0023), trimmed off a shared template. */
export const APPOINTMENT_CODES: readonly PermissionCode[] = ['appointments.read', 'appointments.manage', 'staff.manage'];
export const LODGING_CODES: readonly PermissionCode[] = ['lodging.read', 'lodging.manage', 'lodging.rates', 'lodging.housekeeping', 'lodging.setup'];
/** The laundry codes (ADR-0024 §12). */
export const LAUNDRY_CODES: readonly PermissionCode[] = ['laundry.read', 'laundry.manage', 'laundry.release_override', 'laundry.deliver', 'laundry.dispose', 'laundry.setup'];
/** The pharmacy codes (ADR-0025 §9). */
export const PHARMACY_CODES: readonly PermissionCode[] = ['pharmacy.read', 'pharmacy.dispense', 'pharmacy.dangerous_drugs', 'pharmacy.setup'];

const all = PERMISSIONS;

const BRANCH_MANAGER: readonly PermissionCode[] = [
  'members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void',
  'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read',
  'inventory.adjust', 'inventory.transfer', 'restaurant.orders', 'kitchen.operate', 'customers.read',
  'customers.manage', 'reports.read', 'appointments.read', 'appointments.manage', 'staff.manage',
  'lodging.read', 'lodging.manage', 'lodging.rates', 'lodging.housekeeping', 'lodging.setup',
  'laundry.read', 'laundry.manage', 'laundry.release_override', 'laundry.deliver', 'laundry.dispose', 'laundry.setup',
  'pharmacy.read', 'pharmacy.dispense',
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
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'restaurant.orders', 'appointments.read', 'appointments.manage', 'lodging.read', 'laundry.read', 'laundry.manage'],
  },
  /**
   * The front desk of a salon, spa or barber shop (ADR-0022 §4): books, checks in and rings up; adds
   * clients. The same template is a hotel's front desk (ADR-0023 §9): stays, check-in/out, folios.
   */
  {
    key: 'front_desk',
    name: 'Front Desk',
    permissions: [
      'catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'customers.manage', 'appointments.read', 'appointments.manage',
      'lodging.read', 'lodging.manage', 'lodging.housekeeping',
    ],
    salon: true,
    lodging: true,
  },
  /** A stylist, therapist or barber who signs in to see the calendar (ADR-0022 §4). */
  { key: 'stylist', name: 'Stylist', permissions: ['catalog.read', 'appointments.read', 'customers.read'], salon: true },
  /** A hotel's housekeeping (ADR-0023 §9): the board of rooms and their cleaning status. */
  { key: 'housekeeping', name: 'Housekeeping', permissions: ['lodging.read', 'lodging.housekeeping'], lodging: true },
  /** A laundry's counter (ADR-0024 §12): receives, weighs, moves jobs along and releases them; rings up claims. */
  {
    key: 'laundry_attendant',
    name: 'Laundry Attendant',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'customers.manage', 'laundry.read', 'laundry.manage'],
    laundry: true,
  },
  /** Picks up and delivers laundry (ADR-0024 §8), and takes payment at the door on their own drawer. */
  { key: 'rider', name: 'Rider', permissions: ['laundry.read', 'laundry.deliver', 'sales.create', 'cash.session'], laundry: true },
  /**
   * A pharmacy's pharmacist (ADR-0025 §9): dispenses prescription medicines and dangerous drugs (with a
   * licence on record), takes returns, keeps the stock counted. Privileged (two-step sign-in).
   */
  {
    key: 'pharmacist',
    name: 'Pharmacist',
    permissions: [
      'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'cash.session', 'customers.read', 'customers.manage',
      'inventory.read', 'inventory.adjust', 'inventory.count', 'pharmacy.read', 'pharmacy.dispense', 'pharmacy.dangerous_drugs',
    ],
    pharmacy: true,
  },
  /** Sells over the counter; prescription medicines need a pharmacist's approval at the till (ADR-0025 §6). */
  {
    key: 'pharmacy_assistant',
    name: 'Pharmacy Assistant',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'inventory.read', 'inventory.count', 'pharmacy.read'],
    pharmacy: true,
  },
  /**
   * A cashier trusted with refunds, voids and discounts, and with adding customers (SPEC §4; session 22,
   * migration 0081). Price overrides and drawer approvals stay with a manager.
   */
  {
    key: 'senior_cashier',
    name: 'Senior Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.discount', 'cash.session', 'customers.read', 'customers.manage', 'restaurant.orders', 'appointments.read', 'appointments.manage', 'lodging.read', 'laundry.read', 'laundry.manage'],
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
    permissions: ['org.read', 'sales.read', 'inventory.read', 'reports.read', 'accounting.read', 'accounting.post', 'audit.read', 'lodging.read', 'laundry.read'],
  },
];

/**
 * The built-in roles a business of this type is given: restaurant roles only when it serves tables,
 * salon roles (stylist) only when it takes appointments (ADR-0022), lodging roles (housekeeping) only
 * when it has rooms (ADR-0023). The front desk serves either: it keeps the codes of the industries the
 * business has (a hotel's front desk has no appointment codes, a salon's no lodging codes).
 */
export const roleTemplatesFor = (businessType: BusinessType): readonly RoleTemplate[] => {
  const appointments = servesAppointments(businessType);
  const lodging = servesLodging(businessType);
  return ROLE_TEMPLATES.filter((t) => {
    if (t.restaurant && !servesTables(businessType)) return false;
    if (t.laundry) return servesLaundry(businessType);
    if (t.pharmacy) return servesPharmacy(businessType);
    if (t.salon || t.lodging) return Boolean((t.salon && appointments) || (t.lodging && lodging));
    return true;
  }).map((t) =>
    t.salon && t.lodging && !(appointments && lodging)
      ? { ...t, permissions: t.permissions.filter((p) => (appointments || !APPOINTMENT_CODES.includes(p)) && (lodging || !LODGING_CODES.includes(p))) }
      : t,
  );
};
