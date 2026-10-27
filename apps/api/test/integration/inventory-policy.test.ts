import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { stockAlertMail, stockKeepers, withTenant } from '@1pos/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Session 16 (ADR-0012 amendment): the per-branch negative-stock policy, low-stock and below-zero
 * alerts written by the costing trigger, and count sheets (freeze, blind counting, post later).
 */
let app: INestApplication;
let owner: pg.Pool;
/** The worker's role (onepos_worker): what the stock alert handler reads, under RLS. */
let workerPool: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await workerPool.end();
});

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter 1' }).expect(201)).body.id as string;
  const register2 = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R2', name: 'Counter 2' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price = '20.00', extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const c2 = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  return {
    tenantId: t.tenantId,
    auth,
    branchId,
    registerId,
    register2,
    product,
    cashier: bearer(await loginToken(app, c.email)),
    cashier2: bearer(await loginToken(app, c2.email)),
    manager: bearer(await loginToken(app, m.email)),
    managerEmail: m.email,
    ownerEmail: t.email,
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const stockIn = (s: Shop, variantId: string, quantity: string) =>
  http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, reason: 'Delivery', items: [{ variantId, quantity, unitCost: '10.00' }] }).expect(201);
const openSession = async (s: Shop, auth: Auth = s.cashier, registerId = s.registerId) =>
  (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
const sell = (s: Shop, sessionId: string, lines: { variantId: string; quantity: string }[], auth: Auth = s.cashier) =>
  http()
    .post('/v1/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '1000.00' }] });
const onHand = async (s: Shop, variantId: string) =>
  ((await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.auth).expect(200)).body.data[0]?.quantity as string | undefined) ?? '0';
const setPolicy = (s: Shop, negativeStockPolicy: string, lowStockAlerts = true, auth: Auth = s.auth) =>
  http().put(`/v1/branches/${s.branchId}/inventory-settings`).set(auth).send({ negativeStockPolicy, lowStockAlerts });
const events = (s: Shop, topic: string) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query<{ payload: Record<string, string> }>(`SELECT payload FROM outbox_events WHERE topic = $1 ORDER BY created_at, id`, [topic])).rows.map((r) => r.payload));
const count = (s: Shop, sql: string) => asOwnerInTenant(owner, s.tenantId, async (c) => Number((await c.query(sql)).rows[0].n));

