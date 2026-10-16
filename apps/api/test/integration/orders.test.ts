import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Restaurant orders and the kitchen (ADR-0014 §6, §7 — Phase 4 slice 3). */
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

type Headers = { Authorization: string };

/**
 * A restaurant with a Grill (default) and a Bar, tables T1–T3, and a published menu:
 * Burger (recipe: bun + 0.15 kg beef; doneness required; extras: cheese slice ₱20 / no onions) → GRILL,
 * Iced tea (no recipe) → BAR. Stock: buns, beef, cheese slices.
 */
async function restaurant(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const branch2Id = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const uoms = (await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[];
  const uom = (c: string) => uoms.find((u) => u.code === c)!.id;
  const product = async (name: string, price: string, tracked: boolean, unit = 'PC') =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: uom(unit), taxCategoryId: vat, trackInventory: tracked, ...(unit === 'KG' && { soldBy: 'WEIGHT' }), variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const bun = await product('Bun', '10.00', true);
  const beef = await product('Ground beef', '500.00', true, 'KG');
  const cheese = await product('Cheese slice', '20.00', true);
  const burger = await product('Burger', '150.00', false);
  const tea = await product('Iced tea', '45.00', false);
  const offMenu = await product('Secret', '99.00', false);
  await http().post('/v1/stock/adjustments').set(auth).send({ branchId, reason: 'Opening', items: [
    { variantId: bun, quantity: '50', unitCost: '5.00' }, { variantId: beef, quantity: '5', unitCost: '400.00' }, { variantId: cheese, quantity: '40', unitCost: '3.00' },
  ] }).expect(201);
  await http().post(`/v1/variants/${burger}/recipe`).set(auth).send({ ingredients: [{ variantId: bun, quantity: '1' }, { variantId: beef, quantity: '0.15' }] }).expect(201);

  const grill = (await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'GRILL', name: 'Grill', isDefault: true }).expect(201)).body.id as string;
  const bar = (await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'BAR', name: 'Bar' }).expect(201)).body.id as string;
  const area = (await http().post('/v1/dining-areas').set(auth).send({ branchId, name: 'Hall' }).expect(201)).body.id as string;
  const table = async (code: string) => (await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area, code }).expect(201)).body.id as string;
  const [t1, t2, t3] = [await table('T1'), await table('T2'), await table('T3')];

  const doneness = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(auth).send({ name: 'All day' }).expect(201)).body;
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [
    { name: 'Mains', items: [{ variantId: burger, stationCode: 'GRILL', modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea, stationCode: 'BAR' }] },
  ] }).expect(200);
  await http().post(`/v1/menu-versions/${menu.draft.id}/publish`).set(auth).expect(200);
  for (const b of [branchId, branch2Id]) {
    await http().put(`/v1/branches/${b}/restaurant-settings`).set(auth).send({ dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }).expect(200);
  }
  const member = async (role: string, b = branchId) => bearer(await loginToken(app, (await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: b })).email));
  const opt = (g: { options: { id: string; name: string }[] }, name: string) => g.options.find((o) => o.name === name)!.id;
  return {
    tenantId: t.tenantId, auth, branchId, branch2Id, grill, bar, t1, t2, t3, bun, beef, cheese, burger, tea, offMenu,
    medium: opt(doneness, 'Medium'), wellDone: opt(doneness, 'Well done'), cheeseOpt: opt(extras, 'Cheese'), noOnions: opt(extras, 'No onions'),
    server: await member('cashier'), manager: await member('branch_manager'), otherServer: await member('cashier', branch2Id), inventory: await member('inventory_officer'),
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;

const open = (r: R, body: Record<string, unknown>, who: Headers = r.server) => http().post('/v1/restaurant/orders').set(who).send({ branchId: r.branchId, ...body });
const add = (r: R, orderId: string, items: unknown[], who: Headers = r.server, key: string = randomUUID()) =>
  http().post(`/v1/restaurant/orders/${orderId}/items`).set(who).set('Idempotency-Key', key).send({ items });
const fire = (r: R, orderId: string, body: Record<string, unknown> = {}, who: Headers = r.server) => http().post(`/v1/restaurant/orders/${orderId}/fire`).set(who).send(body);
const order = async (r: R, orderId: string) => (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body;
const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) => asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const code = (res: request.Response) => res.body.error?.code;
const balance = async (r: R, variantId: string) => (await http().get('/v1/stock/balances').query({ branchId: r.branchId, variantId }).set(r.auth).expect(200)).body.data[0].quantity as string;

describe('order taking', () => {
  it('opens one order per table, adds items with modifiers checked against the published menu, edits only what is pending', async () => {
    const r = await restaurant('ord-take');
    const o = (await open(r, { orderType: 'DINE_IN', tableId: r.t1, guestCount: 3 }).expect(201)).body;
    expect(o).toMatchObject({ orderNumber: 1, status: 'OPEN', table: { id: r.t1, code: 'T1' }, guestCount: 3, items: [] });
    const busy = await open(r, { orderType: 'DINE_IN', tableId: r.t1 }).expect(409);
    expect([code(busy), busy.body.error.details.orderId]).toEqual(['TABLE_OCCUPIED', o.id]);
    await open(r, { orderType: 'DINE_IN' }).expect(400);
    await open(r, { orderType: 'TAKEAWAY', tableId: r.t2 }).expect(400);
    await open(r, { orderType: 'DINE_IN', tableId: randomUUID() }).expect(404);

    // Menu rules.
    expect(code(await add(r, o.id, [{ variantId: r.burger, quantity: '1' }]).expect(422))).toBe('MODIFIER_COUNT'); // doneness required
    expect(code(await add(r, o.id, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.wellDone] }]).expect(422))).toBe('MODIFIER_COUNT');
    expect(code(await add(r, o.id, [{ variantId: r.tea, quantity: '1', modifierOptionIds: [r.medium] }]).expect(422))).toBe('MODIFIER_NOT_ALLOWED');
    expect(code(await add(r, o.id, [{ variantId: r.offMenu, quantity: '1' }]).expect(422))).toBe('NOT_ON_MENU');
    expect(code(await add(r, o.id, [{ variantId: r.tea, quantity: '1.5' }]).expect(422))).toBe('FRACTIONAL_QUANTITY');
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(r.auth).send({ variantId: r.tea, soldOut: true }).expect(200);
    expect(code(await add(r, o.id, [{ variantId: r.tea, quantity: '1' }]).expect(422))).toBe('SOLD_OUT');
    await http().put(`/v1/branches/${r.branchId}/sold-out`).set(r.auth).send({ variantId: r.tea, soldOut: false }).expect(200);
    expect(code(await http().post(`/v1/restaurant/orders/${o.id}/items`).set(r.server).send({ items: [{ variantId: r.tea, quantity: '1' }] }).expect(400))).toBe('IDEMPOTENCY_KEY_REQUIRED');

    // A retried add (same key) is replayed, not doubled.
    const key = randomUUID();
    const items = [
      { variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt, r.noOnions], seat: 1, note: 'Cut in half' },
      { variantId: r.tea, quantity: '2' },
      { variantId: r.burger, quantity: '1', course: 2, modifierOptionIds: [r.wellDone] },
    ];
    const first = (await add(r, o.id, items, r.server, key).expect(201)).body;
    await add(r, o.id, items, r.server, key).expect(201);
    const view = await order(r, o.id);
    expect(view.items).toHaveLength(3);
    expect(first.items[0]).toMatchObject({ name: 'Burger', quantity: '2', course: 1, seat: 1, note: 'Cut in half', status: 'PENDING', stationCode: 'GRILL' });
    expect(first.items[0].modifiers.map((m: { name: string; quantity: string; variantId: string | null }) => [m.name, m.quantity, m.variantId])).toEqual([
      ['Medium', '2', null], ['Cheese', '2', r.cheese], ['No onions', '2', null],
    ]);

    // Pending items can be changed (modifiers follow) or removed.
    const burger = view.items[0];
    const edited = (await http().patch(`/v1/order-items/${burger.id}`).set(r.server).send({ quantity: '3' }).expect(200)).body;
    expect(edited.items[0].modifiers.map((m: { quantity: string }) => m.quantity)).toEqual(['3', '3', '3']);
    await http().patch(`/v1/order-items/${burger.modifiers[0].id}`).set(r.server).send({ quantity: '1' }).expect(422); // a choice alone
    await http().post(`/v1/order-items/${view.items[2].id}/remove`).set(r.server).expect(200);
    expect((await order(r, o.id)).items).toHaveLength(2);

    // Access: same-branch floor staff; not other branches, not inventory.
    await http().get(`/v1/restaurant/orders/${o.id}`).set(r.otherServer).expect(403);
    await http().get('/v1/restaurant/orders').query({ branchId: r.branchId }).set(r.inventory).expect(403);
    const live = (await http().get('/v1/restaurant/orders').query({ branchId: r.branchId }).set(r.server).expect(200)).body.data;
    expect(live.map((x: { orderNumber: number; items: Record<string, number> }) => [x.orderNumber, x.items])).toEqual([[1, { PENDING: 2 }]]);
  });
});

