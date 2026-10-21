import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPrivilegedSet, LAUNDRY_CODES, PHARMACY_CODES, LODGING_CODES, loginSchema, PERMISSIONS, ROLE_TEMPLATES, roleTemplatesFor, servesAppointments, servesLaundry, servesLodging, servesTables, signupSchema, tendersSchema, usesPackages, usesRecipes } from '../src/index.js';

describe('signupSchema', () => {
  const valid = {
    email: '  Owner@Example.PH ',
    password: 'correct horse battery',
    displayName: 'Juan',
    businessName: 'Sari-Sari Plus',
    tenantSlug: 'Sari-Sari-Plus',
  };

  it('normalises email and slug', () => {
    const r = signupSchema.parse(valid);
    expect(r.email).toBe('owner@example.ph');
    expect(r.tenantSlug).toBe('sari-sari-plus');
  });

  it('rejects short passwords, bad slugs and bad emails', () => {
    expect(signupSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...valid, tenantSlug: 'bad slug!' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false);
  });

  it('strips unknown fields such as a client-supplied tenantId', () => {
    const r = loginSchema.parse({ email: 'a@b.ph', password: 'x', isAdmin: true } as unknown);
    expect(r).not.toHaveProperty('isAdmin');
  });
});

describe('role templates', () => {
  it('only reference catalogued permissions and have unique keys', () => {
    const keys = new Set<string>();
    for (const t of ROLE_TEMPLATES) {
      expect(keys.has(t.key)).toBe(false);
      keys.add(t.key);
      for (const p of t.permissions) expect(PERMISSIONS).toContain(p);
    }
  });

  it('restaurant manager = branch manager + restaurant set-up; kitchen crew works the KDS only; neither needs MFA', () => {
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect([...of('restaurant_manager')].sort()).toEqual([...of('branch_manager'), 'restaurant.manage'].sort());
    expect(of('kitchen_crew')).toEqual(['kitchen.operate']);
    expect(isPrivilegedSet(of('restaurant_manager'), 'RESTAURANT')).toBe(false);
    expect(isPrivilegedSet(of('kitchen_crew'))).toBe(false);
  });

  it('decision A3: recording pharmacist licences and disposing of laundry need two-step sign-in, where the business has that industry', () => {
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(isPrivilegedSet(['pharmacy.setup'])).toBe(true);
    expect(isPrivilegedSet(['laundry.dispose'])).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'PHARMACY')).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'HYBRID')).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'RETAIL')).toBe(false);
    expect(isPrivilegedSet(['laundry.dispose'], 'LAUNDRY')).toBe(true);
    expect(isPrivilegedSet(['laundry.dispose'], 'RESTAURANT')).toBe(false);
    // A laundry's branch manager may dispose: privileged there, not in a shop.
    expect(isPrivilegedSet(of('branch_manager'), 'LAUNDRY')).toBe(true);
    expect(isPrivilegedSet(of('branch_manager'), 'RETAIL')).toBe(false);
    expect(isPrivilegedSet(of('laundry_attendant'), 'LAUNDRY')).toBe(false);
    // Other privileged codes count everywhere.
    expect(isPrivilegedSet(['tax.manage'], 'RETAIL')).toBe(true);
  });

  it.each([
    ['0049_restaurant_role_templates.sql', ['restaurant_manager', 'kitchen_crew']],
    ['0081_role_templates_senior_cashier_purchasing.sql', ['senior_cashier', 'purchasing_officer']],
    ['0099_salons_appointments_packages_rls.sql', ['front_desk', 'stylist']],
    ['0102_lodging_rooms_folios_rls.sql', ['housekeeping']],
    ['0104_laundry_job_orders_rls.sql', ['laundry_attendant', 'rider']],
    ['0106_pharmacy_prescriptions_lots_rls.sql', ['pharmacist', 'pharmacy_assistant']],
  ])('migration %s back-fills exactly these templates into existing businesses', (file, keys) => {
    const sql = readFileSync(fileURLToPath(new URL(`../../database/drizzle/${file}`, import.meta.url)), 'utf8');
    for (const key of keys) {
      const t = ROLE_TEMPLATES.find((x) => x.key === key)!;
      const m = new RegExp(`\\('${key}', '${t.name}', ARRAY\\[([^\\]]*)\\]`).exec(sql);
      expect(m, key).not.toBeNull();
      // Codes catalogued after the migration was written are granted to existing roles by their own migration (0099).
      const later = [
        ...(file < '0099' ? ['appointments.read', 'appointments.manage', 'staff.manage'] : []),
        ...(file < '0102' ? LODGING_CODES : []),
        ...(file < '0104' ? LAUNDRY_CODES : []),
        ...(file < '0106' ? PHARMACY_CODES : []),
      ];
      expect(m![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual(t.permissions.filter((p) => !later.includes(p)).sort());
    }
  });

  it('senior cashier = cashier + refunds, voids, discounts, customers; purchasing officer adjusts no stock; neither needs MFA', () => {
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect([...of('senior_cashier')].sort()).toEqual([...of('cashier'), 'sales.refund', 'sales.void', 'sales.discount', 'customers.manage'].sort());
    expect(of('senior_cashier')).not.toContain('sales.price_override');
    expect(of('purchasing_officer')).toContain('purchasing.manage');
    expect(of('purchasing_officer')).not.toContain('inventory.adjust');
    expect(isPrivilegedSet(of('senior_cashier'))).toBe(false);
    expect(isPrivilegedSet(of('purchasing_officer'))).toBe(false);
  });

  it('a retail business gets no restaurant roles; the others get every template', () => {
    expect(roleTemplatesFor('RETAIL').map((t) => t.key)).not.toEqual(expect.arrayContaining(['restaurant_manager']));
    expect(roleTemplatesFor('RETAIL').some((t) => t.key === 'kitchen_crew')).toBe(false);
    expect(roleTemplatesFor('RETAIL').some((t) => t.key === 'cashier')).toBe(true);
    expect(roleTemplatesFor('RESTAURANT')).toEqual(ROLE_TEMPLATES.filter((t) => !t.salon && !t.lodging && !t.laundry && !t.pharmacy));
    // A pharmacy (ADR-0025): the shop set plus the pharmacist and the assistant; the pharmacist needs two-step sign-in.
    expect(roleTemplatesFor('PHARMACY').map((t) => t.key)).toEqual([...roleTemplatesFor('RETAIL').map((t) => t.key).filter((k) => !['pharmacist', 'pharmacy_assistant'].includes(k)), 'pharmacist', 'pharmacy_assistant'].sort((x, y) => ROLE_TEMPLATES.findIndex((t) => t.key === x) - ROLE_TEMPLATES.findIndex((t) => t.key === y)));
    expect(isPrivilegedSet(ROLE_TEMPLATES.find((t) => t.key === 'pharmacist')!.permissions)).toBe(true);
    expect(isPrivilegedSet(ROLE_TEMPLATES.find((t) => t.key === 'pharmacy_assistant')!.permissions)).toBe(false);
    expect(servesTables('PHARMACY')).toBe(false);
    expect(roleTemplatesFor('HYBRID')).toEqual(ROLE_TEMPLATES);
    // A sari-sari store or grocery (ADR-0020) is a shop: the retail set.
    expect(roleTemplatesFor('GROCERY')).toEqual(roleTemplatesFor('RETAIL'));
    expect(servesTables('GROCERY')).toBe(false);
    expect(servesTables('HYBRID')).toBe(true);
  });

  it('a salon (ADR-0022) gets the shop roles plus front desk and stylist; nobody else but HYBRID gets those', () => {
    const keys = (t: Parameters<typeof roleTemplatesFor>[0]) => roleTemplatesFor(t).map((x) => x.key);
    expect(keys('SALON')).toEqual(expect.arrayContaining(['front_desk', 'stylist', 'cashier']));
    expect(keys('SALON')).not.toContain('kitchen_crew');
    for (const t of ['RETAIL', 'GROCERY', 'RESTAURANT'] as const) expect(keys(t)).not.toContain('front_desk');
    expect(servesAppointments('SALON')).toBe(true);
    expect(servesAppointments('HYBRID')).toBe(true);
    expect(servesAppointments('RETAIL')).toBe(false);
    expect(usesRecipes('SALON')).toBe(true);
    expect(usesRecipes('GROCERY')).toBe(false);
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(of('stylist')).not.toContain('sales.create');
    expect(isPrivilegedSet(of('front_desk'))).toBe(false);
  });

  it('a hotel (ADR-0023) serves tables, gets housekeeping and a front desk without appointment codes; the salon front desk has no lodging codes', () => {
    const keys = (t: Parameters<typeof roleTemplatesFor>[0]) => roleTemplatesFor(t).map((x) => x.key);
    expect(keys('LODGING')).toEqual(expect.arrayContaining(['front_desk', 'housekeeping', 'restaurant_manager', 'kitchen_crew', 'cashier']));
    expect(keys('LODGING')).not.toContain('stylist');
    for (const t of ['RETAIL', 'GROCERY', 'RESTAURANT', 'SALON'] as const) expect(keys(t)).not.toContain('housekeeping');
    expect(servesTables('LODGING')).toBe(true);
    expect(servesLodging('LODGING')).toBe(true);
    expect(servesLodging('HYBRID')).toBe(true);
    expect(servesLodging('SALON')).toBe(false);
    const desk = (t: Parameters<typeof roleTemplatesFor>[0]) => roleTemplatesFor(t).find((x) => x.key === 'front_desk')!.permissions;
    expect(desk('LODGING')).toEqual(expect.arrayContaining(['lodging.read', 'lodging.manage', 'sales.create']));
    expect(desk('LODGING')).not.toContain('appointments.manage');
    expect(desk('SALON').some((p) => p.startsWith('lodging.'))).toBe(false);
    expect([...desk('HYBRID')].sort()).toEqual([...ROLE_TEMPLATES.find((t) => t.key === 'front_desk')!.permissions].sort());
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(of('housekeeping')).toEqual(['lodging.read', 'lodging.housekeeping']);
    expect(of('branch_manager')).toEqual(expect.arrayContaining([...LODGING_CODES]));
    for (const k of ['cashier', 'senior_cashier', 'accountant']) expect(of(k)).toContain('lodging.read');
    expect(isPrivilegedSet(of('housekeeping'))).toBe(false);
  });

  it('a laundry (ADR-0024) gets the attendant and rider roles, packages and recipes; nobody but HYBRID gets them; a client never tenders a down payment', () => {
    const keys = (t: Parameters<typeof roleTemplatesFor>[0]) => roleTemplatesFor(t).map((x) => x.key);
    expect(keys('LAUNDRY')).toEqual(expect.arrayContaining(['laundry_attendant', 'rider', 'cashier', 'branch_manager']));
    expect(keys('LAUNDRY')).not.toEqual(expect.arrayContaining(['kitchen_crew']));
    expect(keys('LAUNDRY')).not.toContain('front_desk');
    for (const t of ['RETAIL', 'GROCERY', 'RESTAURANT', 'SALON', 'LODGING'] as const) expect(keys(t)).not.toContain('rider');
    expect(keys('HYBRID')).toEqual(expect.arrayContaining(['laundry_attendant', 'rider']));
    expect([servesLaundry('LAUNDRY'), servesLaundry('HYBRID'), servesLaundry('SALON'), servesTables('LAUNDRY')]).toEqual([true, true, false, false]);
    expect([usesPackages('LAUNDRY'), usesPackages('SALON'), usesPackages('RETAIL'), usesRecipes('LAUNDRY')]).toEqual([true, true, false, true]);
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(of('branch_manager')).toEqual(expect.arrayContaining([...LAUNDRY_CODES]));
    expect(of('rider')).toEqual(['laundry.read', 'laundry.deliver', 'sales.create', 'cash.session']);
    expect(of('laundry_attendant')).not.toContain('laundry.dispose');
    expect(of('laundry_attendant')).not.toContain('laundry.release_override');
    for (const k of ['cashier', 'senior_cashier']) expect(of(k)).toEqual(expect.arrayContaining(['laundry.read', 'laundry.manage']));
    expect(isPrivilegedSet(of('rider'))).toBe(false);
    const jobOrderId = '0195f0a0-0000-7000-8000-000000000001';
    expect(tendersSchema.safeParse([{ method: 'JOB_DEPOSIT', jobOrderId }]).success).toBe(false);
  });

  it('charge to room: once per sale', () => {
    const stayId = '0195f0a0-0000-7000-8000-000000000001';
    expect(tendersSchema.safeParse([{ method: 'ROOM_CHARGE', stayId }]).success).toBe(true);
    expect(tendersSchema.safeParse([{ method: 'ROOM_CHARGE', stayId }, { method: 'ROOM_CHARGE', stayId }]).success).toBe(false);
  });

  it('owner holds every permission; admin cannot manage the subscription', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions).toHaveLength(PERMISSIONS.length);
    expect(ROLE_TEMPLATES.find((t) => t.key === 'admin')!.permissions).not.toContain('subscription.manage');
  });
});
