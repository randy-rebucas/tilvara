import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUSINESS_TYPES, CORE_PERMISSIONS, createProductSchema, createSaleSchema, isPrivilegedSet, loginSchema, PERMISSIONS, ROLE_TEMPLATES, roleTemplatesFor, signupSchema, tendersSchema } from '../src/index.js';

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

  it.each([
    ['0081_role_templates_senior_cashier_purchasing.sql', ['senior_cashier', 'purchasing_officer']],
  ])('migration %s back-fills exactly these templates into existing businesses', (file, keys) => {
    const sql = readFileSync(fileURLToPath(new URL(`../../database/drizzle/${file}`, import.meta.url)), 'utf8');
    for (const key of keys) {
      const t = ROLE_TEMPLATES.find((x) => x.key === key)!;
      const m = new RegExp(`\\('${key}', '${t.name}', ARRAY\\[([^\\]]*)\\]`).exec(sql);
      expect(m, key).not.toBeNull();
      // Restaurant and lodging codes left the catalog and every role in 0111; salon and pharmacy codes in 0112.
      const removed = /^(restaurant|kitchen|lodging|appointments|staff|pharmacy)\./;
      expect(m![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).filter((p) => !removed.test(p)).sort()).toEqual([...t.permissions].sort());
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

  it('restaurant and lodging are not business types (removed 2026-10-25): no table-service or room roles, codes or tenders', () => {
    expect(BUSINESS_TYPES).not.toContain('RESTAURANT');
    expect(BUSINESS_TYPES).not.toContain('LODGING');
    expect(ROLE_TEMPLATES.map((t) => t.key)).not.toEqual(expect.arrayContaining(['restaurant_manager', 'kitchen_crew', 'housekeeping']));
    expect(PERMISSIONS.some((p) => /^(restaurant|kitchen|lodging)\./.test(p))).toBe(false);
    expect(tendersSchema.safeParse([{ method: 'ROOM_CHARGE', stayId: '0195f0a0-0000-7000-8000-000000000001' }]).success).toBe(false);
  });

  it('laundry is not a business type (removed 2026-10-25); a client never tenders a down payment', () => {
    expect(BUSINESS_TYPES).not.toContain('LAUNDRY');
    expect(ROLE_TEMPLATES.map((t) => t.key)).not.toEqual(expect.arrayContaining(['laundry_attendant', 'rider']));
    expect(PERMISSIONS.some((p) => p.startsWith('laundry.'))).toBe(false);
    const jobOrderId = '0195f0a0-0000-7000-8000-000000000001';
    expect(tendersSchema.safeParse([{ method: 'JOB_DEPOSIT', jobOrderId }]).success).toBe(false);
  });

  it('retail only (2026-10-25, migration 0112): no salon, pharmacy, grocery or hybrid type, roles, codes, packages, tips or prescriptions', () => {
    expect(BUSINESS_TYPES).toEqual(['RETAIL']);
    expect(signupSchema.parse({ email: 'a@b.ph', password: 'correct horse battery', displayName: 'A', businessName: 'B', tenantSlug: 'bb' }).businessType).toBe('RETAIL');
    for (const t of ['SALON', 'PHARMACY', 'GROCERY', 'HYBRID']) expect(signupSchema.safeParse({ email: 'a@b.ph', password: 'correct horse battery', displayName: 'A', businessName: 'B', tenantSlug: 'bb', businessType: t }).success).toBe(false);
    expect(ROLE_TEMPLATES.map((t) => t.key)).not.toEqual(expect.arrayContaining(['front_desk', 'stylist', 'pharmacist', 'pharmacy_assistant']));
    expect(PERMISSIONS.some((p) => /^(appointments|staff|pharmacy)\./.test(p))).toBe(false);
    expect(roleTemplatesFor()).toEqual(ROLE_TEMPLATES);
    const product = { name: 'P', taxCategoryId: '0195f0a0-0000-7000-8000-000000000001', uomId: '0195f0a0-0000-7000-8000-000000000002', variants: [{ sku: 'P1' }] };
    expect(createProductSchema.safeParse({ ...product, productType: 'PACKAGE', trackInventory: false }).success).toBe(false);
    // Unknown keys (a tip, an appointment, prescriptions) are stripped, never recorded.
    const sale = createSaleSchema.parse({
      cashierSessionId: '0195f0a0-0000-7000-8000-000000000003', clientTransactionId: 'c1',
      lines: [{ variantId: '0195f0a0-0000-7000-8000-000000000004', quantity: '1', staffId: '0195f0a0-0000-7000-8000-000000000005' }],
      tenders: [{ method: 'CASH', tendered: '10' }], tip: { amount: '5' }, prescriptions: [],
    } as unknown);
    expect(sale).not.toHaveProperty('tip');
    expect(sale).not.toHaveProperty('prescriptions');
    expect(sale.lines[0]).not.toHaveProperty('staffId');
  });

  it('owner holds every base permission; admin cannot manage the subscription', () => {
    expect(ROLE_TEMPLATES.find((t) => t.key === 'owner')!.permissions).toHaveLength(CORE_PERMISSIONS.length);
    expect(ROLE_TEMPLATES.find((t) => t.key === 'admin')!.permissions).not.toContain('subscription.manage');
  });
});
