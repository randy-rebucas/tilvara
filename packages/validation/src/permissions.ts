/**
 * Permission catalog. MUST match the rows seeded in
 * packages/database/drizzle/0003_identity_rls_auth.sql (checked by an integration test).
 */
import { servesAppointments, servesPharmacy, type BusinessType } from './auth.js';

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
  'customers.read',
  'customers.manage',
  'appointments.read',
  'appointments.manage',
  'staff.manage',
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
  'reports.read',
  'accounting.read',
  'audit.read',
];

/**
 * Privileged codes that only count where the business has that industry (decision A3): recording
 * pharmacist licences is only possible in a pharmacy, so holding the code elsewhere makes no one privileged.
 */
const PRIVILEGED_ONLY_FOR: Partial<Record<PermissionCode, (type: BusinessType) => boolean>> = {
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
  /** Appointments only (ADR-0022): left out for a business without them, added when it changes type. */
  salon?: true;
  /** Prescriptions only (ADR-0025): left out for a business without them, added when it changes type. */
  pharmacy?: true;
}

/** The appointment codes (ADR-0022). */
export const APPOINTMENT_CODES: readonly PermissionCode[] = ['appointments.read', 'appointments.manage', 'staff.manage'];
/** The pharmacy codes (ADR-0025 §9). */
export const PHARMACY_CODES: readonly PermissionCode[] = ['pharmacy.read', 'pharmacy.dispense', 'pharmacy.dangerous_drugs', 'pharmacy.setup'];

const all = PERMISSIONS;

const BRANCH_MANAGER: readonly PermissionCode[] = [
  'members.read', 'org.read', 'catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void',
  'sales.price_override', 'sales.discount', 'cash.session', 'cash.reconcile', 'inventory.read',
  'inventory.adjust', 'inventory.transfer', 'customers.read',
  'customers.manage', 'reports.read', 'appointments.read', 'appointments.manage', 'staff.manage',
  'pharmacy.read', 'pharmacy.dispense',
];

/** System roles seeded into every new tenant. Tenants may add custom roles later. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: all },
  { key: 'admin', name: 'Administrator', permissions: all.filter((p) => p !== 'subscription.manage') },
  { key: 'branch_manager', name: 'Branch Manager', permissions: BRANCH_MANAGER },
  {
    key: 'cashier',
    name: 'Cashier',
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'appointments.read', 'appointments.manage'],
  },
  /**
   * The front desk of a salon, spa or barber shop (ADR-0022 §4): books, checks in and rings up; adds
   * clients.
   */
  {
    key: 'front_desk',
    name: 'Front Desk',
    permissions: [
      'catalog.read', 'sales.create', 'sales.read', 'cash.session', 'customers.read', 'customers.manage', 'appointments.read', 'appointments.manage',
    ],
    salon: true,
  },
  /** A stylist, therapist or barber who signs in to see the calendar (ADR-0022 §4). */
  { key: 'stylist', name: 'Stylist', permissions: ['catalog.read', 'appointments.read', 'customers.read'], salon: true },
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
    permissions: ['catalog.read', 'sales.create', 'sales.read', 'sales.refund', 'sales.void', 'sales.discount', 'cash.session', 'customers.read', 'customers.manage', 'appointments.read', 'appointments.manage'],
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

/**
 * The built-in roles a business of this type is given: salon roles (front desk, stylist) only when it
 * takes appointments (ADR-0022), pharmacy roles only when it dispenses (ADR-0025).
 */
export const roleTemplatesFor = (businessType: BusinessType): readonly RoleTemplate[] =>
  ROLE_TEMPLATES.filter((t) => {
    if (t.pharmacy) return servesPharmacy(businessType);
    if (t.salon) return servesAppointments(businessType);
    return true;
  });