describe('kitchen', () => {
  it('fires by course into one ticket per station; the KDS moves items forward; bump marks a ticket ready', async () => {
    const r = await restaurant('ord-kds');
    const o = (await open(r, { orderType: 'DINE_IN', tableId: r.t1 }).expect(201)).body;
    await add(r, o.id, [
      { variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] },
      { variantId: r.tea, quantity: '2' },
      { variantId: r.burger, quantity: '1', course: 2, modifierOptionIds: [r.wellDone] },
    ]).expect(201);

    const f1 = (await fire(r, o.id, { courses: [1] }).expect(200)).body;
    expect(f1.fired.map((t: { stationId: string; course: number; items: number }) => [t.stationId, t.course, t.items]).sort()).toEqual([[r.bar, 1, 1], [r.grill, 1, 1]].sort());
    expect((await fire(r, o.id, { courses: [1] }).expect(200)).body.fired).toEqual([]); // nothing pending in course 1: no-op
    const course2 = (await order(r, o.id)).items.find((i: { course: number }) => i.course === 2);
    expect(course2.status).toBe('PENDING');
    // Fired items are frozen: no edits, no removal.
    const firstBurger = (await order(r, o.id)).items[0];
    expect(firstBurger.modifiers.every((m: { status: string }) => m.status === 'FIRED')).toBe(true);
    expect(code(await http().patch(`/v1/order-items/${firstBurger.id}`).set(r.server).send({ quantity: '1' }).expect(409))).toBe('ITEM_FIRED');
    expect(code(await http().post(`/v1/order-items/${firstBurger.id}/remove`).set(r.server).expect(409))).toBe('ITEM_FIRED');

    const kds = (await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId, stationId: r.grill }).set(r.manager).expect(200)).body.data;
    expect(kds).toHaveLength(1);
    expect(kds[0]).toMatchObject({ course: 1, station: { code: 'GRILL' }, order: { orderNumber: 1, tableCode: 'T1', orderType: 'DINE_IN' } });
    expect(kds[0].items.map((i: { name: string; quantity: string; modifiers: { name: string }[] }) => [i.name, i.quantity, i.modifiers.map((m) => m.name)])).toEqual([['Burger', '2', ['Medium', 'Cheese']]]);

    const status = (itemId: string, s: string, who: Headers) => http().post(`/v1/order-items/${itemId}/status`).set(who).send({ status: s });
    await status(firstBurger.id, 'IN_PREP', r.server).expect(403); // the floor cannot claim prep
    expect((await status(firstBurger.id, 'IN_PREP', r.manager).expect(200)).body.status).toBe('IN_PREP');
    await http().post(`/v1/kitchen/tickets/${kds[0].id}/bump`).set(r.manager).expect(200);
    expect(code(await status(firstBurger.id, 'IN_PREP', r.manager).expect(409))).toBe('INVALID_TRANSITION'); // never backwards
    expect((await status(firstBurger.id, 'SERVED', r.server).expect(200)).body.status).toBe('SERVED'); // the floor serves
    expect(code(await status(course2.id, 'READY', r.manager).expect(409))).toBe('INVALID_TRANSITION'); // not fired yet
    expect((await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId, stationId: r.grill }).set(r.manager).expect(200)).body.data).toEqual([]);

    const f2 = (await fire(r, o.id).expect(200)).body;
    expect(f2.fired.map((t: { stationId: string; course: number }) => [t.stationId, t.course])).toEqual([[r.grill, 2]]);
    const view = await order(r, o.id);
    const served = view.items[0];
    expect([served.status, served.modifiers.map((m: { status: string }) => m.status)]).toEqual(['SERVED', ['SERVED', 'SERVED']]);
    expect(view.tickets.map((t: { ticketNumber: number }) => t.ticketNumber).sort()).toEqual([1, 2, 3]);

    // A branch without any station cannot fire.
    const away = (await open(r, { branchId: r.branch2Id, orderType: 'TAKEAWAY', customerName: 'Ana' }, r.otherServer).expect(201)).body;
    await add(r, away.id, [{ variantId: r.tea, quantity: '1' }], r.otherServer).expect(201);
    expect(code(await fire(r, away.id, {}, r.otherServer).expect(422))).toBe('NO_KITCHEN_STATION');
  });

  it('voids: pending items are removed, fired items need sales.void; a wasted void writes its stock off as one WASTE document', async () => {
    const r = await restaurant('ord-void');
    const o = (await open(r, { orderType: 'DINE_IN', tableId: r.t1 }).expect(201)).body;
    await add(r, o.id, [{ variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] }, { variantId: r.tea, quantity: '1' }]).expect(201);
    const pendingView = await order(r, o.id);
    expect(code(await http().post(`/v1/order-items/${pendingView.items[0].id}/void`).set(r.manager).set('Idempotency-Key', randomUUID()).send({ reason: 'x' }).expect(409))).toBe('ITEM_NOT_FIRED');
    await fire(r, o.id).expect(200);
    const [burger, tea] = (await order(r, o.id)).items;
    const voidItem = (itemId: string, body: Record<string, unknown>, who: Headers) => http().post(`/v1/order-items/${itemId}/void`).set(who).set('Idempotency-Key', randomUUID()).send(body);

    await voidItem(burger.id, { reason: 'Dropped', wasted: true }, r.server).expect(403); // cashiers cannot void
    const before = { bun: await balance(r, r.bun), beef: await balance(r, r.beef), cheese: await balance(r, r.cheese) };
    const after = (await voidItem(burger.id, { reason: 'Dropped on the floor', wasted: true }, r.manager).expect(200)).body;
    const voided = after.items[0];
    expect([voided.status, voided.voidReason, voided.modifiers.map((m: { status: string }) => m.status)]).toEqual(['VOIDED', 'Dropped on the floor', ['VOIDED', 'VOIDED']]);
    expect(voided.wasteAdjustmentId).toBeTruthy();
    // 2 burgers: 2 buns + 0.3 kg beef from the recipe, and the 2 tracked cheese slices themselves.
    expect([await balance(r, r.bun), await balance(r, r.beef), await balance(r, r.cheese)]).toEqual([
      String(Number(before.bun) - 2), String(Number(before.beef) - 0.3), String(Number(before.cheese) - 2),
    ]);
    const doc = (await http().get(`/v1/stock/adjustments/${voided.wasteAdjustmentId}`).set(r.auth).expect(200)).body;
    expect(doc).toMatchObject({ kind: 'WASTE' });
    expect(doc.reason).toMatch(/Voided after firing \(order #1\): Dropped on the floor/);
    const gl = await sql<{ system_key: string; net: string }>(r, `
      SELECT a.system_key, sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'STOCK_ADJUSTMENT' AND e.source_id = $1 GROUP BY 1 ORDER BY 1`, [voided.wasteAdjustmentId]);
    expect(gl).toEqual([{ system_key: 'INVENTORY', net: '-136.0000' }, { system_key: 'INVENTORY_WASTE', net: '136.0000' }]); // 10 + 120 + 6

    expect(code(await voidItem(burger.id, { reason: 'again' }, r.manager).expect(409))).toBe('ALREADY_VOIDED');
    const teaVoid = (await voidItem(tea.id, { reason: 'Customer changed mind' }, r.manager).expect(200)).body.items[1];
    expect([teaVoid.status, teaVoid.wasteAdjustmentId]).toEqual(['VOIDED', null]);
    expect(await sql(r, `SELECT count(*)::int AS n FROM stock_adjustments WHERE kind = 'WASTE'`)).toEqual([{ n: 1 }]);
    expect(await asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
    // Everything voided: the order can be cancelled now.
    expect((await http().post(`/v1/restaurant/orders/${o.id}/cancel`).set(r.server).send({ reason: 'Walked out' }).expect(200)).body.status).toBe('CANCELLED');
  });
});

