import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUSINESS_TYPES, businessUpdateSchema, CORE_PERMISSIONS, createProductSchema, createSaleSchema, isPrivilegedSet, isSubdomainSlug, loginSchema, PERMISSIONS, ROLE_TEMPLATES, roleTemplatesFor, signupSchema, tendersSchema } from '../src/index.js';

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
    // The business update renames only (ADR-0026: a trade is an extension, not a type).
    expect(businessUpdateSchema.parse({ name: ' Tindahan ', businessType: 'RETAIL' })).toEqual({ name: 'Tindahan' });
    expect(businessUpdateSchema.safeParse({ businessType: 'RETAIL' }).success).toBe(false);
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

describe('branding (session 39)', () => {
  it('takes a dark enough brand colour only, and reads blanks as none', async () => {
    const { brandingUpdateSchema, whiteTextContrast, darken, lighten } = await import('../src/branding.js');
    expect(whiteTextContrast('#2a5da8')).toBeGreaterThan(4.5);
    expect(whiteTextContrast('#ffffff')).toBeCloseTo(1);
    expect(brandingUpdateSchema.parse({ brandColor: '#2A5DA8', website: '', facebook: '@page.name' })).toMatchObject({ brandColor: '#2a5da8', website: null, facebook: 'page.name', publicSignIn: false });
    expect(brandingUpdateSchema.safeParse({ brandColor: '#f0c000' }).success).toBe(false);
    expect(brandingUpdateSchema.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
    expect(darken('#808080', 0.5)).toBe('#404040');
    expect(lighten('#000000', 0.5)).toBe('#808080');
  });
});

describe('subdomain slugs (session 40)', () => {
  it('takes DNS labels that are not reserved', () => {
    for (const s of ['alpha-mart', 'ab', 'a1', 'sari-sari-2']) expect(isSubdomainSlug(s), s).toBe(true);
  });
  it('refuses reserved names, a hyphen at the end and IDNA-style prefixes', () => {
    for (const s of ['www', 'api', 'app', 'admin', 'tilvara', 'acme-', 'xn--abc', 'ab--c', 'a', 'Acme', 'a.b', 'a'.repeat(64)]) {
      expect(isSubdomainSlug(s), s).toBe(false);
    }
  });
});

describe('audit 45', () => {
  const u = (n: number) => `0195f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

  it('#13: money that changes hands takes centavos at most; prices keep 4 places', async () => {
    const v = await import('../src/index.js');
    expect(v.tendersSchema.safeParse([{ method: 'CASH', tendered: '100.50' }]).success).toBe(true);
    expect(v.tendersSchema.safeParse([{ method: 'CASH', tendered: '100.505' }]).success).toBe(false);
    expect(v.tendersSchema.safeParse([{ method: 'STORE_CREDIT', amount: '10.005' }]).success).toBe(false);
    expect(v.tendersSchema.safeParse([{ method: 'STORE_CREDIT', amount: '10.01' }]).success).toBe(true);
    expect(v.tendersSchema.safeParse([{ method: 'STORE_CREDIT', amount: '0.00' }]).success).toBe(false);
    expect(v.createPaymentIntentSchema.safeParse({ cashierSessionId: u(1), clientTransactionId: 'c1', method: 'CARD', amount: '10.005' }).success).toBe(false);
    expect(v.createPaymentIntentSchema.safeParse({ cashierSessionId: u(1), clientTransactionId: 'c1', method: 'CARD', amount: '10.01' }).success).toBe(true);
    expect(v.cashMovementSchema.safeParse({ type: 'PAY_IN', amount: '5.125', reason: 'x' }).success).toBe(false);
    expect(v.cashMovementSchema.safeParse({ type: 'PAY_OUT', amount: '5.12', reason: 'x' }).success).toBe(true);
    expect(v.openCashierSessionSchema.safeParse({ registerId: u(1), openingFloat: '1000.0001' }).success).toBe(false);
    expect(v.openCashierSessionSchema.safeParse({ registerId: u(1), openingFloat: '1000' }).success).toBe(true);
    expect(v.closeCashierSessionSchema.safeParse({ countedCash: '999.999' }).success).toBe(false);
    expect(v.closeCashierSessionSchema.safeParse({ countedCash: '999.99' }).success).toBe(true);
    const exchange = (tendered: string) => ({
      cashierSessionId: u(1), saleId: u(2), reason: 'size',
      returnLines: [{ saleLineId: u(3), quantity: '1', disposition: 'RESTOCK' }],
      sale: { clientTransactionId: 'x1', lines: [{ variantId: u(4), quantity: '1' }], tenders: [{ method: 'CASH', tendered }] },
    });
    expect(v.createExchangeSchema.safeParse(exchange('20.00')).success).toBe(true);
    expect(v.createExchangeSchema.safeParse(exchange('20.001')).success).toBe(false);
    // Prices and costs: still 4 places.
    expect(v.amountSchema.safeParse('12.3456').success).toBe(true);
  });

  it('#31: an exchange returns each sale line once', async () => {
    const { createExchangeSchema } = await import('../src/index.js');
    const r = createExchangeSchema.safeParse({
      cashierSessionId: u(1), saleId: u(2), reason: 'size',
      returnLines: [{ saleLineId: u(3), quantity: '1', disposition: 'RESTOCK' }, { saleLineId: u(3), quantity: '1', disposition: 'DAMAGED' }],
      sale: { clientTransactionId: 'x1', lines: [{ variantId: u(4), quantity: '1' }] },
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => [i.path.join('.'), i.message])).toContainEqual(['returnLines.1.saleLineId', 'Each sale line once per return']);
  });

  it('#37: receipts and journal lines compare decimal strings, not JS numbers', async () => {
    const { createGoodsReceiptSchema, createJournalEntrySchema, createSupplierNoteSchema } = await import('../src/index.js');
    const receipt = (quantity: string, rejectedQuantity?: string) => createGoodsReceiptSchema.safeParse({
      branchId: u(1), supplierId: u(2),
      lines: [{ variantId: u(3), quantity, unitCost: '1', ...(rejectedQuantity ? { rejectedQuantity, rejectionReason: 'torn' } : {}) }],
    });
    expect(receipt('0').success).toBe(false);
    expect(receipt('0.0000').success).toBe(false);
    expect(receipt('0.0001').success).toBe(true);
    expect(receipt('0', '0.000').success).toBe(false);
    expect(receipt('0', '2').success).toBe(true);
    const entry = (a: Record<string, string>, b: Record<string, string>) => createJournalEntrySchema.safeParse({
      legalEntityId: u(1), entryDate: '2026-10-27', memo: 'm', lines: [{ accountId: u(2), ...a }, { accountId: u(3), ...b }],
    });
    expect(entry({ debit: '10' }, { credit: '10' }).success).toBe(true);
    expect(entry({ debit: '0.00', credit: '0.0001' }, { credit: '10' }).success).toBe(true);
    expect(entry({ debit: '0.00' }, { credit: '10' }).success).toBe(false);
    expect(entry({ debit: '1', credit: '1' }, { credit: '10' }).success).toBe(false);
    const note = (netAmount: string, vatAmount: string) => createSupplierNoteSchema.safeParse({ kind: 'CREDIT', noteNumber: 'N1', noteDate: '2026-10-27', netAmount, vatAmount, reason: 'r' });
    expect(note('0.00', '0').success).toBe(false);
    expect(note('0', '0.01').success).toBe(true);
  });
});
