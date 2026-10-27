import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Back-office findings of the 2026-10-27 audit (session 45): archiving a branch with stock or open
 * documents (#8), turning off stock tracking with stock (#9), supplier returns tied to a receipt and the
 * GRNI sub-ledger check (#10), manual entries on system accounts (#11) and their reversal after an
 * account is archived (#38), opening packs by hand (#35), Stock by branch's order and limit (#36), and
 * payment exceptions on every plan (#39).
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

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
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) => {
    const body = (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body;
    return { productId: body.id as string, variantId: body.variants[0].id as string, sku: body.variants[0].sku as string };
  };
  const supplier = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, auth, le, b1, b2, product, supplier, pc, taxes };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const idem = (s: Shop, path: string, body: object, auth: Auth = s.auth) => http().post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body);
const adjust = (s: Shop, branchId: string, items: object[], kind?: string) => idem(s, '/v1/stock/adjustments', { branchId, reason: 'Arrange', ...(kind && { kind }), items });
const audit = (s: Shop) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));
const ok = (r: request.Response) => {
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body;
};

describe('archiving a branch (#8)', () => {
  it('is refused while the branch has stock, a transfer on its way, an open count sheet or an open order; a transfer is never received into an archived branch', async () => {
    const s = await shop('a45-arch');
    const cola = await s.product('Cola', '22.40');
    await adjust(s, s.b2, [{ variantId: cola.variantId, quantity: '5', unitCost: '10.00' }]).expect(201);
    const archive = () => http().post(`/v1/branches/${s.b2}/archive`).set(s.auth);

    const stocked = await archive().expect(409);
    expect(stocked.body.error).toMatchObject({ code: 'BRANCH_HAS_STOCK', details: { items: 1 } });

    // The stock leaves for B1: the branch is empty, but the transfer is still on its way.
    const tr = (await idem(s, '/v1/stock/transfers', { fromBranchId: s.b2, toBranchId: s.b1, lines: [{ variantId: cola.variantId, quantity: '5' }] }).expect(201)).body;
    expect((await archive().expect(409)).body.error).toMatchObject({ code: 'BRANCH_HAS_OPEN_DOCUMENTS', details: { transfers: 1, countSheets: 0, purchaseOrders: 0 } });

    // A destination archived before this rule (written as the owner) never takes the transfer in.
    await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE branches SET archived_at = now() WHERE id = $1`, [s.b1]));
    const refused = await idem(s, `/v1/stock/transfers/${tr.id}/receive`, { lines: [] }).expect(409);
    expect(refused.body.error.code).toBe('BRANCH_ARCHIVED');
    await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE branches SET archived_at = NULL WHERE id = $1`, [s.b1]));
    await idem(s, `/v1/stock/transfers/${tr.id}/receive`, { lines: [] }).expect(200);

    // An open count sheet, then an approved order, each keep it.
    const sheet = (await http().post('/v1/stock/count-sheets').set(s.auth).send({ branchId: s.b2, variantIds: [cola.variantId] }).expect(201)).body;
    expect((await archive().expect(409)).body.error).toMatchObject({ code: 'BRANCH_HAS_OPEN_DOCUMENTS', details: { transfers: 0, countSheets: 1, purchaseOrders: 0 } });
    ok(await http().post(`/v1/stock/count-sheets/${sheet.id}/cancel`).set(s.auth).send({ reason: 'Not needed' }));
    const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.b2, supplierId: s.supplier, lines: [{ variantId: cola.variantId, quantity: '6', unitCost: '10.00' }] }).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    expect((await archive().expect(409)).body.error).toMatchObject({ code: 'BRANCH_HAS_OPEN_DOCUMENTS', details: { transfers: 0, countSheets: 0, purchaseOrders: 1 } });
    ok(await http().post(`/v1/purchase-orders/${po.id}/cancel`).set(s.auth).send({ reason: 'Not needed' }));
    expect((await archive().expect(200)).body.archivedAt).toBeTruthy();
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('stock tracking (#9)', () => {
  it('cannot be turned off while an item has stock, by hand or by import; adjustments refuse untracked items', async () => {
    const s = await shop('a45-track');
    const cola = await s.product('Cola', '22.40');
    await adjust(s, s.b2, [{ variantId: cola.variantId, quantity: '3', unitCost: '10.00' }]).expect(201);
    const off = () => http().patch(`/v1/products/${cola.productId}`).set(s.auth).send({ trackInventory: false });
    expect((await off().expect(409)).body.error.code).toBe('HAS_STOCK');

    const rows = [{ line: 2, name: 'Cola', sku: cola.sku, trackInventory: false }];
    const preview = (await http().post('/v1/products/import/preview').set(s.auth).send({ rows }).expect(200)).body;
    expect(preview.rows[0]).toMatchObject({ action: 'ERROR', errors: [{ code: 'HAS_STOCK' }] });
    const commit = await http().post('/v1/products/import').set(s.auth).set('Idempotency-Key', randomUUID()).send({ rows }).expect(422);
    expect(commit.body.error.code).toBe('IMPORT_INVALID');

    // Written off, it may stop tracking stock; then no adjustment puts stock on it.
    await adjust(s, s.b2, [{ variantId: cola.variantId, quantity: '-3' }], 'WASTE').expect(201);
    expect((await off().expect(200)).body.trackInventory).toBe(false);
    const refused = await adjust(s, s.b2, [{ variantId: cola.variantId, quantity: '1', unitCost: '10.00' }]).expect(422);
    expect(refused.body.error).toMatchObject({ code: 'NOT_STOCKED', details: { variantIds: [cola.variantId] } });
    // Turned back on by import (no stock to hold it), as before.
    expect((await http().post('/v1/products/import/preview').set(s.auth).send({ rows: [{ ...rows[0], trackInventory: true }] }).expect(200)).body.rows[0].action).toBe('UPDATE');
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('supplier returns and GRNI (#10)', () => {
  it('stocked goods go back against their receipt; GRNI then equals what open receipts hold, and a stray GRNI line is caught', async () => {
    const s = await shop('a45-grni');
    const cola = await s.product('Cola', '22.40');
    const fee = await s.product('Delivery', '0.01', { productType: 'SERVICE', trackInventory: false });
    const receive = async (lines: object[]) => (await idem(s, '/v1/goods-receipts', { branchId: s.b1, supplierId: s.supplier, lines }).expect(201)).body;
    const r1 = await receive([{ variantId: cola.variantId, quantity: '10', unitCost: '12.345' }, { variantId: fee.variantId, quantity: '1', unitCost: '50.00' }]);
    const r2 = await receive([{ variantId: cola.variantId, quantity: '4', unitCost: '11.00' }]);
    const ret = (body: object) => idem(s, '/v1/supplier-returns', { branchId: s.b1, supplierId: s.supplier, reason: 'Dented', ...body });

    const loose = await ret({ lines: [{ variantId: cola.variantId, quantity: '1' }, { variantId: fee.variantId, quantity: '1', creditUnitCost: '5.00' }] }).expect(422);
    expect(loose.body.error).toMatchObject({ code: 'GOODS_RECEIPT_REQUIRED', details: { variantIds: [cola.variantId] } });
    // A non-stock line alone needs no receipt (no stock moved).
    await ret({ lines: [{ variantId: fee.variantId, quantity: '1', creditUnitCost: '5.00' }] }).expect(201);
    await ret({ goodsReceiptId: r1.id, lines: [{ goodsReceiptLineId: r1.lines.find((l: { variantId: string }) => l.variantId === cola.variantId).id, variantId: cola.variantId, quantity: '2' }] }).expect(201);
    await ret({ goodsReceiptId: r2.id, lines: [{ variantId: cola.variantId, quantity: '1', creditUnitCost: '11.00' }] }).expect(201);
    // r2 invoiced: GRNI keeps r1 only.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    await idem(s, '/v1/supplier-invoices', { supplierId: s.supplier, invoiceNumber: 'SI-1', invoiceDate: today, goodsReceiptIds: [r2.id], netAmount: '33.00', vatAmount: '3.96' }).expect(201);

    const found = await audit(s);
    // The loose non-stock return above is the one GRNI line no receipt explains (−5.00).
    expect(found['GRNI ≠ open receipts (per legal entity)']).toMatchObject([{ legal_entity_id: s.le }]);
    const [row] = found['GRNI ≠ open receipts (per legal entity)'] as { books: string; receipts: string }[];
    expect(Number(row!.receipts) - Number(row!.books)).toBeCloseTo(5, 4);
    expect({ ...found, 'GRNI ≠ open receipts (per legal entity)': [] }).toEqual(CLEAN);
  });

  it('a GRNI made only of tied returns and invoices is clean, and a manual GRNI line written behind the books is caught', async () => {
    const s = await shop('a45-grni2');
    const cola = await s.product('Cola', '22.40');
    const r1 = (await idem(s, '/v1/goods-receipts', { branchId: s.b1, supplierId: s.supplier, lines: [{ variantId: cola.variantId, quantity: '3', unitCost: '10.3333' }] }).expect(201)).body;
    await idem(s, '/v1/supplier-returns', { branchId: s.b1, supplierId: s.supplier, goodsReceiptId: r1.id, reason: 'x', lines: [{ goodsReceiptLineId: r1.lines[0].id, variantId: cola.variantId, quantity: '1' }] }).expect(201);
    expect(await audit(s)).toEqual(CLEAN);
    await asOwnerInTenant(owner, s.tenantId, async (c) => {
      const acc = Object.fromEntries((await c.query(`SELECT system_key, id FROM accounts WHERE legal_entity_id = $1`, [s.le])).rows.map((r) => [r.system_key, r.id]));
      const e = (await c.query(`INSERT INTO journal_entries (tenant_id, legal_entity_id, entry_number, entry_date, source_type, memo, created_by) VALUES ($1, $2, 900, current_date, 'MANUAL', 'behind the books', $1) RETURNING id`, [s.tenantId, s.le])).rows[0].id;
      await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, debit) VALUES ($1, $2, $3, $4, 7)`, [s.tenantId, s.le, e, acc.GRNI]);
      await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, credit) VALUES ($1, $2, $3, $4, 7)`, [s.tenantId, s.le, e, acc.CASH_IN_BANK]);
    });
    expect((await audit(s))['GRNI ≠ open receipts (per legal entity)']).toHaveLength(1);
  });
});

describe('manual entries (#11, #38)', () => {
  it('post to own accounts and the cash ones only; the picker says which; a reversal posts after an account is archived', async () => {
    const s = await shop('a45-manual');
    const list = async () => (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.auth).expect(200)).body.data as { id: string; systemKey: string | null; manualAllowed: boolean }[];
    const rent = (await http().post('/v1/accounts').set(s.auth).send({ legalEntityId: s.le, code: '6100', name: 'Rent', type: 'EXPENSE' }).expect(201)).body.id as string;
    const accounts = await list();
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    expect(Object.fromEntries(accounts.filter((a) => a.manualAllowed).map((a) => [a.systemKey ?? a.id, true]))).toEqual({ CASH_ON_HAND: true, CASH_IN_BANK: true, CASH_TRANSFERS: true, [rent]: true });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const manual = (lines: object[]) => idem(s, '/v1/journal-entries', { legalEntityId: s.le, entryDate: today, memo: 'By hand', lines });

    for (const key of ['INVENTORY', 'GRNI', 'ACCOUNTS_PAYABLE', 'CUSTOMER_STORE_CREDIT', 'INVENTORY_IN_TRANSIT', 'SALES', 'OUTPUT_VAT']) {
      const r = await manual([{ accountId: id(key), debit: '10.00' }, { accountId: id('CASH_IN_BANK'), credit: '10.00' }]).expect(422);
      expect([key, r.body.error.code, r.body.error.details.systemKeys]).toEqual([key, 'SYSTEM_ACCOUNT_NOT_ALLOWED', [key]]);
    }
    await manual([{ accountId: id('CASH_IN_BANK'), debit: '1000.00' }, { accountId: id('CASH_TRANSFERS'), credit: '1000.00' }]).expect(201);
    const paid = (await manual([{ accountId: rent, debit: '500.00' }, { accountId: id('CASH_IN_BANK'), credit: '500.00' }]).expect(201)).body;

    // Rent archived: no new entry names it, but the one posted to it can still be reversed.
    await http().post(`/v1/accounts/${rent}/archive`).set(s.auth).expect(200);
    expect((await manual([{ accountId: rent, debit: '1.00' }, { accountId: id('CASH_IN_BANK'), credit: '1.00' }]).expect(409)).body.error.code).toBe('ACCOUNT_ARCHIVED');
    const rev = (await idem(s, `/v1/journal-entries/${paid.id}/reverse`, { memo: 'Wrong month' }).expect(201)).body;
    expect(rev).toMatchObject({ sourceType: 'REVERSAL', reversesEntryId: paid.id });
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('opening packs by hand (#35)', () => {
  it('needs free packs (on hand, less reserved, less held) under ALLOW too', async () => {
    const s = await shop('a45-packs');
    const pack = await s.product('Candy (pack of 10)', '50.00', { tracksExpiry: true });
    const piece = await s.product('Candy', '6.00', { tracksExpiry: true });
    const link = (await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: pack.variantId, pieceVariantId: piece.variantId, piecesPerPack: '10' }).expect(201)).body.id as string;
    const open = (packs: string) => idem(s, '/v1/stock/pack-openings', { branchId: s.b1, conversionId: link, packs, reason: 'Shelf' });
    const refused = async (packs: string, available: string) =>
      expect((await open(packs).expect(409)).body.error).toMatchObject({ code: 'PACKS_NOT_ON_HAND', details: { lines: [{ variantId: pack.variantId, available, requested: packs }] } });

    await refused('1', '0'); // none at all (ALLOW, the default)
    await adjust(s, s.b1, [{ variantId: pack.variantId, quantity: '2', unitCost: '40.00', expiresOn: '2030-01-31', lotCode: 'LOT-A' }]).expect(201);
    await refused('3', '2');
    const reservation = (await http().post('/v1/stock/reservations').set(s.auth).send({ branchId: s.b1, variantId: pack.variantId, quantity: '1', note: 'Maria' }).expect(201)).body.id as string;
    await refused('2', '1');
    const hold = (await idem(s, '/v1/stock/lot-holds', { variantId: pack.variantId, lotCode: 'LOT-A', reason: 'Recall' }).expect(201)).body.id as string;
    await refused('1', '0');
    ok(await http().post(`/v1/stock/lot-holds/${hold}/release`).set(s.auth).set('Idempotency-Key', randomUUID()).send({ reason: 'Cleared' }));
    ok(await http().post(`/v1/stock/reservations/${reservation}/release`).set(s.auth).send({ reason: 'Collected elsewhere' }));
    expect((await open('2').expect(201)).body).toMatchObject({ packs: '2', pieces: '20' });
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('stock by branch (#36)', () => {
  it('lists active items first by SKU, archived last, at most 2,000, and says when there are more', async () => {
    const s = await shop('a45-bybranch');
    const tag = randomUUID().slice(0, 6);
    const make = async (sku: string) => (await http().post('/v1/products').set(s.auth).send({ name: sku, uomId: s.pc, taxCategoryId: s.taxes.VAT, variants: [{ sku: `${sku}-${tag}`, price: '1.00' }] }).expect(201)).body;
    const [c, a, b] = [await make('C'), await make('A'), await make('B')];
    for (const p of [c, a, b]) await adjust(s, s.b1, [{ variantId: p.variants[0].id, quantity: '1', unitCost: '1.00' }]).expect(201);
    await adjust(s, s.b1, [{ variantId: a.variants[0].id, quantity: '-1' }], 'WASTE').expect(201);
    await http().post(`/v1/products/${a.id}/archive`).set(s.auth).expect(200);
    const view = (await http().get('/v1/stock/balances/by-branch').set(s.auth).expect(200)).body;
    expect([view.data.map((i: { sku: string }) => i.sku), view.truncated]).toEqual([[`B-${tag}`, `C-${tag}`, `A-${tag}`], false]);

    // 2,001 items with a balance (arranged as the owner): the first 2,000 in that order, and `truncated`.
    await asOwnerInTenant(owner, s.tenantId, async (c2) => {
      await c2.query(`
        WITH v AS (
          INSERT INTO product_variants (tenant_id, product_id, sku)
          SELECT $1, $2, 'Z' || lpad(g::text, 5, '0') || '-' || $4 FROM generate_series(1, 1998) g RETURNING id)
        INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity) SELECT $1, $3, id, 0 FROM v`, [s.tenantId, b.id, s.b1, tag]);
    });
    const big = (await http().get('/v1/stock/balances/by-branch').set(s.auth).expect(200)).body;
    expect([big.data.length, big.truncated, big.data[0].sku, big.data.at(-1).sku]).toEqual([2000, true, `B-${tag}`, `Z01998-${tag}`]);
  });
});

describe('payment exceptions (#39)', () => {
  it('are on every plan, with the same permission checks', async () => {
    const s = await shop('a45-payexc');
    await owner.query(`SELECT platform_set_subscription($1, 'starter', 'ACTIVE', null, null)`, [s.tenantId]);
    const cashier = bearer(await loginToken(app, (await addMember(owner, s.tenantId, 'cashier', { type: 'BRANCH', id: s.b1 })).email));
    const res = await http().get('/v1/reports/payment-exceptions').query({ branchId: s.b1 }).set(s.auth).expect(200);
    expect(res.body).toMatchObject({ branchId: s.b1, data: [], totals: { count: 0 } });
    await http().get('/v1/reports/payment-exceptions').query({ branchId: s.b1 }).set(cashier).expect(403);
    // The analysis reports stay on the plan's advanced_reports.
    const day = new Date().toISOString().slice(0, 10);
    expect((await http().get('/v1/reports/by-category').query({ branchId: s.b1, from: day, to: day }).set(s.auth).expect(403)).body.error.code).toBe('ENTITLEMENT_REQUIRED');
  });
});
