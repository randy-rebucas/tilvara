import type { INestApplication } from '@nestjs/common';
import type { OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { expiryAlertMail } from '@1pos/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Expiry lots (ADR-0020 §3): dates come in with receipts and adjustments; every movement keeps the
 * lots through the trigger (undated stock first, then first-expiry-first); expired lots are written
 * off by name; the worker's hourly pass flags lots entering the branch's window once.
 */
let app: INestApplication;
let owner: pg.Pool;
let workerPool: pg.Pool;
/** The API's own role (onepos_app). */
let runtime: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
  runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await workerPool.end();
  await runtime.end();
});

/** A date `days` from today in Manila (the branches' default timezone). */
const day = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

async function store(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Store`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const branch2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body as { id: string; variants: { id: string }[] };
  const supplierId = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP', name: 'Distributor' }).expect(201)).body.id as string;
  const sessionId = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, userId: t.userId, auth, branchId, registerId, branch2, product, supplierId, sessionId };
}
type Store = Awaited<ReturnType<typeof store>>;

const receive = (s: Store, lines: Record<string, unknown>[]) =>
  http().post('/v1/goods-receipts').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, supplierId: s.supplierId, lines });
const adjust = (s: Store, kind: 'ADJUSTMENT' | 'WASTE', items: Record<string, unknown>[], reason = 'Shelf') =>
  http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, kind, reason, items });
const sell = (s: Store, lines: { variantId: string; quantity: string }[]) =>
  http().post('/v1/sales').set(s.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: s.sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '1000.00' }] });
const lots = async (s: Store, variantId: string, branchId = s.branchId) =>
  (await http().get('/v1/stock/lots').query({ branchId, variantId }).set(s.auth).expect(200)).body as { data: { lotId: string; expiresOn: string; lotCode: string | null; quantity: string }[]; onHand: string; undated: string };
/** An offline cash sale (ADR-0015) by the owner on R1's terminal, priced as the till's snapshot prices it (the quote then). */
async function offlineSale(s: Store, lines: { variantId: string; quantity: string }[]) {
  const t = (await http().post('/v1/terminals').set(s.auth).send({ registerId: s.registerId, name: `Till ${randomUUID().slice(0, 4)}` }).expect(201)).body;
  const headers = { 'x-terminal-id': t.terminal.id, Authorization: `Terminal ${t.credential}` };
  const snap = (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
  const amountDue = (await http().post('/v1/tax/quote').set(s.auth).send({ branchId: s.branchId, lines }).expect(200)).body.totals.amountDue as string;
  const env: OfflineSale = {
    terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: s.sessionId, cashierUserId: s.userId,
    occurredAt: new Date().toISOString(), localReference: `R1-T${snap.terminal.credentialHint}-000001`,
    lines, tenders: [{ method: 'CASH', tendered: '1000.00' }], amountDue,
  };
  return (await http().post('/v1/sync/sales').set(headers).send({ sales: [env] }).expect(200)).body.results[0] as { status: string; code?: string; saleId: string; flags: string[] };
}
const settings = (s: Store) => http().get(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).expect(200).then((r) => r.body);
const brief = (l: Awaited<ReturnType<typeof lots>>) => [l.data.map((x) => [x.expiresOn, x.quantity]), l.undated];

describe('expiry lots', () => {
  it('come in with receipts, go out undated first then first-expiry-first, and come back where they were sold from', async () => {
    const s = await store('lot-flow');
    const sardines = (await s.product('Sardines 155g', '28.00', { tracksExpiry: true })).variants[0]!.id;
    const soon = day(10);
    const later = day(200);
    // An item that keeps dates is refused without one; two lines, two dates.
    expect((await receive(s, [{ variantId: sardines, quantity: '10', unitCost: '20.00' }]).expect(422)).body.error.code).toBe('EXPIRY_DATE_REQUIRED');
    const received = (await receive(s, [
      { variantId: sardines, quantity: '5', unitCost: '20.00', expiresOn: later, lotCode: 'L-2' },
      { variantId: sardines, quantity: '10', unitCost: '20.00', expiresOn: soon },
    ]).expect(201)).body;
    expect(brief(await lots(s, sardines))).toEqual([[[soon, '10'], [later, '5']], '0']);
    // The receipt shows the dates and lots it came in with; an order says which lines need a date.
    const receipt = (await http().get(`/v1/goods-receipts/${received.id}`).set(s.auth).expect(200)).body as { lines: { expiresOn: string | null; lotCode: string | null }[] };
    expect(receipt.lines.map((l) => [l.expiresOn, l.lotCode]).sort()).toEqual([[later, 'L-2'], [soon, null]].sort());
    const soap = (await s.product('Soap 90g', '30.00')).variants[0]!.id;
    const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.branchId, supplierId: s.supplierId, lines: [{ variantId: sardines, quantity: '1', unitCost: '20.00' }, { variantId: soap, quantity: '1', unitCost: '20.00' }] }).expect(201)).body;
    const order = (await http().get(`/v1/purchase-orders/${po.id}`).set(s.auth).expect(200)).body as { lines: { tracksExpiry: boolean }[] };
    expect(order.lines.map((l) => l.tracksExpiry)).toEqual([true, false]);

    // Two lines of the same item in one sale: the soonest lot gives 3 + 1.
    const sale = (await sell(s, [{ variantId: sardines, quantity: '3' }, { variantId: sardines, quantity: '1' }]).expect(201)).body;
    expect(brief(await lots(s, sardines))).toEqual([[[soon, '6'], [later, '5']], '0']);
    const draws = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      (await c.query(`SELECT trim_scale(-lm.quantity)::text AS q FROM stock_lot_movements lm JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1 ORDER BY m.quantity`, [sale.id])).rows.map((r) => r.q));
    expect(draws).toEqual(['3', '1']);

    // Undated stock (a found carton) goes first.
    await adjust(s, 'ADJUSTMENT', [{ variantId: sardines, quantity: '4', unitCost: '20.00' }]).expect(201);
    expect(brief(await lots(s, sardines))).toEqual([[[soon, '6'], [later, '5']], '4']);
    await sell(s, [{ variantId: sardines, quantity: '5' }]).expect(201);
    expect(brief(await lots(s, sardines))).toEqual([[[soon, '5'], [later, '5']], '0']);

    // A return goes back to the lot its sale drew from.
    const line = sale.lines[0].id as string;
    await http().post(`/v1/sales/${sale.id}/returns`).set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.sessionId, kind: 'RETURN', reason: 'Changed mind', lines: [{ saleLineId: line, quantity: '2', disposition: 'RESTOCK' }] }).expect(201);
    expect(brief(await lots(s, sardines))).toEqual([[[soon, '7'], [later, '5']], '0']);

    // A transfer takes the soonest and arrives with the same dates.
    const tr = (await http().post('/v1/stock/transfers').set(s.auth).set('Idempotency-Key', randomUUID()).send({ fromBranchId: s.branchId, toBranchId: s.branch2, lines: [{ variantId: sardines, quantity: '9' }] }).expect(201)).body;
    await http().post(`/v1/stock/transfers/${tr.id}/receive`).set(s.auth).set('Idempotency-Key', randomUUID()).send({}).expect(200);
    expect(brief(await lots(s, sardines))).toEqual([[[later, '3']], '0']);
    expect((await lots(s, sardines, s.branch2)).data.map((x) => [x.expiresOn, x.lotCode, x.quantity])).toEqual([[soon, null, '7'], [later, 'L-2', '2']]);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('expired lots are listed and written off by name; a lot of another item is refused', async () => {
    const s = await store('lot-waste');
    const milk = (await s.product('Milk 1L', '95.00', { tracksExpiry: true })).variants[0]!.id;
    const bread = (await s.product('Bread', '60.00', { tracksExpiry: true })).variants[0]!.id;
    await adjust(s, 'ADJUSTMENT', [
      { variantId: milk, quantity: '6', unitCost: '70.00', expiresOn: day(-2) },
      { variantId: milk, quantity: '4', unitCost: '70.00', expiresOn: day(5) },
      { variantId: milk, quantity: '3', unitCost: '70.00' },
      { variantId: bread, quantity: '2', unitCost: '40.00', expiresOn: day(90) },
    ], 'Delivery').expect(201);
    const expiring = (await http().get('/v1/stock/expiring').query({ branchId: s.branchId, withinDays: 7 }).set(s.auth).expect(200)).body;
    expect(expiring.data.map((x: { name: string; quantity: string; daysLeft: number; value: string }) => [x.name, x.quantity, x.daysLeft, x.value])).toEqual([
      ['Milk 1L', '6', -2, '420.00'],
      ['Milk 1L', '4', 5, '280.00'],
    ]);
    expect(expiring.expired).toEqual({ lots: 1, value: '420.00' });
    const expired = expiring.data[0].lotId as string;

    // Writing off the expired lot takes it, not the undated three.
    await adjust(s, 'WASTE', [{ variantId: milk, quantity: '-6', lotId: expired }], 'Expired').expect(201);
    expect(brief(await lots(s, milk))).toEqual([[[day(5), '4']], '3']);
    expect((await adjust(s, 'WASTE', [{ variantId: bread, quantity: '-1', lotId: expired }], 'Expired').expect(422)).body.error.code).toBe('INVALID_STATE');
    expect((await adjust(s, 'ADJUSTMENT', [{ variantId: milk, quantity: '1', lotId: expired }]).expect(400)).body.error.code).toBe('VALIDATION_FAILED');

    // One item twice in one adjustment (audit 2026-10-21): each movement reaches the lot trigger on its own,
    // so 4 dated in then 3 out leaves 1 of that date (not the dates computed from the final balance).
    const yoghurt = (await s.product('Yoghurt', '45.00', { tracksExpiry: true })).variants[0]!.id;
    await adjust(s, 'ADJUSTMENT', [
      { variantId: yoghurt, quantity: '4', unitCost: '30.00', expiresOn: day(30) },
      { variantId: yoghurt, quantity: '-3' },
    ], 'Delivery, three spoiled').expect(201);
    expect(brief(await lots(s, yoghurt))).toEqual([[[day(30), '1']], '0']);

    // The app reads lots and never writes them.
    await expect(runtime.query(`UPDATE stock_lots SET quantity = 99`)).rejects.toThrow(/permission denied/);
    await expect(runtime.query(`INSERT INTO stock_lot_movements (tenant_id, lot_id, movement_id, quantity) VALUES ('${s.tenantId}', '${expired}', '${expired}', 1)`)).rejects.toThrow(/permission denied/);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('the product form turns expiry dates on and off; only for counted stock', async () => {
    const s = await store('lot-flag');
    const soap = await s.product('Laundry soap', '35.00');
    const r = await http().patch(`/v1/products/${soap.id}`).set(s.auth).send({ name: 'Laundry soap bar', trackInventory: true, tracksExpiry: true }).expect(200);
    expect(r.body).toMatchObject({ name: 'Laundry soap bar', tracksExpiry: true });
    expect((await http().patch(`/v1/products/${soap.id}`).set(s.auth).send({ trackInventory: false }).expect(422)).body.error.code).toBe('EXPIRY_NEEDS_STOCK');
    await http().patch(`/v1/products/${soap.id}`).set(s.auth).send({ trackInventory: false, tracksExpiry: false }).expect(200);
    const { uomId, taxCategoryId } = (await http().get(`/v1/products/${soap.id}`).set(s.auth).expect(200)).body;
    const fee = { name: 'Fee', uomId, taxCategoryId, trackInventory: false, tracksExpiry: true, variants: [{ sku: uniq('FEE') }] };
    expect((await http().post('/v1/products').set(s.auth).send(fee).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
  });

  it('pieces from an opened pack take the pack’s dates', async () => {
    const s = await store('lot-pack');
    const tie = (await s.product('Coffee (tie of 10)', '85.00', { tracksExpiry: true })).variants[0]!.id;
    const sachet = (await s.product('Coffee sachet', '9.00', { tracksExpiry: true })).variants[0]!.id;
    await http().post('/v1/pack-conversions').set(s.auth).send({ packVariantId: tie, pieceVariantId: sachet, piecesPerPack: '10' }).expect(201);
    await adjust(s, 'ADJUSTMENT', [{ variantId: tie, quantity: '2', unitCost: '70.00', expiresOn: day(60) }]).expect(201);
    await sell(s, [{ variantId: sachet, quantity: '3' }]).expect(201);
    expect(brief(await lots(s, sachet))).toEqual([[[day(60), '7']], '0']);
    expect(brief(await lots(s, tie))).toEqual([[[day(60), '1']], '0']);
  });

  it('no setting means ALLOW (0112); a branch set to BLOCK refuses an online sale of expired stock; an offline one is recorded and flagged EXPIRED_STOCK (audit 2026-10-21)', async () => {
    {
      const s = await store('lot-off-retail');
      const milk = (await s.product('Milk 1L', '95.00', { tracksExpiry: true })).variants[0]!.id;
      expect(await settings(s)).toMatchObject({ expiredStock: null, expiredStockRule: 'ALLOW' });
      await adjust(s, 'ADJUSTMENT', [{ variantId: milk, quantity: '4', unitCost: '70.00', expiresOn: day(-2), lotCode: 'M1' }], 'Delivery').expect(201);
      // No setting: expired stock sells online like any other (the draw is marked expired, nothing is mailed).
      const allowed = (await sell(s, [{ variantId: milk, quantity: '1' }]).expect(201)).body;
      const marked = await asOwnerInTenant(owner, s.tenantId, async (c) =>
        (await c.query(`SELECT bool_or(lm.expired) AS e FROM stock_lot_movements lm JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1`, [allowed.id])).rows[0].e);
      expect(marked).toBe(true);
      expect(await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT 1 FROM outbox_events WHERE topic = 'stock.expired_sold'`)).rows)).toEqual([]);
      await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'BLOCK' }).expect(200);
      expect(await settings(s)).toMatchObject({ expiredStock: 'BLOCK', expiredStockRule: 'BLOCK' });
      expect((await sell(s, [{ variantId: milk, quantity: '1' }]).expect(409)).body.error.code).toBe('EXPIRED_STOCK');

      // The till sold it while offline: the milk was handed over, so the sale is recorded and the draw flagged.
      const r = await offlineSale(s, [{ variantId: milk, quantity: '2' }]);
      expect([r.status, r.flags]).toEqual(['RECORDED', []]);
      const draws = await asOwnerInTenant(owner, s.tenantId, async (c) =>
        (await c.query(`SELECT trim_scale(-lm.quantity)::text AS q, lm.expired FROM stock_lot_movements lm JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1`, [r.saleId])).rows);
      expect(draws).toEqual([{ q: '2', expired: true }]);
      const delivered = (await http().get('/v1/sync/transactions?status=RECORDED').set(s.auth).expect(200)).body.data;
      expect(delivered.map((d: { saleId: string; flags: string[] }) => [d.saleId, d.flags])).toEqual([[r.saleId, ['EXPIRED_STOCK']]]);
      const [audit] = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT metadata FROM audit_logs WHERE action = 'sale.completed' AND resource_id = $1`, [r.saleId])).rows);
      expect(audit.metadata.expiredStockLots).toBe(1);
      expect(brief(await lots(s, milk))).toEqual([[[day(-2), '1']], '0']);
      expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
    }
  });

  it('a branch set to BLOCK draws the sellable lot first, in the API and the lot trigger (migrations 0108, 0112)', async () => {
    const s = await store('lot-block');
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'BLOCK' }).expect(200);
    expect(await settings(s)).toMatchObject({ expiredStock: 'BLOCK', expiredStockRule: 'BLOCK' });
    const milk = (await s.product('Milk 1L', '95.00', { tracksExpiry: true })).variants[0]!.id;
    await adjust(s, 'ADJUSTMENT', [
      { variantId: milk, quantity: '2', unitCost: '70.00', expiresOn: day(-2) },
      { variantId: milk, quantity: '2', unitCost: '70.00', expiresOn: day(5) },
    ], 'Delivery').expect(201);
    // The trigger draws the sellable lot first (first-expiry-first would take the expired one).
    const sale = (await sell(s, [{ variantId: milk, quantity: '2' }]).expect(201)).body;
    expect(brief(await lots(s, milk))).toEqual([[[day(-2), '2']], '0']);
    const expired = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      (await c.query(`SELECT bool_or(lm.expired) AS e FROM stock_lot_movements lm JOIN stock_movements m ON m.id = lm.movement_id WHERE m.sale_id = $1`, [sale.id])).rows[0].e);
    expect(expired).toBe(false);
    // Only expired stock left: refused.
    expect((await sell(s, [{ variantId: milk, quantity: '1' }]).expect(409)).body.error.code).toBe('EXPIRED_STOCK');
    // The branch may allow it.
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiredStock: 'ALLOW' }).expect(200);
    await sell(s, [{ variantId: milk, quantity: '1' }]).expect(201);
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('the hourly pass flags each lot once when it enters the window, and the mail lists them', async () => {
    const s = await store('lot-alert');
    const yogurt = (await s.product('Yogurt', '45.00', { tracksExpiry: true })).variants[0]!.id;
    await http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).send({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, expiryAlertDays: 7 }).expect(200);
    expect((await http().get(`/v1/branches/${s.branchId}/inventory-settings`).set(s.auth).expect(200)).body.expiryAlertDays).toBe(7);
    await adjust(s, 'ADJUSTMENT', [
      { variantId: yogurt, quantity: '5', unitCost: '30.00', expiresOn: day(3), lotCode: 'Y1' },
      { variantId: yogurt, quantity: '5', unitCost: '30.00', expiresOn: day(30), lotCode: 'Y2' },
    ]).expect(201);
    // The app may not run the pass; the worker may.
    await expect(runtime.query('SELECT platform_flag_expiring_lots()')).rejects.toThrow(/permission denied/);
    await workerPool.query('SELECT platform_flag_expiring_lots()');
    const events = () =>
      asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT payload FROM outbox_events WHERE topic = 'stock.expiring'`)).rows.map((r) => r.payload));
    expect(await events()).toEqual([{ branchId: s.branchId, lots: 1, firstExpiresOn: day(3), withinDays: 7 }]);
    await workerPool.query('SELECT platform_flag_expiring_lots()');
    expect(await events()).toHaveLength(1);

    const mail = await asOwnerInTenant(owner, s.tenantId, (c) => expiryAlertMail(c, { branchId: s.branchId, withinDays: 7 }));
    expect(mail!.subject).toBe('Expiring stock at One');
    expect(mail!.text).toContain('Yogurt');
    expect(mail!.text).toContain('lot Y1: 5, expires');
    expect(mail!.text).not.toContain('Y2');
  });
});