describe('moving people and food', () => {
  it('transfer, merge, move items to another order or a new table; cancel an order nothing was cooked for', async () => {
    const r = await restaurant('ord-move');
    const a = (await open(r, { orderType: 'DINE_IN', tableId: r.t1 }).expect(201)).body;
    const b = (await open(r, { orderType: 'DINE_IN', tableId: r.t2 }).expect(201)).body;
    await add(r, a.id, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.cheeseOpt] }, { variantId: r.tea, quantity: '1' }]).expect(201);
    await add(r, b.id, [{ variantId: r.tea, quantity: '2' }]).expect(201);
    await fire(r, a.id).expect(200);

    expect(code(await http().post(`/v1/restaurant/orders/${a.id}/transfer`).set(r.server).send({ tableId: r.t2 }).expect(409))).toBe('TABLE_OCCUPIED');
    expect((await http().post(`/v1/restaurant/orders/${a.id}/transfer`).set(r.server).send({ tableId: r.t3 }).expect(200)).body.table.code).toBe('T3');

    // B joins A: every item moves, B closes as MERGED and frees T2.
    const merged = (await http().post(`/v1/restaurant/orders/${b.id}/merge`).set(r.server).send({ intoOrderId: a.id }).expect(200)).body;
    expect(merged.items.map((i: { name: string }) => i.name)).toEqual(['Burger', 'Iced tea', 'Iced tea']);
    expect((await order(r, b.id))).toMatchObject({ status: 'MERGED', mergedIntoId: a.id });
    expect(code(await http().post(`/v1/restaurant/orders/${b.id}/merge`).set(r.server).send({ intoOrderId: a.id }).expect(409))).toBe('ORDER_NOT_OPEN');
    expect(code(await http().post(`/v1/restaurant/orders/${a.id}/merge`).set(r.server).send({ intoOrderId: a.id }).expect(422))).toBe('SAME_ORDER');

    // Part of the party moves to T2: the burger (fired, with its choices) goes along.
    const burger = merged.items[0];
    const moved = (await http().post(`/v1/restaurant/orders/${a.id}/move-items`).set(r.server).send({ itemIds: [burger.id], toTableId: r.t2 }).expect(200)).body;
    expect([moved.to.table.code, moved.to.items.map((i: { name: string; status: string; modifiers: unknown[] }) => [i.name, i.status, i.modifiers.length])]).toEqual(['T2', [['Burger', 'FIRED', 2]]]);
    expect(moved.from.items.map((i: { name: string }) => i.name)).toEqual(['Iced tea', 'Iced tea']);
    expect(code(await http().post(`/v1/restaurant/orders/${a.id}/move-items`).set(r.server).send({ itemIds: [burger.modifiers[0].id], toOrderId: moved.to.id }).expect(404))).toBe('NOT_FOUND'); // not on A anymore
    expect(code(await http().post(`/v1/restaurant/orders/${moved.to.id}/move-items`).set(r.server).send({ itemIds: [burger.modifiers[0].id], toOrderId: a.id }).expect(422))).toBe('MOVE_WHOLE_ITEMS');
    // The kitchen still knows where the burger goes.
    const kds = (await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId, stationId: r.grill }).set(r.manager).expect(200)).body.data;
    expect(kds[0].order).toMatchObject({ id: moved.to.id, tableCode: 'T2' });

    // An order with only pending items can be cancelled (they disappear); one with fired items cannot.
    expect(code(await http().post(`/v1/restaurant/orders/${moved.to.id}/cancel`).set(r.server).send({ reason: 'x' }).expect(409))).toBe('ORDER_HAS_FIRED_ITEMS');
    const c = (await open(r, { orderType: 'TAKEAWAY', customerName: 'Ben' }).expect(201)).body;
    await add(r, c.id, [{ variantId: r.tea, quantity: '1' }]).expect(201);
    expect((await http().post(`/v1/restaurant/orders/${c.id}/cancel`).set(r.server).send({ reason: 'Left' }).expect(200)).body).toMatchObject({ status: 'CANCELLED', items: [] });
    await add(r, c.id, [{ variantId: r.tea, quantity: '1' }]).expect(409);
    expect(code(await http().post(`/v1/restaurant-tables/${r.t3}/archive`).set(r.auth).expect(409))).toBe('TABLE_HAS_ORDER');
  });
});

