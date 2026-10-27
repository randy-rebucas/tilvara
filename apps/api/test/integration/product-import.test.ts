import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

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

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const uoms = (await http().get('/v1/uoms').set(auth).expect(200)).body.data as { id: string; code: string }[];
  const taxes = (await http().get('/v1/tax-categories').set(auth).expect(200)).body.data as { id: string; code: string }[];
  const lists = (await http().get('/v1/price-lists').set(auth).expect(200)).body.data as { id: string; isDefault: boolean }[];
  return {
    t,
    auth,
    uom: Object.fromEntries(uoms.map((u) => [u.code, u.id])) as Record<string, string>,
    tax: Object.fromEntries(taxes.map((x) => [x.code, x.id])) as Record<string, string>,
    defaultListId: lists.find((l) => l.isDefault)!.id,
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const names = (body: { data: { name: string }[] }) => body.data.map((p) => p.name).sort();

async function add(s: Shop, name: string, extra: Record<string, unknown> = {}, variants: Record<string, unknown>[] = [{}]) {
  const res = await http()
    .post('/v1/products')
    .set(s.auth)
    .send({ name, taxCategoryId: s.tax.VAT, uomId: s.uom.PC, ...extra, variants: variants.map((v) => ({ sku: uniq('S'), ...v })) })
    .expect(201);
  return res.body as { id: string; variants: { id: string; sku: string }[] };
}

describe('product list filters', () => {
  it('filters by status, category (with sub-categories or none), sold by, tax, stock, expiry, barcode, price and variants', async () => {
    const s = await shop('pfilter');
    const drinks = (await http().post('/v1/categories').set(s.auth).send({ name: 'Drinks' }).expect(201)).body.id as string;
    const hot = (await http().post('/v1/categories').set(s.auth).send({ name: 'Hot drinks', parentId: drinks }).expect(201)).body.id as string;
    await add(s, 'Cola', { categoryId: drinks }, [{ price: '20.00', barcodes: [`480${Date.now()}`] }]);
    await add(s, 'Coffee', { categoryId: hot, tracksExpiry: true }, [{ price: '50.00' }]);
    await add(s, 'Rice', { uomId: s.uom.KG, soldBy: 'WEIGHT', taxCategoryId: s.tax.VAT_EXEMPT }, [{ price: '55.00' }]);
    await add(s, 'Gift wrap', { productType: 'SERVICE', trackInventory: false });
    await add(s, 'Shirt', {}, [{ name: 'S', price: '300.00' }, { name: 'M' }]);
    const gone = await add(s, 'Old item');
    await http().post(`/v1/products/${gone.id}/archive`).set(s.auth).expect(200);

    const list = async (q: string) => names((await http().get(`/v1/products?${q}`).set(s.auth).expect(200)).body);
    expect(await list('')).toEqual(['Coffee', 'Cola', 'Gift wrap', 'Rice', 'Shirt']);
    expect(await list('status=archived')).toEqual(['Old item']);
    expect(await list('status=all')).toHaveLength(6);
    expect(await list('includeArchived=true')).toHaveLength(6);
    expect(await list(`categoryId=${drinks}`)).toEqual(['Cola']);
    expect(await list(`categoryId=${drinks}&withSubcategories=true`)).toEqual(['Coffee', 'Cola']);
    expect(await list('categoryId=none')).toEqual(['Gift wrap', 'Rice', 'Shirt']);
    expect(await list('soldBy=WEIGHT')).toEqual(['Rice']);
    expect(await list(`taxCategoryId=${s.tax.VAT_EXEMPT}`)).toEqual(['Rice']);
    expect(await list('trackInventory=false')).toEqual(['Gift wrap']);
    expect(await list('tracksExpiry=true')).toEqual(['Coffee']);
    expect(await list('hasBarcode=true')).toEqual(['Cola']);
    // Gift wrap has no price at all; Shirt's M has none: the till could not sell them.
    expect(await list('hasPrice=false')).toEqual(['Gift wrap', 'Shirt']);
    expect(await list('hasPrice=true')).toEqual(['Coffee', 'Cola', 'Rice']);
    expect(await list('hasVariants=true')).toEqual(['Shirt']);
    expect(await list('productType=SERVICE&trackInventory=false')).toEqual(['Gift wrap']);
  });

  it('sorts by name or newest and pages through with the cursor of the same sort', async () => {
    const s = await shop('psort');
    for (const n of ['banana', 'Apple', 'cherry', 'Date', 'egg']) await add(s, n);
    const page = async (q: string) => (await http().get(`/v1/products?${q}`).set(s.auth).expect(200)).body as { data: { name: string }[]; nextCursor: string | null };
    const p1 = await page('sort=name&limit=2');
    expect(p1.data.map((p) => p.name)).toEqual(['Apple', 'banana']);
    const p2 = await page(`sort=name&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.data.map((p) => p.name)).toEqual(['cherry', 'Date']);
    const p3 = await page(`sort=name&limit=2&cursor=${p2.nextCursor}`);
    expect([p3.data.map((p) => p.name), p3.nextCursor]).toEqual([['egg'], null]);
    const n1 = await page('sort=newest&limit=3');
    expect(n1.data.map((p) => p.name)).toEqual(['egg', 'Date', 'cherry']);
    expect((await page(`sort=newest&limit=3&cursor=${n1.nextCursor}`)).data.map((p) => p.name)).toEqual(['Apple', 'banana']);
    // A name cursor is not an id: refused, not misread.
    const bad = await http().get(`/v1/products?cursor=${p1.nextCursor}`).set(s.auth);
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('product import', () => {
  const row = (line: number, fields: Record<string, unknown>) => ({ line, ...fields });

  it('previews without writing, then makes products, variants, categories, barcodes and prices in one go', async () => {
    const s = await shop('pimport');
    const cola = await add(s, 'Cola', {}, [{ price: '20.00' }]);
    const colaSku = cola.variants[0]!.sku;
    const code = `489${Date.now()}`;
    const rows = [
      row(2, { name: 'Cola', sku: colaSku, price: '22.00', category: 'Drinks › Soft drinks', barcodes: [code] }),
      row(3, { name: 'Cola', sku: uniq('COLA-L'), variantName: '1.5 L', price: '65.00' }),
      row(4, { name: 'Shirt', sku: uniq('SH-S'), variantName: 'S', attributes: { Size: 'S' }, price: '300.00', category: 'Clothes' }),
      row(5, { name: 'Shirt', sku: uniq('SH-M'), variantName: 'M', attributes: { Size: 'M' }, price: '300.00', referenceCost: '120.5' }),
      row(6, { name: 'Rice', sku: uniq('RICE'), unit: 'kg', soldBy: 'WEIGHT', tax: 'vat_exempt', price: '55.00', tracksExpiry: true }),
      row(7, { name: 'Gift wrap', sku: uniq('WRAP'), productType: 'SERVICE', trackInventory: false, price: '15.00' }),
    ];
    const preview = await http().post('/v1/products/import/preview').set(s.auth).send({ rows }).expect(200);
    expect(preview.body.summary).toEqual({ products: 3, variants: 2, updated: 1, unchanged: 0, errors: 0 });
    expect(preview.body.rows.map((r: { action: string }) => r.action)).toEqual(['UPDATE', 'ADD_VARIANT', 'CREATE', 'ADD_VARIANT', 'CREATE', 'CREATE']);
    expect(preview.body.rows[0].changes).toEqual(['category', 'price', 'barcodes']);
    expect(preview.body.newCategories.sort()).toEqual(['Clothes', 'Drinks › Soft drinks']);
    // Nothing written by the preview.
    expect((await http().get('/v1/products').set(s.auth).expect(200)).body.data).toHaveLength(1);

    const key = randomUUID();
    const done = await http().post('/v1/products/import').set(s.auth).set('Idempotency-Key', key).send({ rows }).expect(201);
    expect(done.body.summary).toEqual(preview.body.summary);
    // A retry with the same key gets the same answer and makes nothing twice.
    const replay = await http().post('/v1/products/import').set(s.auth).set('Idempotency-Key', key).send({ rows }).expect(201);
    expect(replay.body).toEqual(done.body);
    const all = (await http().get('/v1/products?sort=name').set(s.auth).expect(200)).body.data as { id: string; name: string; categoryId: string | null; soldBy: string; productType: string; trackInventory: boolean; tracksExpiry: boolean; variants: { sku: string; name: string | null; barcodes: string[]; attributes: Record<string, string> }[] }[];
    expect(all.map((p) => p.name)).toEqual(['Cola', 'Gift wrap', 'Rice', 'Shirt']);
    const byName = Object.fromEntries(all.map((p) => [p.name, p]));
    expect(byName.Cola!.variants.map((v) => v.name)).toEqual([null, '1.5 L']);
    expect(byName.Cola!.variants[0]!.barcodes).toEqual([code]);
    expect(byName.Shirt!.variants.map((v) => v.attributes)).toEqual([{ Size: 'S' }, { Size: 'M' }]);
    expect(byName.Rice).toMatchObject({ soldBy: 'WEIGHT', tracksExpiry: true, trackInventory: true });
    expect(byName['Gift wrap']).toMatchObject({ productType: 'SERVICE', trackInventory: false });
    const cats = (await http().get('/v1/categories').set(s.auth).expect(200)).body.data as { id: string; name: string; parentId: string | null }[];
    const drinks = cats.find((c) => c.name === 'Drinks')!;
    const soft = cats.find((c) => c.name === 'Soft drinks')!;
    expect([drinks.parentId, soft.parentId, byName.Cola!.categoryId]).toEqual([null, drinks.id, soft.id]);
    const prices = (await http().get(`/v1/price-lists/${s.defaultListId}/prices`).set(s.auth).expect(200)).body.data as { sku: string; amount: string }[];
    expect(prices.find((p) => p.sku === colaSku)!.amount).toBe('22.0000');
    expect(prices).toHaveLength(6);

    // The same file again changes nothing; the category is found by its path or its own name.
    const again = await http().post('/v1/products/import/preview').set(s.auth).send({ rows: rows.map((r) => (r.line === 2 ? { ...r, category: 'soft drinks' } : r)) }).expect(200);
    expect(again.body.summary).toEqual({ products: 0, variants: 0, updated: 0, unchanged: 6, errors: 0 });

    // A new SKU joins "Shirt" written in another case without renaming it; a row found by its SKU renames.
    const join = await http().post('/v1/products/import/preview').set(s.auth).send({ rows: [row(2, { name: 'SHIRT', sku: uniq('SH-L'), variantName: 'L' })] }).expect(200);
    expect([join.body.rows[0].action, join.body.rows[0].changes]).toEqual(['ADD_VARIANT', []]);
    const rename = await http().post('/v1/products/import/preview').set(s.auth).send({ rows: [row(2, { name: 'COLA', sku: colaSku })] }).expect(200);
    expect([rename.body.rows[0].action, rename.body.rows[0].changes]).toEqual(['UPDATE', ['name']]);

    // Audited as imported.
    const audit = await asOwnerInTenant(owner, s.t.tenantId, (c) =>
      c.query<{ action: string; n: number }>(`SELECT action, count(*)::int AS n FROM audit_logs WHERE metadata->>'imported' = 'true' GROUP BY action ORDER BY action`),
    );
    expect(audit.rows).toEqual([
      { action: 'barcode.added', n: 1 },
      { action: 'category.created', n: 3 },
      { action: 'prices.set', n: 1 },
      { action: 'product.created', n: 3 },
      { action: 'product.updated', n: 1 },
      { action: 'variant.created', n: 1 },
    ]);
  });

  it('refuses the whole file when one row is wrong, naming each row and why', async () => {
    const s = await shop('pimport-bad');
    const cola = await add(s, 'Cola', {}, [{ barcodes: ['4800000000017'] }]);
    await add(s, 'Twin');
    await add(s, 'Twin');
    const kg = await add(s, 'Sugar', { uomId: s.uom.KG, soldBy: 'WEIGHT' });
    const sku = uniq('NEW');
    const rows = [
      row(2, { name: 'Fine', sku: uniq('OK'), price: '10.00' }),
      row(3, { name: 'Dup', sku }),
      row(4, { name: 'Dup', sku: sku.toLowerCase() }),
      row(5, { name: 'Other', sku: uniq('BC'), barcodes: ['4800000000017'] }),
      row(6, { name: 'Bad unit', sku: uniq('U'), unit: 'CRATE' }),
      row(7, { name: 'Bad tax', sku: uniq('T'), tax: 'Luxury' }),
      row(8, { name: 'Twin', sku: uniq('TW') }),
      row(9, { name: 'Sugar', sku: kg.variants[0]!.sku, unit: 'PC' }),
      row(10, { name: 'Wrap', sku: uniq('W'), productType: 'SERVICE', trackInventory: true }),
      row(11, { name: 'Milk', sku: uniq('M1'), trackInventory: false, tracksExpiry: true }),
      row(12, { name: 'Shirt', sku: uniq('S1'), category: 'Clothes' }),
      row(13, { name: 'Shirt', sku: uniq('S2'), category: 'Shoes' }),
      row(14, { name: 'Loose', sku: uniq('L'), soldBy: 'WEIGHT' }),
    ];
    const res = await http().post('/v1/products/import').set(s.auth).send({ rows });
    expect([res.status, res.body.error.code]).toEqual([422, 'IMPORT_INVALID']);
    const errors = Object.fromEntries((res.body.error.details.rows as { line: number; errors: { code: string }[] }[]).map((r) => [r.line, r.errors.map((e) => e.code)]));
    expect(errors).toEqual({
      4: ['DUPLICATE_SKU'],
      5: ['BARCODE_TAKEN'],
      6: ['UNKNOWN_UNIT'],
      7: ['UNKNOWN_TAX'],
      8: ['AMBIGUOUS_PRODUCT'],
      9: ['UNIT_FIXED'],
      10: ['INVALID_STATE'],
      11: ['EXPIRY_NEEDS_STOCK'],
      13: ['PRODUCT_DISAGREES'],
      14: ['UOM_NOT_FRACTIONAL'],
    });
    expect(res.body.error.details.summary.errors).toBe(10);
    // Nothing changed, not even the good rows.
    expect(names((await http().get('/v1/products').set(s.auth).expect(200)).body)).toEqual(['Cola', 'Sugar', 'Twin', 'Twin']);
    expect(cola.variants[0]!.sku).toBeTruthy();
  });

  it('needs catalog.manage, and prices.manage only for rows that change a price', async () => {
    const s = await shop('pimport-perm');
    const item = await add(s, 'Soap', {}, [{ price: '35.00' }]);
    await http().post('/v1/roles').set(s.auth).send({ key: 'catalog_clerk', name: 'Catalog clerk', permissions: ['catalog.read', 'catalog.manage'] }).expect(201);
    const clerk = bearer(await loginToken(app, (await addMember(owner, s.t.tenantId, 'catalog_clerk')).email));
    const cashier = bearer(await loginToken(app, (await addMember(owner, s.t.tenantId, 'cashier')).email));
    const rows = [row(2, { name: 'Soap', sku: item.variants[0]!.sku, price: '35.00', variantName: 'Bar' })];
    expect((await http().post('/v1/products/import/preview').set(cashier).send({ rows })).status).toBe(403);
    // Same price: no price permission needed.
    await http().post('/v1/products/import').set(clerk).send({ rows }).expect(201);
    const priced = await http().post('/v1/products/import/preview').set(clerk).send({ rows: [{ ...rows[0], price: '36.00' }] }).expect(200);
    expect(priced.body.rows[0].errors.map((e: { code: string }) => e.code)).toEqual(['FORBIDDEN']);
  });

  it('matches SKUs in its own business only', async () => {
    const a = await shop('pimport-a');
    const b = await shop('pimport-b');
    const item = await add(a, 'Secret', {}, [{ price: '10.00' }]);
    const res = await http().post('/v1/products/import/preview').set(b.auth).send({ rows: [row(2, { name: 'Mine', sku: item.variants[0]!.sku, price: '1.00' })] }).expect(200);
    expect(res.body.rows[0].action).toBe('CREATE');
    await http().post('/v1/products/import').set(b.auth).send({ rows: [row(2, { name: 'Mine', sku: item.variants[0]!.sku, price: '1.00' })] }).expect(201);
    expect(names((await http().get('/v1/products').set(a.auth).expect(200)).body)).toEqual(['Secret']);
    const aPrices = (await http().get(`/v1/price-lists/${a.defaultListId}/prices`).set(a.auth).expect(200)).body.data as { amount: string }[];
    expect(aPrices.map((p) => p.amount)).toEqual(['10.0000']);
  });

  it('shows before and after for name, category and price, and refuses categories the tree cannot hold', async () => {
    const s = await shop('pimport-shift');
    const cat = (await http().post('/v1/categories').set(s.auth).send({ name: 'Drinks' }).expect(201)).body as { id: string };
    const cola = await add(s, 'Cola', { categoryId: cat.id }, [{ price: '20.00' }]);
    const sku = cola.variants[0]!.sku;
    const res = await http()
      .post('/v1/products/import/preview')
      .set(s.auth)
      .send({ rows: [row(2, { name: 'Cola Zero', sku, category: 'Drinks › Soft drinks', price: '22.50' })] })
      .expect(200);
    expect(res.body.rows[0].values).toEqual({
      name: { before: 'Cola', after: 'Cola Zero' },
      category: { before: 'Drinks', after: 'Drinks › Soft drinks' },
      price: { before: '20.0000', after: '22.50' },
    });

    // Five levels at most (trigger app_category_tree_guard), names of 200 characters at most: refused in the preview, not at the end.
    const deep = [
      row(2, { name: 'Deep', sku: uniq('D'), category: 'A › B › C › D › E › F' }),
      row(3, { name: 'Deeper', sku: uniq('D2'), category: 'Drinks › B › C › D › E' }),
      row(4, { name: 'Five', sku: uniq('D3'), category: 'A › B › C › D › E' }),
      row(5, { name: 'Long', sku: uniq('D4'), category: `Drinks › ${'x'.repeat(201)}` }),
    ];
    const refused = await http().post('/v1/products/import').set(s.auth).send({ rows: deep });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'IMPORT_INVALID']);
    const codes = Object.fromEntries((refused.body.error.details.rows as { line: number; errors: { code: string }[] }[]).map((r) => [r.line, r.errors.map((e) => e.code)]));
    expect(codes).toEqual({ 2: ['CATEGORY_TOO_DEEP'], 5: ['CATEGORY_NAME_TOO_LONG'] });
    // Within the limits, the same rows import.
    await http().post('/v1/products/import').set(s.auth).send({ rows: [deep[1], deep[2]] }).expect(201);
  });

  it('flags a SKU or barcode whose leading zeros a spreadsheet may have dropped, in its own business only', async () => {
    const s = await shop('pimport-zeros');
    const other = await shop('pimport-zeros-b');
    const n = String(Date.now()).slice(-7);
    await add(s, 'Soap', {}, [{ sku: `00${n}`, barcodes: [`0${n}12345`] }]);
    await add(other, 'Theirs', {}, [{ sku: `000${n}9`, barcodes: [`0${n}54321`] }]);
    const rows = [
      row(2, { name: 'Soap', sku: n, barcodes: [`${n}12345`] }),
      row(3, { name: 'Other', sku: `${n}9`, barcodes: [`${n}54321`] }),
    ];
    const res = await http().post('/v1/products/import/preview').set(s.auth).send({ rows }).expect(200);
    expect(res.body.rows[0].warnings.map((w: { code: string; vars: Record<string, string> }) => [w.code, w.vars])).toEqual([
      ['SKU_LEADING_ZEROS', { sku: `00${n}` }],
      ['BARCODE_LEADING_ZEROS', { code: `${n}12345`, existing: `0${n}12345` }],
    ]);
    expect(res.body.rows[1].warnings).toEqual([]);
    // A warning does not refuse the row.
    expect(res.body.summary.errors).toBe(0);
  });

  it('takes a file of 2,000 rows (larger than other requests may be) and no more', async () => {
    const s = await shop('pimport-big');
    const big = Array.from({ length: 2000 }, (_, i) => row(i + 2, { name: `Item number ${i} with a fairly long name`, sku: `BIG-${String(i).padStart(5, '0')}`, price: '12.50', category: 'Bulk › Imported', barcodes: [`29${String(i).padStart(11, '0')}`] }));
    expect(JSON.stringify({ rows: big }).length).toBeGreaterThan(200_000);
    const started = Date.now();
    const done = await http().post('/v1/products/import').set(s.auth).send({ rows: big }).expect(201);
    expect(done.body.summary.products).toBe(2000);
    console.info(`2,000-row import: ${Date.now() - started} ms`);
    const tooMany = await http().post('/v1/products/import/preview').set(s.auth).send({ rows: [...big, row(9999, { name: 'One more', sku: 'BIG-X' })] });
    expect([tooMany.status, tooMany.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    // Every other route keeps its small limit.
    const huge = await http().post('/v1/categories').set(s.auth).send({ name: 'x', pad: 'y'.repeat(200_000) });
    expect([huge.status, huge.body.error?.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    // And the import's own limit is 2 MB, answered in the same words (the admin names it in the reader's language).
    for (const path of ['/v1/products/import/preview', '/v1/products/import']) {
      const over = await http().post(path).set(s.auth).send({ rows: [row(2, { name: 'x'.repeat(100), sku: 'OVER-1', pad: 'y'.repeat(2_200_000) })] });
      expect([over.status, over.body.error?.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    }
  }, 120_000);
});
