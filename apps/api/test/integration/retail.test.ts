import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { httpTransport, LocalStore, OfflineEngine } from '@1pos/pos-offline';
import { nodeSqliteDriver } from '@1pos/pos-offline/node-sqlite';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Retail stores and boutiques (ADR-0021): promotions priced by one function on the server and the
 * offline till, sizes and colours, quick keys, store barcodes, shelf locations and stock across branches.
 */
let app: INestApplication;
let owner: pg.Pool;
let base: string;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

type Auth = { Authorization: string };

/** A VAT boutique with two branches: a shirt in S and M (₱300), socks (₱50), stocked at both. */
async function boutique(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branch = async (code: string) => (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code, name: code, birBranchCode: code === 'B1' ? '00001' : '00002' }).expect(201)).body.id as string;
  const [b1, b2] = [await branch('B1'), await branch('B2')];
  const r1 = (await http().post('/v1/registers').set(auth).send({ branchId: b1, code: 'R1', name: 'Front' }).expect(201)).body.id as string;
  const r2 = (await http().post('/v1/registers').set(auth).send({ branchId: b2, code: 'R1', name: 'Front' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const base = uniq('TEE');
  const shirt = (
    await http().post('/v1/products').set(auth).send({
      name: 'Tee', uomId: pc, taxCategoryId: vat,
      variants: [
        { sku: `${base}-S-BLK`, name: 'S / Black', attributes: { Size: 'S', Colour: 'Black' }, price: '300.00' },
        { sku: `${base}-M-BLK`, name: 'M / Black', attributes: { Size: 'M', Colour: 'Black' }, price: '300.00' },
      ],
    }).expect(201)
  ).body.variants as { id: string; sku: string }[];
  const socks = (await http().post('/v1/products').set(auth).send({ name: 'Socks', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SOX'), price: '50.00' }] }).expect(201)).body.variants[0].id as string;
  const [small, medium] = [shirt[0]!.id, shirt[1]!.id];
  for (const b of [b1, b2]) {
    await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: b, reason: 'Opening', items: [small, medium, socks].map((variantId) => ({ variantId, quantity: '30', unitCost: '100.00' })) }).expect(201);
  }
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: b1 });
  const cashier = bearer(await loginToken(app, c.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: b1 });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: r1, openingFloat: '1000.00' }).expect(201)).body.id as string;
  return { t, tenantId: t.tenantId, auth, b1, b2, r1, r2, small, medium, socks, cashier, cashierId: c.userId, manager, session };
}
type B = Awaited<ReturnType<typeof boutique>>;

