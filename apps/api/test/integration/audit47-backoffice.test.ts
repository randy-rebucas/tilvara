import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Back-office findings of the 2026-10-31 audit: untracking an item with stock in transit or on an open count
 * sheet (#7), a sale's pack openings in the stock movements report (#20), a receipt naming one dated item
 * twice (#21), alert days of 0 (#22), manual entry dates (#23), reservations of archived or unsellable stock
 * (#24), and the batch trace's limit.
 */
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
  return { tenantId: t.tenantId, auth, le, b1, b2, product, supplier };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const idem = (s: Shop, path: string, body: object) => http().post(path).set(s.auth).set('Idempotency-Key', randomUUID()).send(body);
const adjust = (s: Shop, branchId: string, items: object[], kind?: string) => idem(s, '/v1/stock/adjustments', { branchId, reason: 'Arrange', ...(kind && { kind }), items });
const audit = (s: Shop) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));
const q = <T = Record<string, unknown>>(s: Shop, text: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(text, params)).rows as T[]);
/** Turns tracking off behind the API's back (as if it had raced a transfer or a sheet before this rule). */
const untrackBehind = (s: Shop, productId: string, track = false) => q(s, `UPDATE products SET track_inventory = $2 WHERE id = $1`, [productId, track]);
const manilaDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + offsetDays * 86_400_000));

describe('untracking an item (#7)', () => {
  it('is refused while it is in transit, by hand or by import; a transfer is never received into an untracked item', async () => {
    const s = await shop('a46-transit');
    const cola = await s.product('Cola', '22.40');
    await adjust(s, s.b1, [{ variantId: cola.variantId, quantity: '10', unitCost: '10.00' }]).expect(201);
    const tr = (await idem(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: cola.variantId, quantity: '10' }] }).expect(201)).body;
    // No balance anywhere holds stock now: only the transfer does.
    const off = () => http().patch(`/v1/products/${cola.productId}`).set(s.auth).send({ trackInventory: false });
    expect((await off().expect(409)).body.error).toMatchObject({ code: 'HAS_STOCK', details: { reason: 'IN_TRANSIT' } });
    const rows = [{ line: 2, name: 'Cola', sku: cola.sku, trackInventory: false }];
    const preview = (await http().post('/v1/products/import/preview').set(s.auth).send({ rows }).expect(200)).body;
    expect(preview.rows[0]).toMatchObject({ action: 'ERROR', errors: [{ code: 'HAS_STOCK' }] });
    expect(preview.rows[0].errors[0].message).toMatch(/transit/);
    expect((await http().post('/v1/products/import').set(s.auth).set('Idempotency-Key', randomUUID()).send({ rows }).expect(422)).body.error.code).toBe('IMPORT_INVALID');

    await untrackBehind(s, cola.productId);
    expect((await idem(s, `/v1/stock/transfers/${tr.id}/receive`, { lines: [] }).expect(422)).body.error).toMatchObject({ code: 'NOT_STOCKED', details: { variantIds: [cola.variantId] } });
    await untrackBehind(s, cola.productId, true);
    await idem(s, `/v1/stock/transfers/${tr.id}/receive`, { lines: [] }).expect(200);
    // Received, then counted to nothing, it may stop tracking.
    await adjust(s, s.b2, [{ variantId: cola.variantId, quantity: '-10' }], 'WASTE').expect(201);
    expect((await off().expect(200)).body.trackInventory).toBe(false);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('is refused while an open count sheet lists it; such a sheet never posts a count of an untracked item', async () => {
    const s = await shop('a46-sheet');
    const cola = await s.product('Cola', '22.40');
    const sheet = (await http().post('/v1/stock/count-sheets').set(s.auth).send({ branchId: s.b1, variantIds: [cola.variantId] }).expect(201)).body;
    const off = () => http().patch(`/v1/products/${cola.productId}`).set(s.auth).send({ trackInventory: false });
    expect((await off().expect(409)).body.error).toMatchObject({ code: 'HAS_STOCK', details: { reason: 'ON_COUNT_SHEET' } });
    await http().put(`/v1/stock/count-sheets/${sheet.id}/lines`).set(s.auth).send({ lines: [{ variantId: cola.variantId, countedQuantity: '3' }] }).expect(200);

    await untrackBehind(s, cola.productId);
    expect((await http().post(`/v1/stock/count-sheets/${sheet.id}/post`).set(s.auth).set('Idempotency-Key', randomUUID()).expect(422)).body.error.code).toBe('NOT_STOCKED');
    expect(await q(s, `SELECT 1 FROM stock_movements WHERE variant_id = $1`, [cola.variantId])).toEqual([]);
    await untrackBehind(s, cola.productId, true);
    await http().post(`/v1/stock/count-sheets/${sheet.id}/cancel`).set(s.auth).send({ reason: 'Recount' }).expect(200);
    expect((await off().expect(200)).body.trackInventory).toBe(false);
  });
});

