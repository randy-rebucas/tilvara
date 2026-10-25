import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUSINESS_TYPES, isPrivilegedSet, PHARMACY_CODES, loginSchema, PERMISSIONS, ROLE_TEMPLATES, roleTemplatesFor, servesAppointments, signupSchema, tendersSchema, usesPackages, usesRecipes } from '../src/index.js';

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

  it('decision A3: recording pharmacist licences needs two-step sign-in, where the business has that industry', () => {
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(isPrivilegedSet(['pharmacy.setup'])).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'PHARMACY')).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'HYBRID')).toBe(true);
    expect(isPrivilegedSet(['pharmacy.setup'], 'RETAIL')).toBe(false);
    expect(isPrivilegedSet(of('branch_manager'), 'HYBRID')).toBe(false);
    // Other privileged codes count everywhere.
    expect(isPrivilegedSet(['tax.manage'], 'RETAIL')).toBe(true);
  });

  it.each([
    ['0081_role_templates_senior_cashier_purchasing.sql', ['senior_cashier', 'purchasing_officer']],
    ['0099_salons_appointments_packages_rls.sql', ['front_desk', 'stylist']],
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
        ...(file < '0106' ? PHARMACY_CODES : []),
      ];
      // Restaurant and lodging codes left the catalog and every role in 0111.
      const removed = /^(restaurant|kitchen|lodging)\./;
      expect(m![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).filter((p) => !removed.test(p)).sort()).toEqual(t.permissions.filter((p) => !later.includes(p)).sort());
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

  it('a retail business gets the shop roles; HYBRID gets every template', () => {
    expect(roleTemplatesFor('RETAIL').some((t) => t.key === 'cashier')).toBe(true);
    expect(roleTemplatesFor('RETAIL')).toEqual(ROLE_TEMPLATES.filter((t) => !t.salon && !t.pharmacy));
    // A pharmacy (ADR-0025): the shop set plus the pharmacist and the assistant; the pharmacist needs two-step sign-in.
    expect(roleTemplatesFor('PHARMACY').map((t) => t.key)).toEqual([...roleTemplatesFor('RETAIL').map((t) => t.key).filter((k) => !['pharmacist', 'pharmacy_assistant'].includes(k)), 'pharmacist', 'pharmacy_assistant'].sort((x, y) => ROLE_TEMPLATES.findIndex((t) => t.key === x) - ROLE_TEMPLATES.findIndex((t) => t.key === y)));
    expect(isPrivilegedSet(ROLE_TEMPLATES.find((t) => t.key === 'pharmacist')!.permissions)).toBe(true);
    expect(isPrivilegedSet(ROLE_TEMPLATES.find((t) => t.key === 'pharmacy_assistant')!.permissions)).toBe(false);
    expect(roleTemplatesFor('HYBRID')).toEqual(ROLE_TEMPLATES);
    // A sari-sari store or grocery (ADR-0020) is a shop: the retail set.
    expect(roleTemplatesFor('GROCERY')).toEqual(roleTemplatesFor('RETAIL'));
  });

  it('a salon (ADR-0022) gets the shop roles plus front desk and stylist; nobody else but HYBRID gets those', () => {
    const keys = (t: Parameters<typeof roleTemplatesFor>[0]) => roleTemplatesFor(t).map((x) => x.key);
    expect(keys('SALON')).toEqual(expect.arrayContaining(['front_desk', 'stylist', 'cashier']));
    for (const t of ['RETAIL', 'GROCERY', 'PHARMACY'] as const) expect(keys(t)).not.toContain('front_desk');
    expect(servesAppointments('SALON')).toBe(true);
    expect(servesAppointments('HYBRID')).toBe(true);
    expect(servesAppointments('RETAIL')).toBe(false);
    expect(usesRecipes('SALON')).toBe(true);
    expect(usesRecipes('GROCERY')).toBe(false);
    const of = (k: string) => ROLE_TEMPLATES.find((t) => t.key === k)!.permissions;
    expect(of('stylist')).not.toContain('sales.create');
    expect(isPrivilegedSet(of('front_desk'))).toBe(false);
  });

  it('restaurant and lodging are not business types (removed 2026-10-25): no table-service or room roles, codes or tenders', () => {
    expect(BUSINESS_TYPES).not.toContain('RESTAURANT');
    expect(BUSINESS_TYPES).not.toContain('LODGING');
    expect(ROLE_TEMPLATES.map((t) => t.key)).not.toEqual(expect.arrayContaining(['restaurant_manager', 'kitchen_crew', 'housekeeping']));
    expect(PERMISSIONS.some((p) => /^(restaurant|kitchen|lodging)\./.test(p))).toBe(false);
    expect(tendersSchema.safeParse([{ method: 'ROOM_CHARGE', stayId: '0195f0a0-0000-7000-8000-000000000001' }]).success).toBe(false);
    expect(usesRecipes('HYBRID')).toBe(true);
  });

  it('laundry is not a business type (removed 2026-10-25); a client never tenders a down payment', () => {
    expect(BUSINESS_TYPES).not.toContain('LAUNDRY');
    expect(ROLE_TEMPLATES.map((t) => t.key)).not.toEqual(expect.arrayContaining(['laundry_attendant', 'rider']));
    expect(PERMISSIONS.some((p) => p.startsWith('laundry.'))).toBe(false);
    expect([usesPackages('SALON'), usesPackages('HYBRID'), usesPackages('RETAIL'), usesRecipes('SALON'), usesRecipes('RETAIL')]).toEqual([true, true, false, true, false]);
    const jobOrderId = '0195f0a0-0000-7000-8000-000000000001';
    expect(tendersSchema.safeParse([{ method: 'JOB_DEPOSIT', jobOrderId }]).success).toBe(false);
  });

  it('owner holds every permission; admin cannot manage the subscription', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions).toHaveLength(PERMISSIONS.length);
    expect(ROLE_TEMPLATES.find((t) => t.key === 'admin')!.permissions).not.toContain('subscription.manage');
  });
});