const sql = <T = Record<string, unknown>>(s: B, q: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const quote = (auth: Auth, branchId: string, lines: object[]) => http().post('/v1/tax/quote').set(auth).send({ branchId, lines });
const promote = (s: B, body: object) => http().post('/v1/promotions').set(s.auth).send(body);
/** "3 tees for ₱800" at B1, and "buy 2 socks, get 1 free" everywhere. */
async function promotions(s: B) {
  const tees = (await promote(s, { name: '3 tees for 800', kind: 'MULTI_BUY', quantity: 3, price: '800.00', variantIds: [s.small, s.medium], branchIds: [s.b1] }).expect(201)).body;
  const socks = (await promote(s, { name: 'Socks 2+1', kind: 'BUY_X_GET_Y', buyQuantity: 2, getQuantity: 1, getRate: '1', variantIds: [s.socks] }).expect(201)).body;
  return { tees, socks };
}

describe('promotions at the counter', () => {
  it('are priced by the server on the quote and the sale, recorded per line, and shown on the sale and the receipt', async () => {
    const s = await boutique('promo');
    const p = await promotions(s);
    expect([p.tees.state, p.tees.allBranches, p.tees.branchIds, p.tees.items.length]).toEqual(['RUNNING', false, [s.b1], 2]);
    const lines = [{ variantId: s.small, quantity: '2' }, { variantId: s.medium, quantity: '1' }, { variantId: s.socks, quantity: '3' }];

    const q = (await quote(s.cashier, s.b1, lines).expect(200)).body;
    // Tees: 900 → 800, split 600 : 300 (66.67 + 33.33). Socks: the third pair free.
    expect(q.lines.map((l: { discount: string; promotionId: string | null; promotionName?: string }) => [l.discount, l.promotionId, l.promotionName])).toEqual([
      ['66.67', p.tees.id, '3 tees for 800'], ['33.33', p.tees.id, '3 tees for 800'], ['50.00', p.socks.id, 'Socks 2+1'],
    ]);
    expect(q.totals.amountDue).toBe('900.00');
    // The cashier needs no discount permission for a promotion.
    const sale = (await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '1000.00' }], expectedAmountDue: '900.00' }).expect(201)).body;
    expect([sale.amountDue, sale.discount, sale.changeDue]).toEqual(['900.00', '150.00', '100.00']);
    expect(sale.lines.map((l: { promotionId: string; promotionName: string }) => [l.promotionId, l.promotionName])).toEqual([
      [p.tees.id, '3 tees for 800'], [p.tees.id, '3 tees for 800'], [p.socks.id, 'Socks 2+1'],
    ]);
    const receipt = (await http().get(`/v1/sales/${sale.id}/receipt`).set(s.cashier).expect(200)).body;
    expect(receipt.lines.map((l: { promotion?: string; discount?: string }) => [l.promotion, l.discount])).toEqual([
      ['3 tees for 800', '66.67'], ['3 tees for 800', '33.33'], ['Socks 2+1', '50.00'],
    ]);
    // Books and stock agree with the documents (revenue is net of the promotion, like any line discount).
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);

    // A return of one small tee gives back its share of what was paid for the line (533.33 for two).
    const smallLine = sale.lines[0] as { id: string; amountDue: string };
    expect(smallLine.amountDue).toBe('533.33');
    const ret = (await http().post(`/v1/sales/${sale.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Too small', lines: [{ saleLineId: smallLine.id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201)).body;
    expect(['266.66', '266.67']).toContain(ret.amountDue);
  });

  it('skips a line with its own discount, follows the branch list, and needs prices.manage to create', async () => {
    const s = await boutique('promo-rules');
    const p = await promotions(s);
    // The manager's own 10 % replaces the promotion on that line; the other two tees no longer make three.
    const q = (await quote(s.manager, s.b1, [{ variantId: s.small, quantity: '1', discountRate: '0.1' }, { variantId: s.medium, quantity: '2' }]).expect(200)).body;
    expect(q.lines.map((l: { discount: string; promotionId: string | null }) => [l.discount, l.promotionId])).toEqual([['30.00', null], ['0.00', null]]);
    // At B2 only the socks promotion runs.
    const b2 = (await quote(s.auth, s.b2, [{ variantId: s.small, quantity: '3' }, { variantId: s.socks, quantity: '3' }]).expect(200)).body;
    expect(b2.lines.map((l: { promotionId: string | null }) => l.promotionId)).toEqual([null, p.socks.id]);
    // A cashier cannot make promotions; a malformed one is refused before anything is stored.
    await http().post('/v1/promotions').set(s.cashier).send({ name: 'x', kind: 'MULTI_BUY', quantity: 2, price: '1.00', variantIds: [s.socks] }).expect(403);
    const bad = await promote(s, { name: 'x', kind: 'MULTI_BUY', quantity: 2, price: '1.00', getRate: '1', variantIds: [s.socks] }).expect(400);
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(['getRate']);
    await promote(s, { name: 'x', kind: 'QUANTITY_BREAK', tiers: [{ minQuantity: '5', rate: '0.1' }], variantIds: [s.socks], startsAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(422);
  });

  it('ends but never changes: ended promotions stop pricing, their terms are fixed in the database, and history keeps them', async () => {
    const s = await boutique('promo-end');
    const p = await promotions(s);
    const ended = (await http().patch(`/v1/promotions/${p.socks.id}`).set(s.auth).send({ endsAt: 'now' }).expect(200)).body;
    expect(ended.state).toBe('ENDED');
    const q = (await quote(s.cashier, s.b1, [{ variantId: s.socks, quantity: '3' }]).expect(200)).body;
    expect([q.lines[0].promotionId, q.totals.amountDue]).toEqual([null, '150.00']);
    expect((await http().patch(`/v1/promotions/${p.socks.id}`).set(s.auth).send({ endsAt: 'now' }).expect(409)).body.error.code).toBe('PROMOTION_ENDED');
    // Renaming is fine; the terms are not, even straight in the database.
    await http().patch(`/v1/promotions/${p.tees.id}`).set(s.auth).send({ name: 'Three tees' }).expect(200);
    await expect(sql(s, `UPDATE promotions SET price = 1 WHERE id = $1`, [p.tees.id])).rejects.toThrow(/terms never change/);
    await expect(sql(s, `DELETE FROM promotion_items WHERE promotion_id = $1`, [p.tees.id])).rejects.toThrow();
    // A promotion that has not started yet is called off: it never runs.
    const later = (await promote(s, { name: 'Later', kind: 'QUANTITY_BREAK', tiers: [{ minQuantity: '2', rate: '0.2' }], variantIds: [s.socks], startsAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)).body;
    expect(later.state).toBe('SCHEDULED');
    const off = (await http().patch(`/v1/promotions/${later.id}`).set(s.auth).send({ endsAt: 'now' }).expect(200)).body;
    expect([off.state, off.endsAt]).toEqual(['ENDED', later.startsAt]);
    const current = (await http().get('/v1/promotions').set(s.auth).expect(200)).body.data.map((x: { name: string }) => x.name);
    expect(current).toEqual(['Three tees']);
    const all = (await http().get('/v1/promotions').query({ state: 'ALL' }).set(s.auth).expect(200)).body.data;
    expect(all).toHaveLength(3);
  });
});

describe('promotions offline', () => {
  it('ride in the snapshot; the till and the server price the sale the same way', async () => {
    const s = await boutique('promo-off');
    const p = await promotions(s);
    const reg = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.r1, name: 'Till 1' }).expect(201)).body;
    const engine = new OfflineEngine({
      store: new LocalStore(nodeSqliteDriver(join(mkdtempSync(join(tmpdir(), '1pos-till-')), 'till.db'))),
      transport: httpTransport({ baseUrl: base, terminalId: reg.terminal.id, credential: reg.credential, timeoutMs: 10_000 }),
    });
    await engine.open();
    const snap = await engine.refreshSnapshot();
    expect((snap.promotions ?? []).map((x) => x.id).sort()).toEqual([p.socks.id, p.tees.id].sort());
    const { receipt } = await engine.ringUp({ cashierUserId: s.cashierId, lines: [{ variantId: s.small, quantity: '3' }, { variantId: s.socks, quantity: '3' }], tendered: '1000' });
    expect(receipt.totals.amountDue).toBe('900.00');
    expect(receipt.lines.map((l) => l.promotion)).toEqual([{ name: '3 tees for 800', discount: '100.00' }, { name: 'Socks 2+1', discount: '50.00' }]);
    const report = await engine.syncOnce();
    expect(report.results.map((r) => r.status)).toEqual(['RECORDED']);
    const lines = await sql<{ promotion_id: string; discount: string }>(s, `SELECT l.promotion_id, l.discount::text FROM sale_lines l JOIN sales x ON x.id = l.sale_id WHERE x.terminal_id = $1 ORDER BY l.line_no`, [reg.terminal.id]);
    expect(lines.map((l) => [l.promotion_id, Number(l.discount).toFixed(2)])).toEqual([[p.tees.id, '100.00'], [p.socks.id, '50.00']]);
  });
});

describe('sizes, quick keys, barcodes, shelves and stock across branches', () => {
  it('reports by size, keys items, makes store barcodes, keeps shelf labels and shows every branch', async () => {
    const s = await boutique('retail');
    const sell = (lines: object[]) => http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '5000.00' }] }).expect(201);
    await sell([{ variantId: s.small, quantity: '2' }, { variantId: s.medium, quantity: '1' }, { variantId: s.socks, quantity: '1' }]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const bySize = (await http().get('/v1/reports/by-attribute').query({ branchId: s.b1, from: today, to: today, attribute: 'Size' }).set(s.auth).expect(200)).body;
    expect(bySize.attributes).toEqual(['Colour', 'Size']);
    expect(bySize.data.map((r: { value: string | null; netQuantity: string; netSales: string }) => [r.value, r.netQuantity, r.netSales])).toEqual([['S', '2', '600.00'], ['M', '1', '300.00'], [null, '1', '50.00']]);

    // Quick keys: one item per key.
    await http().patch(`/v1/variants/${s.socks}`).set(s.auth).send({ quickKeyPosition: 1 }).expect(200);
    expect((await http().patch(`/v1/variants/${s.small}`).set(s.auth).send({ quickKeyPosition: 1 }).expect(409)).body.error.code).toBe('QUICK_KEY_TAKEN');
    const keys = (await http().get('/v1/catalog/quick-keys').query({ branchId: s.b1 }).set(s.cashier).expect(200)).body.data;
    expect(keys.map((k: { position: number; variantId: string; price: string }) => [k.position, k.variantId, k.price])).toEqual([[1, s.socks, '50.0000']]);

    // A store barcode, found at the till like any other.
    const code = (await http().post(`/v1/variants/${s.medium}/barcodes/generate`).set(s.auth).set('Idempotency-Key', randomUUID()).expect(201)).body.code as string;
    expect(code).toMatch(/^29\d{11}$/);
    expect((await http().get('/v1/catalog/lookup').query({ code, branchId: s.b1 }).set(s.cashier).expect(200)).body.variantId).toBe(s.medium);

    // Shelf locations: set by a stock keeper, shown on the stock list, cleared with null.
    await http().put('/v1/stock/locations').set(s.cashier).send({ branchId: s.b1, items: [{ variantId: s.small, location: 'a1' }] }).expect(403);
    const set = (await http().put('/v1/stock/locations').set(s.manager).send({ branchId: s.b1, items: [{ variantId: s.small, location: 'a1' }, { variantId: s.socks, location: 'B2-3' }] }).expect(200)).body.data;
    expect(set.map((l: { location: string; variantId: string }) => [l.location, l.variantId])).toEqual([['A1', s.small], ['B2-3', s.socks]]);
    const balances = (await http().get('/v1/stock/balances').query({ branchId: s.b1 }).set(s.manager).expect(200)).body.data;
    expect(balances.find((b: { variantId: string }) => b.variantId === s.small).location).toBe('A1');
    await http().put('/v1/stock/locations').set(s.manager).send({ branchId: s.b1, items: [{ variantId: s.small, location: null }] }).expect(200);
    expect((await http().get('/v1/stock/locations').query({ branchId: s.b1 }).set(s.manager).expect(200)).body.data).toHaveLength(1);

    // Every branch side by side for the owner; a branch manager sees their own branch only.
    const all = (await http().get('/v1/stock/balances/by-branch').set(s.auth).expect(200)).body;
    expect(all.branches.map((b: { code: string }) => b.code)).toEqual(['B1', 'B2']);
    const small = all.data.find((r: { variantId: string }) => r.variantId === s.small);
    expect([small.branches[s.b1].quantity, small.branches[s.b2].quantity, small.total]).toEqual(['28', '30', '58']);
    const mine = (await http().get('/v1/stock/balances/by-branch').set(s.manager).expect(200)).body;
    expect(mine.branches.map((b: { code: string }) => b.code)).toEqual(['B1']);
  });

  it('the promotions report totals what each promotion gave', async () => {
    const s = await boutique('promo-report');
    const p = await promotions(s);
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines: [{ variantId: s.socks, quantity: '6' }], tenders: [{ method: 'CASH', tendered: '500.00' }] }).expect(201);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const rep = (await http().get('/v1/reports/promotions').query({ branchId: s.b1, from: today, to: today }).set(s.auth).expect(200)).body.data;
    expect(rep.map((r: { promotionId: string; salesCount: number; netQuantity: string; discount: string; netSales: string }) => [r.promotionId, r.salesCount, r.netQuantity, r.discount, r.netSales]))
      .toEqual([[p.socks.id, 1, '6', '100.00', '200.00']]);
  });
});