describe('a sale opening packs in the stock movements report (#20)', () => {
  it('dates the openings with the sale', async () => {
    const s = await shop('a46-unpack');
    const pack = await s.product('Cigarettes (pack of 20)', '240.00');
    const stick = await s.product('Cigarette stick', '13.00');
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: pack.variantId, pieceVariantId: stick.variantId, piecesPerPack: '20' }).expect(201);
    await adjust(s, s.b1, [{ variantId: pack.variantId, quantity: '1', unitCost: '200.00' }]).expect(201);
    const registerId = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
    const sale = (await http().post('/v1/sales').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: stick.variantId, quantity: '2' }], tenders: [{ method: 'CASH', tendered: '1000.00' }] }).expect(201)).body;
    expect(await q(s, `SELECT sale_id FROM pack_openings`)).toEqual([{ sale_id: sale.id }]);

    // Rung yesterday noon (Manila), as a late offline sale would be; its movements were written today.
    const yesterday = manilaDay(-1);
    await q(s, `
      DO $$ BEGIN
        ALTER TABLE cashier_sessions DISABLE TRIGGER USER; ALTER TABLE sales DISABLE TRIGGER USER;
        UPDATE cashier_sessions SET opened_at = ('${yesterday}'::date + time '08:00') AT TIME ZONE 'Asia/Manila' WHERE id = '${session}';
        UPDATE sales SET completed_at = ('${yesterday}'::date + time '12:00') AT TIME ZONE 'Asia/Manila' WHERE id = '${sale.id}';
        ALTER TABLE cashier_sessions ENABLE TRIGGER USER; ALTER TABLE sales ENABLE TRIGGER USER;
      END $$`);
    const report = (await http().get('/v1/reports/stock-movements').query({ branchId: s.b1, from: yesterday, to: yesterday }).set(s.auth).expect(200)).body;
    const row = report.data.find((r: { variantId: string }) => r.variantId === stick.variantId);
    const n = (v: { quantity: string } | undefined) => Number(v?.quantity);
    expect([n(row.opening), n(row.movements.UNPACK_IN), n(row.movements.SALE), n(row.closing), row.belowZero]).toEqual([0, 20, -2, 18, 0]);
    const packRow = report.data.find((r: { variantId: string }) => r.variantId === pack.variantId);
    expect(n(packRow.movements.UNPACK_OUT)).toBe(-1);
  });
});

describe('a receipt naming one dated item twice (#21)', () => {
  it('gives each line its own lot, and the lots add up to the balance, from below zero', async () => {
    const s = await shop('a46-grn');
    const milk = await s.product('Milk', '95.00', { tracksExpiry: true });
    await http().put(`/v1/branches/${s.b1}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: false }).expect(200);
    const registerId = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
    await http().post('/v1/sales').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: milk.variantId, quantity: '3' }], tenders: [{ method: 'CASH', tendered: '1000.00' }] }).expect(201);
    await idem(s, '/v1/goods-receipts', {
      branchId: s.b1, supplierId: s.supplier,
      lines: [
        { variantId: milk.variantId, quantity: '5', unitCost: '60.00', expiresOn: '2030-01-31', lotCode: 'A' },
        { variantId: milk.variantId, quantity: '5', unitCost: '60.00', expiresOn: '2030-06-30', lotCode: 'B' },
      ],
    }).expect(201);
    const lots = await q<{ lot_code: string; quantity: string }>(s, `SELECT lot_code, quantity::text FROM stock_lots WHERE variant_id = $1 AND quantity > 0 ORDER BY lot_code`, [milk.variantId]);
    const [bal] = await q<{ quantity: string }>(s, `SELECT quantity::text FROM stock_balances WHERE variant_id = $1`, [milk.variantId]);
    expect(Number(bal!.quantity)).toBe(7);
    expect(lots.reduce((a, l) => a + Number(l.quantity), 0)).toBe(7);
    expect(lots.map((l) => l.lot_code)).toContain('B');
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('expiry alert days of 0 (#22)', () => {
  it('lists only what has expired, not 30 days ahead', async () => {
    const s = await shop('a46-alert');
    await http().put(`/v1/branches/${s.b1}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: false, expiryAlertDays: 0 }).expect(200);
    expect((await http().get('/v1/stock/expiring').query({ branchId: s.b1 }).set(s.auth).expect(200)).body.withinDays).toBe(0);
  });
});