describe('drills and database guards', () => {
  it('five people opening one table → one order; two tablets adding at once → every item once; five fires → each item fired once', async () => {
    const r = await restaurant('ord-race');
    const opens = await Promise.all(Array.from({ length: 5 }, () => open(r, { orderType: 'DINE_IN', tableId: r.t1 })));
    expect(opens.map((x) => x.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const o = opens.find((x) => x.status === 201)!.body;

    const adds = await Promise.all(Array.from({ length: 10 }, (_, i) => add(r, o.id, [{ variantId: i % 2 ? r.tea : r.burger, quantity: '1', ...(i % 2 ? {} : { modifierOptionIds: [r.medium] }) }], i % 2 ? r.server : r.manager)));
    expect(adds.map((x) => x.status)).toEqual(Array(10).fill(201));
    expect((await order(r, o.id)).items).toHaveLength(10);

    const fires = await Promise.all(Array.from({ length: 5 }, () => fire(r, o.id)));
    expect(fires.map((x) => x.status)).toEqual(Array(5).fill(200));
    expect(fires.flatMap((x) => x.body.fired).length).toBe(2); // one GRILL + one BAR ticket in total
    expect(await sql(r, `SELECT status, count(*)::int AS n FROM order_items GROUP BY 1`)).toEqual([{ status: 'FIRED', n: 15 }]);

    // Two merges in opposite directions at once: one wins, no deadlock.
    const p = (await open(r, { orderType: 'DINE_IN', tableId: r.t2 }).expect(201)).body;
    const q = (await open(r, { orderType: 'DINE_IN', tableId: r.t3 }).expect(201)).body;
    const merges = await Promise.all([
      http().post(`/v1/restaurant/orders/${p.id}/merge`).set(r.server).send({ intoOrderId: q.id }),
      http().post(`/v1/restaurant/orders/${q.id}/merge`).set(r.server).send({ intoOrderId: p.id }),
    ]);
    expect(merges.map((x) => x.status).sort()).toEqual([200, 409]);
  });

  it('the database keeps fired items frozen, closed orders closed, and items out of closed orders', async () => {
    const r = await restaurant('ord-guard');
    const o = (await open(r, { orderType: 'DINE_IN', tableId: r.t1 }).expect(201)).body;
    await add(r, o.id, [{ variantId: r.tea, quantity: '1' }]).expect(201);
    await fire(r, o.id).expect(200);
    const item = (await order(r, o.id)).items[0];
    await expect(sql(r, `UPDATE order_items SET quantity = 5 WHERE id = $1`, [item.id])).rejects.toThrow(/fired item/);
    await expect(sql(r, `DELETE FROM order_items WHERE id = $1`, [item.id])).rejects.toThrow(/fired item/);
    await expect(sql(r, `UPDATE order_items SET status = 'PENDING', fired_at = NULL WHERE id = $1`, [item.id])).rejects.toThrow(/cannot go from/);
    await expect(sql(r, `UPDATE order_items SET status = 'SERVED', served_at = now() WHERE id = $1`, [item.id])).resolves.toBeDefined(); // forward skips allowed
    const c = (await open(r, { orderType: 'TAKEAWAY' }).expect(201)).body;
    await http().post(`/v1/restaurant/orders/${c.id}/cancel`).set(r.server).send({ reason: 'test' }).expect(200);
    await expect(sql(r, `UPDATE restaurant_orders SET status = 'OPEN' WHERE id = $1`, [c.id])).rejects.toThrow(/cannot change/);
    await expect(sql(r, `INSERT INTO order_items (tenant_id, order_id, kind, variant_id, menu_version_id, name, quantity, added_by)
      SELECT tenant_id, $1, 'ITEM', variant_id, menu_version_id, 'x', 1, added_by FROM order_items LIMIT 1`, [c.id])).rejects.toThrow(/open order/);
    await expect(sql(r, `DELETE FROM restaurant_orders`)).rejects.toThrow();
  });
});