describe('negative-stock policy (per branch)', () => {
  it('defaults to ALLOW; only org.manage changes it; every change is audited', async () => {
    const s = await shop('neg-settings');
    expect((await http().get(`/v1/branches/${s.branchId}/inventory-settings`).set(s.manager).expect(200)).body).toMatchObject({ negativeStockPolicy: 'ALLOW', lowStockAlerts: true, updatedAt: null });
    await setPolicy(s, 'BLOCK', true, s.manager).expect(403);
    await setPolicy(s, 'SOMETIMES').expect(400);
    expect((await setPolicy(s, 'BLOCK', false).expect(200)).body).toMatchObject({ negativeStockPolicy: 'BLOCK', lowStockAlerts: false });
    expect((await http().get(`/v1/branches/${s.branchId}/inventory-settings`).set(s.cashier).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect(await count(s, `SELECT count(*) AS n FROM audit_logs WHERE action = 'inventory.settings_updated'`)).toBe(1);
  });

  it('BLOCK refuses a counter sale that would go below zero, writing nothing, and names the item', async () => {
    const s = await shop('neg-block');
    const cola = await s.product('Cola');
    const chips = await s.product('Chips');
    await stockIn(s, cola, '2');
    await stockIn(s, chips, '5');
    await setPolicy(s, 'BLOCK').expect(200);
    const session = await openSession(s);
    // Two lines of the same item add up: 1 + 2 > 2 on hand.
    const r = await sell(s, session, [{ variantId: cola, quantity: '1' }, { variantId: chips, quantity: '1' }, { variantId: cola, quantity: '2' }]).expect(409);
    expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { lines: [{ variantId: cola, name: 'Cola', onHand: '2', requested: '3' }] } });
    expect(r.body.error.message).toContain('Cola (2 on hand)');
    expect(await count(s, `SELECT count(*) AS n FROM sales`)).toBe(0);
    expect(await onHand(s, cola)).toBe('2');
    // Never stocked here: nothing on hand.
    const gum = await s.product('Gum');
    expect((await sell(s, session, [{ variantId: gum, quantity: '1' }]).expect(409)).body.error.details.lines[0]).toMatchObject({ onHand: '0', requested: '1' });
    // Exactly what is on hand is fine.
    await sell(s, session, [{ variantId: cola, quantity: '2' }]).expect(201);
    expect(await onHand(s, cola)).toBe('0');
  });

  it('BLOCK: two tills selling the last unit at once, one sale goes through', async () => {
    const s = await shop('neg-race');
    const cola = await s.product('Cola');
    await stockIn(s, cola, '1');
    await setPolicy(s, 'BLOCK').expect(200);
    const a = await openSession(s, s.cashier, s.registerId);
    const b = await openSession(s, s.cashier2, s.register2);
    for (let round = 0; round < 3; round++) {
      const [x, y] = await Promise.all([sell(s, a, [{ variantId: cola, quantity: '1' }], s.cashier), sell(s, b, [{ variantId: cola, quantity: '1' }], s.cashier2)]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect(await onHand(s, cola)).toBe('0');
      await stockIn(s, cola, '1');
    }
  });

  it('ALLOW_WITH_FLAG sells below zero, marks the movement and raises one alert per crossing; ALLOW stays quiet', async () => {
    const s = await shop('neg-flag');
    const cola = await s.product('Cola');
    await stockIn(s, cola, '1');
    const session = await openSession(s);
    await sell(s, session, [{ variantId: cola, quantity: '2' }]).expect(201); // ALLOW: -1, no alert
    expect(await events(s, 'stock.below_zero')).toEqual([]);
    await stockIn(s, cola, '1'); // back to 0
    await setPolicy(s, 'ALLOW_WITH_FLAG').expect(200);
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201); // 0 → -1: crossing
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201); // -1 → -2: already below
    expect(await onHand(s, cola)).toBe('-2');
    expect(await events(s, 'stock.below_zero')).toEqual([expect.objectContaining({ branchId: s.branchId, variantId: cola, movementType: 'SALE', quantity: '-1.0000' })]);
    const flags = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT type, quantity::text, below_zero FROM stock_movements ORDER BY created_at, id`)).rows);
    expect(flags.map((m) => `${m.type} ${m.quantity} ${m.below_zero}`)).toEqual([
      'ADJUSTMENT 1.0000 false',
      'SALE -2.0000 true',
      'ADJUSTMENT 1.0000 false',
      'SALE -1.0000 true',
      'SALE -1.0000 true',
    ]);
  });
});

describe('low-stock alerts', () => {
  it('one event when a balance falls to its reorder point, again only after it recovers; off when switched off', async () => {
    const s = await shop('low-alert');
    const cola = await s.product('Cola');
    await stockIn(s, cola, '6');
    await http().put('/v1/stock/reorder-points').set(s.auth).send({ branchId: s.branchId, items: [{ variantId: cola, reorderPoint: '4', reorderQuantity: '12' }] }).expect(200);
    const session = await openSession(s);
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201); // 5: above
    expect(await events(s, 'stock.low')).toEqual([]);
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201); // 4: at the point
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201); // 3: still low, no new alert
    expect(await events(s, 'stock.low')).toEqual([{ branchId: s.branchId, variantId: cola, movementType: 'SALE', quantity: '4.0000', reorderPoint: '4.0000' }]);
    await stockIn(s, cola, '10'); // 13
    // A waste adjustment counts like a sale.
    await http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, kind: 'WASTE', reason: 'Dropped crate', items: [{ variantId: cola, quantity: '-10' }] }).expect(201);
    expect((await events(s, 'stock.low')).map((e) => [e.movementType, e.quantity])).toEqual([['SALE', '4.0000'], ['WASTE', '3.0000']]);
    await stockIn(s, cola, '10');
    await setPolicy(s, 'ALLOW', false).expect(200);
    await sell(s, session, [{ variantId: cola, quantity: '12' }]).expect(201);
    expect(await events(s, 'stock.low')).toHaveLength(2);
  });
});

describe('stock alert mail (what the worker sends)', () => {
  it('goes to whoever keeps stock at the branch: the owner and its manager, not the cashier nor another branch', async () => {
    const s = await shop('alert-mail');
    const cola = await s.product('Cola');
    await stockIn(s, cola, '3');
    await http().put('/v1/stock/reorder-points').set(s.auth).send({ branchId: s.branchId, items: [{ variantId: cola, reorderPoint: '2' }] }).expect(200);
    const le = (await http().get('/v1/legal-entities').set(s.auth).expect(200)).body.data[0].id as string;
    const other = (await http().post('/v1/branches').set(s.auth).send({ legalEntityId: le, code: 'B9', name: 'Elsewhere', birBranchCode: '00009' }).expect(201)).body.id as string;
    const elsewhere = await addMember(owner, s.tenantId, 'branch_manager', { type: 'BRANCH', id: other });
    const session = await openSession(s);
    await sell(s, session, [{ variantId: cola, quantity: '1' }]).expect(201);
    const [event] = await events(s, 'stock.low');
    const { keepers, mail } = await withTenant(workerPool, s.tenantId, async (_db, client) => ({
      keepers: (await stockKeepers(client, s.branchId)).map((k) => k.email),
      mail: await stockAlertMail(client, 'stock.low', event!),
    }));
    expect(keepers.sort()).toEqual([s.managerEmail, s.ownerEmail].sort());
    expect(keepers).not.toContain(elsewhere.email);
    expect(mail).toEqual({ subject: 'Low stock at One: Cola', text: expect.stringContaining('is down to 2.0000, at or below its reorder point of 2.0000') });
    // Another business's worker context sees neither the branch nor its people.
    const stranger = await signup(app, 'alert-stranger');
    expect(await withTenant(workerPool, stranger.tenantId, (_db, client) => stockKeepers(client, s.branchId))).toEqual([]);
    expect(await withTenant(workerPool, stranger.tenantId, (_db, client) => stockAlertMail(client, 'stock.low', event!))).toBeNull();
  });
});

describe('count sheets (blind counts)', () => {
  async function counter(s: Shop) {
    await http().post('/v1/roles').set(s.auth).send({ key: 'stock_counter', name: 'Stock counter', permissions: ['inventory.count'] }).expect(201);
    const m = await addMember(owner, s.tenantId, 'stock_counter', { type: 'BRANCH', id: s.branchId });
    return bearer(await loginToken(app, m.email));
  }

  it('freezes on hand, hides it from counters, and posts counted − frozen so sales during the count stay', async () => {
    const s = await shop('sheet');
    const cola = await s.product('Cola');
    const chips = await s.product('Chips');
    const gum = await s.product('Gum');
    await stockIn(s, cola, '10');
    await stockIn(s, chips, '4');
    const clerk = await counter(s);

    await http().post('/v1/stock/count-sheets').set(clerk).send({ branchId: s.branchId }).expect(403);
    const opened = (await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId, notes: 'Month end' }).expect(201)).body;
    expect(opened).toMatchObject({ status: 'OPEN', blind: true, expectedShown: true });
    expect(opened.lines.map((l: { name: string; expectedQuantity: string }) => [l.name, l.expectedQuantity]).sort()).toEqual([['Chips', '4'], ['Cola', '10']]);

    // The counter sees the items, never the frozen quantities.
    const blind = (await http().get(`/v1/stock/count-sheets/${opened.id}`).set(clerk).expect(200)).body;
    expect(blind.expectedShown).toBe(false);
    expect(JSON.stringify(blind.lines)).not.toMatch(/expectedQuantity|varianceQuantity|movedSinceFreeze/);

    // Two colas sell while people count (they were on the shelf at the freeze, so counted 9 means 1 missing).
    const session = await openSession(s);
    await sell(s, session, [{ variantId: cola, quantity: '2' }]).expect(201);
    const counted = (await http().put(`/v1/stock/count-sheets/${opened.id}/lines`).set(clerk).send({ lines: [{ variantId: cola, countedQuantity: '9' }, { variantId: gum, countedQuantity: '3' }] }).expect(200)).body;
    expect(counted.lines.find((l: { name: string }) => l.name === 'Gum')).toMatchObject({ countedQuantity: '3', countedBy: 'stock_counter' });
    expect(counted.expectedShown).toBe(false);
    const review = (await http().get(`/v1/stock/count-sheets/${opened.id}`).set(s.manager).expect(200)).body;
    expect(review.lines.find((l: { name: string }) => l.name === 'Cola')).toMatchObject({ expectedQuantity: '10', countedQuantity: '9', varianceQuantity: '-1', movedSinceFreeze: '-2' });
    // Gum was found though not on the sheet: frozen at on hand when added (0).
    expect(review.lines.find((l: { name: string }) => l.name === 'Gum')).toMatchObject({ expectedQuantity: '0', varianceQuantity: '3' });

    // Only an adjuster posts, and only with a key.
    await http().post(`/v1/stock/count-sheets/${opened.id}/post`).set(clerk).set('Idempotency-Key', randomUUID()).expect(403);
    await http().post(`/v1/stock/count-sheets/${opened.id}/post`).set(s.manager).expect(400);
    const key = randomUUID();
    const posted = (await http().post(`/v1/stock/count-sheets/${opened.id}/post`).set(s.manager).set('Idempotency-Key', key).expect(200)).body;
    expect(posted).toMatchObject({ uncounted: 1, sheet: { status: 'POSTED', stockCountId: posted.count.id } });
    expect(posted.count.lines.map((l: { name: string; systemQuantity: string; varianceQuantity: string; frozen: boolean }) => [l.name, l.systemQuantity, l.varianceQuantity, l.frozen]).sort()).toEqual([
      ['Cola', '10', '-1', true],
      ['Gum', '0', '3', true],
    ]);
    // 10 − 2 sold − 1 missing = 7; chips untouched (not counted); gum found.
    expect(await onHand(s, cola)).toBe('7');
    expect(await onHand(s, chips)).toBe('4');
    expect(await onHand(s, gum)).toBe('3');
    // A replay answers the same; the sheet is closed for counting and posting.
    expect((await http().post(`/v1/stock/count-sheets/${opened.id}/post`).set(s.manager).set('Idempotency-Key', key).expect(200)).body.count.id).toBe(posted.count.id);
    expect((await http().post(`/v1/stock/count-sheets/${opened.id}/post`).set(s.manager).set('Idempotency-Key', randomUUID()).expect(409)).body.error.code).toBe('COUNT_SHEET_CLOSED');
    expect((await http().put(`/v1/stock/count-sheets/${opened.id}/lines`).set(clerk).send({ lines: [{ variantId: cola, countedQuantity: '1' }] }).expect(409)).body.error.code).toBe('COUNT_SHEET_CLOSED');
    // Once posted, everyone who may see it sees the frozen numbers.
    expect((await http().get(`/v1/stock/count-sheets/${opened.id}`).set(clerk).expect(200)).body.expectedShown).toBe(true);
    // Books follow the stock (one entry for the count).
    expect(await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type = 'STOCK_COUNT' AND source_id = '${posted.count.id}'`)).toBe(1);
  });

  it('cancel needs a reason and leaves stock alone; a sheet that is not blind shows frozen numbers to counters; the database keeps closed sheets closed', async () => {
    const s = await shop('sheet-cancel');
    const cola = await s.product('Cola');
    await stockIn(s, cola, '5');
    const clerk = await counter(s);
    const open = (await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId, blind: false, variantIds: [cola] }).expect(201)).body;
    expect((await http().get(`/v1/stock/count-sheets/${open.id}`).set(clerk).expect(200)).body.lines[0]).toMatchObject({ expectedQuantity: '5' });
    await http().put(`/v1/stock/count-sheets/${open.id}/lines`).set(clerk).send({ lines: [{ variantId: cola, countedQuantity: '1' }] }).expect(200);
    await http().put(`/v1/stock/count-sheets/${open.id}/lines`).set(clerk).send({ lines: [{ variantId: cola, countedQuantity: null }] }).expect(200);
    expect((await http().post(`/v1/stock/count-sheets/${open.id}/post`).set(s.manager).set('Idempotency-Key', randomUUID()).expect(422)).body.error.code).toBe('NOTHING_COUNTED');
    await http().post(`/v1/stock/count-sheets/${open.id}/cancel`).set(s.manager).send({ reason: ' ' }).expect(400);
    expect((await http().post(`/v1/stock/count-sheets/${open.id}/cancel`).set(s.manager).send({ reason: 'Started too early' }).expect(200)).body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Started too early' });
    expect(await onHand(s, cola)).toBe('5');
    expect((await http().get('/v1/stock/count-sheets').query({ branchId: s.branchId }).set(clerk).expect(200)).body.data).toEqual([expect.objectContaining({ id: open.id, status: 'CANCELLED', lines: 1, counted: 0 })]);
    // DB backstop: no reopening, no counting on a closed sheet.
    for (const q of [`UPDATE stock_count_sheets SET status = 'OPEN', closed_at = NULL, closed_by = NULL, cancel_reason = NULL`, `UPDATE stock_count_sheet_lines SET counted_quantity = 2, counted_by = '${randomUUID()}', counted_at = now()`]) {
      const err = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(q)).then(() => null, (e: Error) => e.message);
      expect([q, err]).toEqual([q, expect.stringMatching(/cannot move|closed/)]);
    }
  });

  it('refusals: unstocked items, an empty branch, a cashier', async () => {
    const s = await shop('sheet-rules');
    const cola = await s.product('Cola');
    expect((await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId }).expect(422)).body.error.code).toBe('NOTHING_TO_COUNT');
    await http().post('/v1/stock/count-sheets').set(s.cashier).send({ branchId: s.branchId, variantIds: [cola] }).expect(403);
    const fee = await s.product('Fee', '5.00', { productType: 'SERVICE', trackInventory: false });
    expect((await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId, variantIds: [fee] }).expect(422)).body.error.code).toBe('NOT_STOCKED');
  });

  it('one open sheet per branch, and no quick count of an item on it (the change would post twice)', async () => {
    const s = await shop('sheet-once');
    const cola = await s.product('Cola');
    const chips = await s.product('Chips');
    await stockIn(s, cola, '10');
    await stockIn(s, chips, '4');
    const open = (await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId, variantIds: [cola] }).expect(201)).body;
    const [a, b] = await Promise.all([
      http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId }),
      http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId, variantIds: [chips] }),
    ]);
    expect([a.status, a.body.error?.code, b.status, b.body.error?.code]).toEqual([409, 'SHEET_OPEN', 409, 'SHEET_OPEN']);
    const refused = await http().post('/v1/stock/counts').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, lines: [{ variantId: cola, countedQuantity: '8' }] }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'ITEM_ON_OPEN_SHEET', details: { sheetId: open.id, variantIds: [cola] } });
    // An item not on the sheet is counted as before.
    await http().post('/v1/stock/counts').set(s.manager).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, lines: [{ variantId: chips, countedQuantity: '3' }] }).expect(201);
    await http().put(`/v1/stock/count-sheets/${open.id}/lines`).set(s.manager).send({ lines: [{ variantId: cola, countedQuantity: '8' }] }).expect(200);
    await http().post(`/v1/stock/count-sheets/${open.id}/post`).set(s.manager).set('Idempotency-Key', randomUUID()).expect(200);
    expect(await onHand(s, cola)).toBe('8');
    expect(await onHand(s, chips)).toBe('3');
    // Once it is posted, the next sheet may start.
    await http().post('/v1/stock/count-sheets').set(s.manager).send({ branchId: s.branchId }).expect(201);
  });
});