describe('manual entry dates (#23)', () => {
  it('refuses an entry after today and a reversal before its original or after today', async () => {
    const s = await shop('a46-dates');
    const accounts = (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.auth).expect(200)).body.data as { id: string; systemKey: string | null }[];
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const lines = [{ accountId: id('CASH_IN_BANK'), debit: '100.00' }, { accountId: id('CASH_TRANSFERS'), credit: '100.00' }];
    const today = manilaDay();
    const ahead = await idem(s, '/v1/journal-entries', { legalEntityId: s.le, entryDate: '2062-01-15', memo: 'Typo', lines }).expect(422);
    expect(ahead.body.error).toMatchObject({ code: 'DATE_IN_FUTURE', details: { today } });
    expect(await q(s, `SELECT 1 FROM accounting_periods WHERE starts_on = '2062-01-01'`)).toEqual([]);

    const entry = (await idem(s, '/v1/journal-entries', { legalEntityId: s.le, entryDate: today, memo: 'Float', lines }).expect(201)).body;
    const reverse = (entryDate?: string) => idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'Undo', ...(entryDate && { entryDate }) });
    expect((await reverse(manilaDay(-1)).expect(422)).body.error).toMatchObject({ code: 'REVERSAL_BEFORE_ORIGINAL', details: { originalDate: today } });
    expect((await reverse('2062-01-15').expect(422)).body.error.code).toBe('DATE_IN_FUTURE');
    expect((await reverse(today).expect(201)).body).toMatchObject({ sourceType: 'REVERSAL', entryDate: today });
  });

  it('reverses an entry dated ahead before this rule on its own date', async () => {
    const s = await shop('a46-ahead');
    const accounts = (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.auth).expect(200)).body.data as { id: string; systemKey: string | null }[];
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const entry = (await idem(s, '/v1/journal-entries', { legalEntityId: s.le, entryDate: manilaDay(), memo: 'Typo', lines: [{ accountId: id('CASH_IN_BANK'), debit: '5.00' }, { accountId: id('CASH_TRANSFERS'), credit: '5.00' }] }).expect(201)).body;
    // Dated 2062 as the API allowed before (written as the owner).
    await q(s, `
      DO $$ BEGIN
        ALTER TABLE journal_entries DISABLE TRIGGER USER;
        INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on) VALUES ('${s.tenantId}', '${s.le}', '2062-01-01') ON CONFLICT DO NOTHING;
        UPDATE journal_entries SET entry_date = '2062-01-15' WHERE id = '${entry.id}';
        ALTER TABLE journal_entries ENABLE TRIGGER USER;
      END $$`);
    expect((await idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'Undo' }).expect(201)).body.entryDate).toBe('2062-01-15');
  });
});

describe('reservations (#24)', () => {
  it('refuse an archived item, and held lots or expired ones under BLOCK', async () => {
    const s = await shop('a46-reserve');
    const reserve = (variantId: string, quantity = '1') => http().post('/v1/stock/reservations').set(s.auth).send({ branchId: s.b1, variantId, quantity, note: 'Maria' });

    const old = await s.product('Old item', '5.00');
    await adjust(s, s.b1, [{ variantId: old.variantId, quantity: '2', unitCost: '1.00' }]).expect(201);
    await adjust(s, s.b1, [{ variantId: old.variantId, quantity: '-2' }], 'WASTE').expect(201);
    await http().post(`/v1/products/${old.productId}/archive`).set(s.auth).expect(200);
    expect((await reserve(old.variantId).expect(409)).body.error.code).toBe('ARCHIVED');

    const tea = await s.product('Tea', '50.00', { tracksExpiry: true });
    await adjust(s, s.b1, [
      { variantId: tea.variantId, quantity: '2', unitCost: '20.00', expiresOn: manilaDay(-3), lotCode: 'OLD' },
      { variantId: tea.variantId, quantity: '3', unitCost: '20.00', expiresOn: '2030-01-31', lotCode: 'REC' },
    ], 'ADJUSTMENT').expect(201);
    // ALLOW: the expired lot may be sold, so it may be set aside.
    const r = (await reserve(tea.variantId, '5').expect(201)).body.id as string;
    await http().post(`/v1/stock/reservations/${r}/release`).set(s.auth).send({ reason: 'Changed' }).expect(200);
    const hold = (await idem(s, '/v1/stock/lot-holds', { variantId: tea.variantId, lotCode: 'REC', reason: 'Recall' }).expect(201)).body.id as string;
    expect((await reserve(tea.variantId, '3').expect(409)).body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { onHand: '5', unsellable: '3', available: '2' } });
    await reserve(tea.variantId, '2').expect(201);
    await http().post(`/v1/stock/lot-holds/${hold}/release`).set(s.auth).set('Idempotency-Key', randomUUID()).send({ reason: 'Cleared' });
    // BLOCK: the expired lot cannot be set aside (2 of the 5 already are).
    await http().put(`/v1/branches/${s.b1}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: false, expiredStock: 'BLOCK' }).expect(200);
    expect((await reserve(tea.variantId, '2').expect(409)).body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { onHand: '5', reserved: '2', unsellable: '2', available: '1' } });
    await reserve(tea.variantId, '1').expect(201);
  });
});

describe('batch trace (audit info)', () => {
  it('says whether it left the newest movements out', async () => {
    const s = await shop('a46-trace');
    const tea = await s.product('Tea', '50.00', { tracksExpiry: true });
    await adjust(s, s.b1, [{ variantId: tea.variantId, quantity: '3', unitCost: '20.00', expiresOn: '2030-01-31', lotCode: 'L1' }], 'ADJUSTMENT').expect(201);
    const trace = (await http().get('/v1/stock/lots/trace').query({ variantId: tea.variantId, lotCode: 'L1' }).set(s.auth).expect(200)).body;
    expect([trace.movements.length, trace.truncated]).toEqual([1, false]);
  });
});
