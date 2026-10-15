import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

interface Shop {
  t: SignedUp;
  auth: { Authorization: string };
  entityId: string;
  branchId: string;
  tax: Record<string, string>;
  pc: string;
  kg: string;
}

async function shop(prefix: string, vatStatus: 'VAT' | 'NON_VAT' = 'VAT'): Promise<Shop> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const taxes = (await http().get('/v1/tax-categories').set(auth).expect(200)).body.data as { id: string; code: string }[];
  const uoms = (await http().get('/v1/uoms').set(auth).expect(200)).body.data as { id: string; code: string }[];
  return {
    t,
    auth,
    entityId: le.body.id,
    branchId: br.body.id,
    tax: Object.fromEntries(taxes.map((x) => [x.code, x.id])),
    pc: uoms.find((u) => u.code === 'PC')!.id,
    kg: uoms.find((u) => u.code === 'KG')!.id,
  };
}

async function item(s: Shop, opts: { price?: string; tax?: string; soldBy?: 'UNIT' | 'WEIGHT' } = {}): Promise<string> {
  const res = await http()
    .post('/v1/products')
    .set(s.auth)
    .send({
      name: uniq('Item'),
      taxCategoryId: s.tax[opts.tax ?? 'VAT'],
      uomId: opts.soldBy === 'WEIGHT' ? s.kg : s.pc,
      soldBy: opts.soldBy ?? 'UNIT',
      variants: [{ sku: uniq('SKU'), ...(opts.price === undefined ? { price: '1120.00' } : opts.price === 'none' ? {} : { price: opts.price }) }],
    })
    .expect(201);
  return res.body.variants[0].id;
}

const quote = (s: Shop, lines: unknown[], auth = s.auth) => http().post('/v1/tax/quote').set(auth).send({ branchId: s.branchId, lines });

