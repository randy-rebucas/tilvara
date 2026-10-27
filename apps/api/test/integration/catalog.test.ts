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
  branchId: string;
  branch2Id: string;
  uom: Record<string, string>;
  tax: Record<string, string>;
  defaultListId: string;
}

async function shop(prefix: string): Promise<Shop> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Inc`, vatStatus: 'VAT' }).expect(201);
  const b1 = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const b2 = await http()
    .post('/v1/branches')
    .set(auth)
    .send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' })
    .expect(201);
  const uoms = (await http().get('/v1/uoms').set(auth).expect(200)).body.data as { id: string; code: string }[];
  const taxes = (await http().get('/v1/tax-categories').set(auth).expect(200)).body.data as { id: string; code: string }[];
  const lists = (await http().get('/v1/price-lists').set(auth).expect(200)).body.data as { id: string; isDefault: boolean }[];
  return {
    t,
    auth,
    branchId: b1.body.id,
    branch2Id: b2.body.id,
    uom: Object.fromEntries(uoms.map((u) => [u.code, u.id])),
    tax: Object.fromEntries(taxes.map((x) => [x.code, x.id])),
    defaultListId: lists.find((l) => l.isDefault)!.id,
  };
}

function product(s: Shop, overrides: Record<string, unknown> = {}) {
  const sku = uniq('SKU');
  return {
    name: 'Coke Mismo 290ml',
    taxCategoryId: s.tax.VAT,
    uomId: s.uom.PC,
    variants: [{ sku, barcodes: [`480${Math.floor(Math.random() * 1e10)}`], price: '20.00' }],
    ...overrides,
  };
}

describe('tenant catalog defaults', () => {
  it('seeds units, tax categories and a default tax-inclusive price list at signup', async () => {
    const s = await shop('defaults');
    expect(Object.keys(s.uom).sort()).toEqual(['G', 'KG', 'L', 'ML', 'PC']);
    expect(Object.keys(s.tax).sort()).toEqual(['VAT', 'VAT_EXEMPT', 'ZERO_RATED']);
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data;
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ name: 'Standard', isDefault: true, pricesIncludeTax: true, currency: 'PHP' });
  });

  it('a unit code with an underscore is a 400, matching the DB check (audit 2026-10-21)', async () => {
    const s = await shop('uom-code');
    const bad = await http().post('/v1/uoms').set(s.auth).send({ code: 'BOX_6', name: 'Box of 6' });
    expect(bad.status).toBe(400);
    await http().post('/v1/uoms').set(s.auth).send({ code: 'box6', name: 'Box of 6' }).expect(201);
  });
});

describe('products', () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop('products');
  });

  it('creates a product with variants, barcodes and prices, then finds it by name, SKU and barcode', async () => {
    const created = await http()
      .post('/v1/products')
      .set(s.auth)
      .send({
        name: 'Lucky Me Pancit Canton',
        taxCategoryId: s.tax.VAT,
        uomId: s.uom.PC,
        variants: [
          { sku: 'LM-PC-CHILI', name: 'Chilimansi', attributes: { flavor: 'chilimansi' }, barcodes: ['4807770270017'], price: '16.50', referenceCost: '12.10' },
          { sku: 'LM-PC-ORIG', name: 'Original', barcodes: ['4807770270024'], price: '16.50' },
        ],
      })
      .expect(201);
    expect(created.body.variants).toHaveLength(2);
    expect(created.body.trackInventory).toBe(true);
    expect(created.body.variants[0].barcodes).toEqual(['4807770270017']);
    expect(created.body.variants[0].referenceCost).toBe('12.1000');

    for (const q of ['pancit', 'lm-pc-orig', '4807770270017']) {
      const res = await http().get('/v1/products').query({ q }).set(s.auth).expect(200);
      expect(res.body.data.map((p: { id: string }) => p.id)).toContain(created.body.id);
    }
    // LIKE wildcards in the query are literals, not patterns.
    const wild = await http().get('/v1/products').query({ q: '%' }).set(s.auth).expect(200);
    expect(wild.body.data).toEqual([]);
  });

  it('names variants by id for document lines, archived ones included', async () => {
    const p = await shop('lookup');
    const one = (await http().post('/v1/products').set(p.auth).send(product(p, { name: 'Tide Bar' })).expect(201)).body;
    const two = (await http().post('/v1/products').set(p.auth).send({ ...product(p, { name: 'Pancit' }), variants: [{ sku: uniq('PC'), name: 'Chili', price: '16.50' }] }).expect(201)).body;
    await http().post(`/v1/products/${one.id}/archive`).set(p.auth).expect(200);
    const v1 = one.variants[0].id as string;
    const v2 = two.variants[0].id as string;
    const res = (await http().get('/v1/variants').query({ ids: `${v1},${v2},${v1}` }).set(p.auth).expect(200)).body.data;
    expect(res).toHaveLength(2);
    expect(res.find((v: { id: string }) => v.id === v1)).toMatchObject({ name: 'Tide Bar', productId: one.id, sku: one.variants[0].sku });
    expect(res.find((v: { id: string }) => v.id === v1).archivedAt).toBeTruthy();
    expect(res.find((v: { id: string }) => v.id === v2)).toMatchObject({ name: 'Pancit — Chili', archivedAt: null });
    await http().get('/v1/variants').query({ ids: 'not-an-id' }).set(p.auth).expect(400);
    await http().get('/v1/variants').set(p.auth).expect(400);
  });

  it('paginates with a cursor', async () => {
    const p = await shop('paging');
    for (let i = 0; i < 3; i++) await http().post('/v1/products').set(p.auth).send(product(p, { name: `Item ${i}` })).expect(201);
    const page1 = await http().get('/v1/products').query({ limit: 2 }).set(p.auth).expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await http().get('/v1/products').query({ limit: 2, cursor: page1.body.nextCursor }).set(p.auth).expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('enforces SKU (case-insensitive) and barcode uniqueness among active items, and frees them on archive', async () => {
    const body = product(s);
    const first = await http().post('/v1/products').set(s.auth).send(body).expect(201);
    const dupSku = await http()
      .post('/v1/products')
      .set(s.auth)
      .send({ ...body, variants: [{ sku: body.variants[0]!.sku.toLowerCase(), barcodes: [] }] })
      .expect(409);
    expect(dupSku.body.error.code).toBe('SKU_TAKEN');
    const dupCode = await http()
      .post('/v1/products')
      .set(s.auth)
      .send({ ...body, variants: [{ sku: uniq('OTHER'), barcodes: body.variants[0]!.barcodes }] })
      .expect(409);
    expect(dupCode.body.error.code).toBe('BARCODE_TAKEN');

    await http().post(`/v1/products/${first.body.id}/archive`).set(s.auth).expect(200);
    await http().post('/v1/products').set(s.auth).send(body).expect(201);
  });

  it('applies product rules: weighted needs a fractional unit, services cannot track stock, last variant stays', async () => {
    const weighted = await http().post('/v1/products').set(s.auth).send(product(s, { name: 'Rice', soldBy: 'WEIGHT' })).expect(422);
    expect(weighted.body.error.code).toBe('UOM_NOT_FRACTIONAL');
    await http().post('/v1/products').set(s.auth).send(product(s, { name: 'Rice', soldBy: 'WEIGHT', uomId: s.uom.KG })).expect(201);
    await http().post('/v1/products').set(s.auth).send(product(s, { name: 'Delivery fee', productType: 'SERVICE', trackInventory: true })).expect(400);
    const svc = await http().post('/v1/products').set(s.auth).send(product(s, { name: 'Gift wrap', productType: 'SERVICE' })).expect(201);
    expect(svc.body.trackInventory).toBe(false);

    const last = await http().post(`/v1/variants/${svc.body.variants[0].id}/archive`).set(s.auth).expect(409);
    expect(last.body.error.code).toBe('LAST_VARIANT');
  });

  it('rejects numeric or over-precise money values', async () => {
    await http().post('/v1/products').set(s.auth).send(product(s, { variants: [{ sku: uniq('N'), price: 20 }] })).expect(400);
    await http().post('/v1/products').set(s.auth).send(product(s, { variants: [{ sku: uniq('N'), price: '20.12345' }] })).expect(400);
    await http().post('/v1/products').set(s.auth).send(product(s, { variants: [{ sku: uniq('N'), price: '-1.00' }] })).expect(400);
  });

  it('keeps the category tree acyclic and refuses to archive non-empty categories', async () => {
    const root = await http().post('/v1/categories').set(s.auth).send({ name: 'Beverages' }).expect(201);
    const child = await http().post('/v1/categories').set(s.auth).send({ name: 'Softdrinks', parentId: root.body.id }).expect(201);
    const cycle = await http().patch(`/v1/categories/${root.body.id}`).set(s.auth).send({ parentId: child.body.id }).expect(422);
    expect(cycle.body.error.code).toBe('INVALID_STATE');
    await http().post('/v1/products').set(s.auth).send(product(s, { categoryId: child.body.id })).expect(201);
    // The refusal names only what is in the way.
    const withProducts = (await http().post(`/v1/categories/${child.body.id}/archive`).set(s.auth).expect(409)).body.error;
    expect(withProducts).toMatchObject({ code: 'HAS_ACTIVE_CHILDREN', message: 'Move or archive its products first' });
    const withChild = (await http().post(`/v1/categories/${root.body.id}/archive`).set(s.auth).expect(409)).body.error;
    expect(withChild).toMatchObject({ code: 'HAS_ACTIVE_CHILDREN', message: 'Move or archive its sub-categories first' });
  });
});

describe('pricing & POS lookup', () => {
  let s: Shop;
  let variantId: string;
  let barcode: string;
  let sku: string;

  beforeAll(async () => {
    s = await shop('pricing');
    const body = product(s);
    const p = await http().post('/v1/products').set(s.auth).send(body).expect(201);
    variantId = p.body.variants[0].id;
    barcode = body.variants[0]!.barcodes[0]!;
    sku = body.variants[0]!.sku;
  });

  it('looks up by barcode or SKU with the branch price in force', async () => {
    const byCode = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(s.auth).expect(200);
    expect(byCode.body).toMatchObject({
      variantId,
      soldBy: 'UNIT',
      tax: { vatTreatment: 'VATABLE' },
      price: { amount: '20.0000', currency: 'PHP', pricesIncludeTax: true, priceListId: s.defaultListId },
    });
    const bySku = await http().get('/v1/catalog/lookup').query({ code: sku.toLowerCase(), branchId: s.branchId }).set(s.auth).expect(200);
    expect(bySku.body.variantId).toBe(variantId);
    await http().get('/v1/catalog/lookup').query({ code: 'NOPE', branchId: s.branchId }).set(s.auth).expect(404);
  });

  it('returns price null for an unpriced item instead of zero', async () => {
    const body = product(s, { variants: [{ sku: uniq('NOPRICE'), barcodes: [] }] });
    const p = await http().post('/v1/products').set(s.auth).send(body).expect(201);
    const res = await http().get('/v1/catalog/lookup').query({ code: p.body.variants[0].sku, branchId: s.branchId }).set(s.auth).expect(200);
    expect(res.body.price).toBeNull();
  });

  it('uses a branch-specific price list when assigned, the default otherwise', async () => {
    const mall = await http().post('/v1/price-lists').set(s.auth).send({ name: 'Mall pricing' }).expect(201);
    await http().post(`/v1/price-lists/${mall.body.id}/prices`).set(s.auth).send({ items: [{ variantId, amount: '25.00' }] }).expect(201);
    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: mall.body.id }).expect(200);
    // The list says which branches use it (the admin shows "Used at").
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data as { id: string; isDefault: boolean; branchIds: string[] }[];
    expect(lists.find((l) => l.id === mall.body.id)!.branchIds).toEqual([s.branchId]);
    expect(lists.find((l) => l.isDefault)!.branchIds).toEqual([]);

    const inMall = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(s.auth).expect(200);
    expect(inMall.body.price.amount).toBe('25.0000');
    const elsewhere = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branch2Id }).set(s.auth).expect(200);
    expect(elsewhere.body.price.amount).toBe('20.0000');

    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: null }).expect(200);
    const back = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(s.auth).expect(200);
    expect(back.body.price.amount).toBe('20.0000');
  });

  it('schedules future prices without changing the current one, and refuses backdating', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await http().post(`/v1/price-lists/${s.defaultListId}/prices`).set(s.auth).send({ items: [{ variantId, amount: '22.00', effectiveFrom: future }] }).expect(201);
    const now = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branch2Id }).set(s.auth).expect(200);
    expect(now.body.price.amount).toBe('20.0000');
    const list = await http().get(`/v1/price-lists/${s.defaultListId}/prices`).set(s.auth).expect(200);
    const row = list.body.data.find((r: { variantId: string }) => r.variantId === variantId);
    expect(row.amount).toBe('20.0000');
    expect(row.scheduled.amount).toBe('22.0000');

    const past = new Date(Date.now() - 86_400_000).toISOString();
    const res = await http().post(`/v1/price-lists/${s.defaultListId}/prices`).set(s.auth).send({ items: [{ variantId, amount: '1.00', effectiveFrom: past }] }).expect(422);
    expect(res.body.error.code).toBe('BACKDATED_PRICE');
  });

  it('keeps price history append-only at the database level', async () => {
    const history = await http().get(`/v1/variants/${variantId}/price-history`).set(s.auth).expect(200);
    expect(history.body.data.length).toBeGreaterThanOrEqual(2);
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(appPool.query(`UPDATE product_prices SET amount = 0`)).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
    await expect(
      asOwnerInTenant(owner, s.t.tenantId, (c) => c.query('UPDATE product_prices SET amount = 0 WHERE variant_id = $1', [variantId])),
    ).rejects.toThrow(/append-only/);
  });

  it('switching the default price list leaves exactly one default', async () => {
    const promo = await http().post('/v1/price-lists').set(s.auth).send({ name: 'Promo', isDefault: true }).expect(201);
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data;
    expect(lists.filter((l: { isDefault: boolean }) => l.isDefault).map((l: { id: string }) => l.id)).toEqual([promo.body.id]);
    await http().patch(`/v1/price-lists/${s.defaultListId}`).set(s.auth).send({ isDefault: true }).expect(200);
  });

  it('a cashier given access at one branch looks items up there (not at another branch) and browses the catalog', async () => {
    // Session 16: catalog.read held at a branch did not count for the business-wide catalog, so such a
    // cashier could not scan anything at their own till.
    const cashier = await addMember(owner, s.t.tenantId, 'cashier', { type: 'BRANCH', id: s.branchId });
    const token = bearer(await loginToken(app, cashier.email));
    await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(token).expect(200);
    await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branch2Id }).set(token).expect(403);
    await http().get('/v1/products').set(token).expect(200);
    await http().get('/v1/categories').set(token).expect(200);
    await http().post('/v1/products').set(token).send(product(s)).expect(403);
  });

  it('archives a price list no open branch uses; never the default or one in use; an archived list takes no prices', async () => {
    const def = await http().post(`/v1/price-lists/${s.defaultListId}/archive`).set(s.auth);
    expect([def.status, def.body.error?.code]).toEqual([409, 'PRICE_LIST_DEFAULT']);
    const season = (await http().post('/v1/price-lists').set(s.auth).send({ name: 'Summer sale' }).expect(201)).body as { id: string };
    await http().post(`/v1/price-lists/${season.id}/prices`).set(s.auth).send({ items: [{ variantId, amount: '18.00' }] }).expect(201);
    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: season.id }).expect(200);
    const used = await http().post(`/v1/price-lists/${season.id}/archive`).set(s.auth);
    expect([used.status, used.body.error?.code, used.body.error?.details?.branches]).toEqual([409, 'PRICE_LIST_IN_USE', ['B1']]);
    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: null }).expect(200);
    const archived = await http().post(`/v1/price-lists/${season.id}/archive`).set(s.auth).expect(200);
    expect(archived.body.archivedAt).toBeTruthy();
    // Out of use: no new prices, no branch, and the lookup keeps the default price.
    await http().post(`/v1/price-lists/${season.id}/prices`).set(s.auth).send({ items: [{ variantId, amount: '17.00' }] }).expect(409);
    await http().put(`/v1/branches/${s.branchId}/price-list`).set(s.auth).send({ priceListId: season.id }).expect(409);
    const price = await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(s.auth).expect(200);
    expect(price.body.price.amount).toBe('20.0000');
    await http().post(`/v1/price-lists/${season.id}/archive`).set(s.auth).expect(409);
    const cashier = bearer(await loginToken(app, (await addMember(owner, s.t.tenantId, 'cashier')).email));
    await http().post(`/v1/price-lists/${s.defaultListId}/archive`).set(cashier).expect(403);
  });

  it('cashiers can look up and browse but not edit the catalog or prices', async () => {
    const cashier = await addMember(owner, s.t.tenantId, 'cashier');
    const token = bearer(await loginToken(app, cashier.email));
    await http().get('/v1/catalog/lookup').query({ code: barcode, branchId: s.branchId }).set(token).expect(200);
    await http().get('/v1/products').set(token).expect(200);
    await http().post('/v1/products').set(token).send(product(s)).expect(403);
    await http().post(`/v1/price-lists/${s.defaultListId}/prices`).set(token).send({ items: [{ variantId, amount: '1.00' }] }).expect(403);
  });
});

describe('cross-tenant isolation (catalog)', () => {
  let a: Shop;
  let b: Shop;
  let aProduct: { id: string; variants: { id: string; sku: string; barcodes: string[] }[] };

  beforeAll(async () => {
    a = await shop('cat-a');
    b = await shop('cat-b');
    aProduct = (await http().post('/v1/products').set(a.auth).send(product(a)).expect(201)).body;
  });

  it("cannot read, change, extend or price the other tenant's catalog", async () => {
    const v = aProduct.variants[0]!;
    const attempts = [
      http().get(`/v1/products/${aProduct.id}`).set(b.auth),
      http().patch(`/v1/products/${aProduct.id}`).set(b.auth).send({ name: 'pwned' }),
      http().post(`/v1/products/${aProduct.id}/archive`).set(b.auth),
      http().post(`/v1/products/${aProduct.id}/variants`).set(b.auth).send({ sku: uniq('X') }),
      http().patch(`/v1/variants/${v.id}`).set(b.auth).send({ name: 'pwned' }),
      http().post(`/v1/variants/${v.id}/barcodes`).set(b.auth).send({ code: 'HIJACK1' }),
      http().post(`/v1/price-lists/${b.defaultListId}/prices`).set(b.auth).send({ items: [{ variantId: v.id, amount: '0.01' }] }),
      http().post(`/v1/price-lists/${a.defaultListId}/prices`).set(b.auth).send({ items: [{ variantId: v.id, amount: '0.01' }] }),
      http().put(`/v1/branches/${b.branchId}/price-list`).set(b.auth).send({ priceListId: a.defaultListId }),
      http().get('/v1/catalog/lookup').query({ code: v.barcodes[0], branchId: b.branchId }).set(b.auth),
      http().get('/v1/catalog/lookup').query({ code: v.barcodes[0], branchId: a.branchId }).set(b.auth),
      http().post('/v1/products').set(b.auth).send(product(b, { taxCategoryId: a.tax.VAT })),
      http().post('/v1/products').set(b.auth).send(product(b, { uomId: a.uom.PC })),
    ];
    for (const res of await Promise.all(attempts)) {
      expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    }
    const unchanged = await http().get(`/v1/products/${aProduct.id}`).set(a.auth).expect(200);
    expect(unchanged.body.name).toBe('Coke Mismo 290ml');
    expect(unchanged.body.archivedAt).toBeNull();
  });

  it('lists never include the other tenant, and SKUs/barcodes are unique per tenant only', async () => {
    const list = await http().get('/v1/products').set(b.auth).expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(aProduct.id);
    const v = aProduct.variants[0]!;
    await http()
      .post('/v1/products')
      .set(b.auth)
      .send({ name: 'Same codes, other shop', taxCategoryId: b.tax.VAT, uomId: b.uom.PC, variants: [{ sku: v.sku, barcodes: v.barcodes }] })
      .expect(201);
  });
});