describe('tax profiles', () => {
  it('a new legal entity starts with a tax profile in force, shown on the entity', async () => {
    const s = await shop('tp-new');
    const list = (await http().get(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ vatStatus: 'VAT', vatRate: '0.12', percentageTaxRate: '0', roundingMode: 'HALF_UP', state: 'IN_FORCE' });
    const entity = (await http().get('/v1/legal-entities').set(s.auth).expect(200)).body.data[0];
    expect(entity).toMatchObject({ vatStatus: 'VAT', roundingMode: 'HALF_UP', taxProfile: { id: list[0].id }, scheduledTaxProfile: null });
  });

  it('non-VAT entities get a zero VAT rate and the configured percentage tax rate', async () => {
    const s = await shop('tp-nv', 'NON_VAT');
    const [p] = (await http().get(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).expect(200)).body.data;
    expect(p).toMatchObject({ vatStatus: 'NON_VAT', vatRate: '0', percentageTaxRate: '0.03' });
  });

  it('VAT status cannot be edited in place — only versioned through tax profiles', async () => {
    const s = await shop('tp-patch');
    const res = await http().patch(`/v1/legal-entities/${s.entityId}`).set(s.auth).send({ vatStatus: 'NON_VAT' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a registration change supersedes the old profile from now on and is audited', async () => {
    const s = await shop('tp-change');
    const created = await http().post(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).send({ vatStatus: 'NON_VAT', note: 'Deregistered from VAT' }).expect(201);
    expect(created.body).toMatchObject({ vatStatus: 'NON_VAT', vatRate: '0', percentageTaxRate: '0.03' });
    const list = (await http().get(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).expect(200)).body.data;
    expect(list.map((p: { state: string }) => p.state)).toEqual(['IN_FORCE', 'SUPERSEDED']);
    expect((await http().get('/v1/legal-entities').set(s.auth).expect(200)).body.data[0].vatStatus).toBe('NON_VAT');
    const audit = await asOwnerInTenant(owner, s.t.tenantId, (c) =>
      c.query(`SELECT metadata FROM audit_logs WHERE action = 'tax_profile.created' AND resource_id = $1`, [s.entityId]),
    );
    expect(audit.rows[0].metadata).toMatchObject({ taxProfileId: created.body.id, vatStatus: 'NON_VAT' });
  });

  it('future profiles are scheduled and do not affect today', async () => {
    const s = await shop('tp-sched');
    const effectiveFrom = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await http().post(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).send({ vatStatus: 'NON_VAT', effectiveFrom }).expect(201);
    const entity = (await http().get('/v1/legal-entities').set(s.auth).expect(200)).body.data[0];
    expect(entity).toMatchObject({ vatStatus: 'VAT', scheduledTaxProfile: { vatStatus: 'NON_VAT', effectiveFrom } });
    const v = await item(s);
    expect((await quote(s, [{ variantId: v, quantity: '1' }]).expect(200)).body.totals.vatAmount).toBe('120.00');
    const dup = await http().post(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).send({ vatStatus: 'VAT', effectiveFrom }).expect(409);
    expect(dup.body.error.code).toBe('TAX_PROFILE_EXISTS');
  });

  it('cannot be backdated, through the API or directly in the database', async () => {
    const s = await shop('tp-back');
    const res = await http()
      .post(`/v1/legal-entities/${s.entityId}/tax-profiles`)
      .set(s.auth)
      .send({ vatStatus: 'NON_VAT', effectiveFrom: '2026-01-01T00:00:00+08:00' })
      .expect(422);
    expect(res.body.error.code).toBe('TAX_PROFILE_BACKDATED');
    const direct = await asOwnerInTenant(owner, s.t.tenantId, (c) =>
      c.query(
        `INSERT INTO tax_profiles (tenant_id, legal_entity_id, effective_from, vat_status, vat_rate, percentage_tax_rate)
         VALUES ($1, $2, now() - interval '1 day', 'NON_VAT', 0, 0.03)`,
        [s.t.tenantId, s.entityId],
      ),
    ).then(() => null, (e: { constraint?: string }) => e.constraint);
    expect(direct).toBe('tax_profiles_not_backdated');
  });

  it('history is append-only, even for the schema owner', async () => {
    const s = await shop('tp-immut');
    for (const sql of ['UPDATE tax_profiles SET vat_rate = 0.10', 'DELETE FROM tax_profiles']) {
      const err = await asOwnerInTenant(owner, s.t.tenantId, (c) => c.query(sql)).then(() => null, (e: Error) => e.message);
      expect(err).toMatch(/append-only|not allowed|forbidden/i);
    }
  });

  it('rejects inconsistent rates', async () => {
    const s = await shop('tp-rates');
    const url = `/v1/legal-entities/${s.entityId}/tax-profiles`;
    await http().post(url).set(s.auth).send({ vatStatus: 'NON_VAT', vatRate: '0.12' }).expect(400);
    await http().post(url).set(s.auth).send({ vatStatus: 'VAT', vatRate: '0' }).expect(400);
    await http().post(url).set(s.auth).send({ vatStatus: 'VAT', percentageTaxRate: '0.03' }).expect(400);
    await http().post(url).set(s.auth).send({ vatStatus: 'VAT', vatRate: '12' }).expect(400);
  });

  it('cashiers can read nothing they should not and cannot change tax profiles', async () => {
    const s = await shop('tp-perm');
    const cashier = await addMember(owner, s.t.tenantId, 'cashier');
    const token = bearer(await loginToken(app, cashier.email));
    await http().post(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(token).send({ vatStatus: 'NON_VAT' }).expect(403);
  });
});

describe('statutory discount schemes', () => {
  it('lists SC and PWD as platform data pending professional review', async () => {
    const s = await shop('ds-list');
    const data = (await http().get('/v1/discount-schemes').set(s.auth).expect(200)).body.data;
    expect(data.map((d: { code: string }) => d.code)).toEqual(['PWD', 'SC']);
    for (const d of data) expect(d).toMatchObject({ rate: '0.2', vatExempt: true, base: 'VAT_EXCLUSIVE', reviewStatus: 'PENDING_PROFESSIONAL_REVIEW' });
  });
});

describe('POST /v1/tax/quote', () => {
  it('computes the golden vectors from real catalog, price and profile data', async () => {
    const vat = await shop('q-vat');
    const v = await item(vat);
    const plain = (await quote(vat, [{ variantId: v, quantity: '1' }]).expect(200)).body;
    expect(plain.totals).toMatchObject({ vatableSales: '1000.00', vatAmount: '120.00', amountDue: '1120.00' });
    expect(plain.requiresProfessionalReview).toBe(false);
    const sc = (await quote(vat, [{ variantId: v, quantity: '1', statutory: { scheme: 'SC' } }]).expect(200)).body;
    expect(sc.totals).toMatchObject({ vatExemptSales: '1000.00', vatExemptionAmount: '120.00', statutoryDiscount: '200.00', amountDue: '800.00' });
    expect(sc.requiresProfessionalReview).toBe(true);
    expect(sc.lines[0].snapshot).toMatchObject({ profileId: sc.taxProfile.id, vatRate: '0.12', scheme: { code: 'SC', version: 1 } });

    const nonVat = await shop('q-nv', 'NON_VAT');
    const w = await item(nonVat);
    const pwd = (await quote(nonVat, [{ variantId: w, quantity: '1', statutory: { scheme: 'pwd' } }]).expect(200)).body;
    expect(pwd.totals).toMatchObject({ percentageTaxSales: '1120.00', statutoryDiscount: '224.00', vatAmount: '0.00', amountDue: '896.00' });
  });

  it('uses each item’s tax category and the branch price list in force', async () => {
    const s = await shop('q-mixed');
    const rice = await item(s, { price: '50.00', tax: 'VAT_EXEMPT' });
    const exportItem = await item(s, { price: '80.00', tax: 'ZERO_RATED' });
    const soda = await item(s, { price: '22.40' });
    const res = (await quote(s, [
      { variantId: rice, quantity: '1' },
      { variantId: exportItem, quantity: '1' },
      { id: 'soda', variantId: soda, quantity: '2' },
    ]).expect(200)).body;
    expect(res.lines.find((l: { id: string }) => l.id === 'soda')).toMatchObject({ unitPrice: '22.4', vatableSales: '40.00', vatAmount: '4.80' });
    expect(res.totals).toMatchObject({ vatExemptSales: '50.00', zeroRatedSales: '80.00', vatableSales: '40.00', vatAmount: '4.80', amountDue: '174.80' });

    // A branch with its own list is priced from that list only (no silent fallback to the default).
    const mall = await http().post('/v1/price-lists').set(s.auth).send({ name: 'Mall' }).expect(201);
    await http().post(`/v1/price-lists/${mall.body.id}/prices`).set(s.auth).send({ items: [{ variantId: soda, amount: '33.60' }] }).expect(201);
    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: mall.body.id }).expect(200);
    const atMall = (await quote(s, [{ variantId: soda, quantity: '2' }]).expect(200)).body;
    expect(atMall.lines[0]).toMatchObject({ unitPrice: '33.6', priceListId: mall.body.id, vatableSales: '60.00', vatAmount: '7.20' });
    expect((await quote(s, [{ variantId: rice, quantity: '1' }]).expect(409)).body.error.code).toBe('ITEM_NOT_PRICED');
  });

  it('follows a registration change immediately', async () => {
    const s = await shop('q-switch');
    const v = await item(s);
    await http().post(`/v1/legal-entities/${s.entityId}/tax-profiles`).set(s.auth).send({ vatStatus: 'NON_VAT' }).expect(201);
    const res = (await quote(s, [{ variantId: v, quantity: '1' }]).expect(200)).body;
    expect(res.taxProfile.vatStatus).toBe('NON_VAT');
    expect(res.totals).toMatchObject({ vatAmount: '0.00', percentageTaxSales: '1120.00' });
  });

  it('refuses what it cannot price or tax correctly', async () => {
    const s = await shop('q-refuse');
    const v = await item(s);
    const unpriced = await item(s, { price: 'none' });
    const cases: [unknown[], number, string][] = [
      [[{ variantId: unpriced, quantity: '1' }], 409, 'ITEM_NOT_PRICED'],
      [[{ variantId: v, quantity: '1.5' }], 422, 'QUANTITY_NOT_ALLOWED'],
      [[{ variantId: v, quantity: '1', discount: '1.00', statutory: { scheme: 'SC' } }], 422, 'DISCOUNT_STACKING_NOT_ALLOWED'],
      [[{ variantId: v, quantity: '1', discount: '2000.00' }], 422, 'DISCOUNT_EXCEEDS_LINE'],
      [[{ variantId: v, quantity: '1', statutory: { scheme: 'NAAC' } }], 422, 'UNKNOWN_SCHEME'],
      [[{ variantId: '01900000-0000-7000-8000-000000000000', quantity: '1' }], 404, 'NOT_FOUND'],
      [[{ variantId: v, quantity: '0' }], 400, 'VALIDATION_FAILED'],
      [[{ variantId: v, quantity: 1 }], 400, 'VALIDATION_FAILED'],
    ];
    for (const [lines, status, code] of cases) {
      const res = await quote(s, lines);
      expect([res.status, res.body.error?.code]).toEqual([status, code]);
    }
  });

  it('weighed items accept fractional quantities', async () => {
    const s = await shop('q-weight');
    const meat = await item(s, { price: '280.00', soldBy: 'WEIGHT' });
    const res = (await quote(s, [{ variantId: meat, quantity: '0.3755' }]).expect(200)).body;
    expect(res.lines[0]).toMatchObject({ gross: '105.14', amountDue: '105.14' });
  });

  it('cashiers can quote (incl. statutory discounts) but not apply ordinary discounts', async () => {
    const s = await shop('q-cashier');
    const v = await item(s);
    const cashier = await addMember(owner, s.t.tenantId, 'cashier');
    const token = bearer(await loginToken(app, cashier.email));
    await quote(s, [{ variantId: v, quantity: '1', statutory: { scheme: 'SC' } }], token).expect(200);
    const res = await quote(s, [{ variantId: v, quantity: '1', discount: '10.00' }], token).expect(403);
    expect(res.body.error.details.missing).toEqual(['sales.discount']);
  });

  it('a cashier scoped to one branch cannot quote at another', async () => {
    const s = await shop('q-scope');
    const v = await item(s);
    const other = await http().post('/v1/branches').set(s.auth).send({ legalEntityId: s.entityId, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201);
    const cashier = await addMember(owner, s.t.tenantId, 'cashier', { type: 'BRANCH', id: s.branchId });
    const token = bearer(await loginToken(app, cashier.email));
    await quote(s, [{ variantId: v, quantity: '1' }], token).expect(200);
    await http().post('/v1/tax/quote').set(token).send({ branchId: other.body.id, lines: [{ variantId: v, quantity: '1' }] }).expect(403);
  });
});
