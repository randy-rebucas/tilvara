import type { INestApplication } from '@nestjs/common';
import { toDec } from '@1pos/money';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Restaurant reports (ADR-0014 §10 — Phase 4 slice 5): every figure reconciled to evidence rows. */
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
 * A VAT restaurant with a Grill (default) and a Bar: Burger ₱150 (recipe bun + 0.15 kg beef; doneness
 * required; cheese slice ₱20 extra) → GRILL, Iced tea ₱45 → BAR. Cheese sticks (recipe: 2 cheese slices,
 * never sold) make the cheese slice an ingredient too. Service charge 10 % on dine-in only.
 */
async function restaurant(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter' }).expect(201)).body.id as string;
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
  const sticks = await product('Cheese sticks', '90.00', false);
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [
    { variantId: bun, quantity: '50', unitCost: '5.00' }, { variantId: beef, quantity: '5', unitCost: '400.00' }, { variantId: cheese, quantity: '40', unitCost: '3.00' },
  ] }).expect(201);
  await http().post(`/v1/variants/${burger}/recipe`).set(auth).send({ ingredients: [{ variantId: bun, quantity: '1' }, { variantId: beef, quantity: '0.15' }] }).expect(201);
  await http().post(`/v1/variants/${sticks}/recipe`).set(auth).send({ ingredients: [{ variantId: cheese, quantity: '2' }] }).expect(201);
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
  await http().put(`/v1/branches/${branchId}/restaurant-settings`).set(auth).send({ dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }).expect(200);
  const login = async (role: string) => {
    const m = await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: branchId });
    return { headers: bearer(await loginToken(app, m.email)), userId: m.userId };
  };
  const server = await login('cashier');
  const manager = await login('branch_manager');
  const session = (await http().post('/v1/cashier-sessions').set(server.headers).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const opt = (g: { options: { id: string; name: string }[] }, name: string) => g.options.find((o) => o.name === name)!.id;
  return {
    tenantId: t.tenantId, auth, branchId, session, grill, bar, t1, t2, t3, bun, beef, cheese, burger, tea,
    medium: opt(doneness, 'Medium'), cheeseOpt: opt(extras, 'Cheese'),
    server: server.headers, manager: manager.headers, managerId: manager.userId,
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;

const key = () => ({ 'Idempotency-Key': randomUUID() });
const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) => asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const total = (xs: string[]) => xs.reduce((a, x) => a.plus(x), toDec('0')).toFixed(2);

const open = (r: R, body: Record<string, unknown>) => http().post('/v1/restaurant/orders').set(r.server).send({ branchId: r.branchId, ...body }).expect(201).then((x) => x.body.id as string);
const add = (r: R, orderId: string, items: unknown[]) => http().post(`/v1/restaurant/orders/${orderId}/items`).set(r.server).set(key()).send({ items }).expect(201);
const fire = (r: R, orderId: string) => http().post(`/v1/restaurant/orders/${orderId}/fire`).set(r.server).send({}).expect(200);
const items = async (r: R, orderId: string) => (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body.items as { id: string; name: string; status: string }[];
const status = (itemId: string, s: string, who: Headers) => http().post(`/v1/order-items/${itemId}/status`).set(who).send({ status: s }).expect(200);
const voidItem = (r: R, itemId: string, body: Record<string, unknown>) => http().post(`/v1/order-items/${itemId}/void`).set(r.manager).set(key()).send(body).expect(200);
const bill = (r: R, orderId: string) => http().post(`/v1/restaurant/orders/${orderId}/bill`).set(r.server).set(key()).send({}).expect(201).then((x) => x.body);
const check = (r: R, billId: string, body: Record<string, unknown> = {}) =>
  http().post(`/v1/restaurant/bills/${billId}/checks`).set(r.server).set(key())
    .send({ cashierSessionId: r.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '2000.00' }], ...body }).expect(201).then((x) => x.body);
/** Kitchen timestamps as offsets (seconds) from when the item was fired; null clears one. */
const times = (r: R, itemId: string, t: { prep?: number | null; ready?: number | null; served?: number | null }) => {
  const at = (s: number | null | undefined) => (s === null || s === undefined ? 'NULL' : `fired_at + interval '${s} seconds'`);
  return sql(r, `UPDATE order_items SET prep_started_at = ${at(t.prep)}, ready_at = ${at(t.ready)}, served_at = ${at(t.served)} WHERE id = $1`, [itemId]);
};

/**
 * One service day:
 * - T1: 2 burgers (medium + cheese) + 2 teas → bill ₱473.00 → split evenly → settled; one tea returned (₱49.50 incl. its ₱4.50 charge).
 * - T2: a burger dropped while cooking (wasted void) and a tea voided before anything was made; a second tea served. Still open.
 * - Takeaway: 1 burger, billed ₱150.00, half paid. Still billed.
 * - T3: opened and cancelled.
 * - Back of house: 0.1 kg beef spoiled; the beef count comes out 0.05 kg short.
 */
async function serviceDay(r: R) {
  const o1 = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
  await add(r, o1, [{ variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] }, { variantId: r.tea, quantity: '2' }]);
  await fire(r, o1);
  const [burger1, tea1] = await items(r, o1);
  await status(burger1!.id, 'IN_PREP', r.manager);
  const grillTicket = (await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId, stationId: r.grill }).set(r.manager).expect(200)).body.data[0].id;
  await http().post(`/v1/kitchen/tickets/${grillTicket}/bump`).set(r.manager).expect(200);
  await status(tea1!.id, 'READY', r.manager);
  await status(burger1!.id, 'SERVED', r.server);
  await status(tea1!.id, 'SERVED', r.server);
  await times(r, burger1!.id, { prep: 60, ready: 600, served: 660 });
  await times(r, tea1!.id, { ready: 120, served: 150 });
  const bill1 = await bill(r, o1);
  expect(bill1.amountDue).toBe('473.00');
  const half = { num: 1, den: 2 };
  const c1 = await check(r, bill1.id, { allocations: [{ billLineId: bill1.lines[0].id, share: half }, { billLineId: bill1.lines[2].id, share: half }] });
  const c2 = await check(r, bill1.id);
  expect([c1.amountDue, c2.amountDue, c2.billSettled]).toEqual(['236.50', '236.50', true]);
  const teaLine = c1.lines.find((l: { name: string }) => l.name === 'Iced tea');
  const ret = (await http().post(`/v1/sales/${c1.id}/returns`).set(r.manager).set(key())
    .send({ cashierSessionId: r.session, kind: 'RETURN', reason: 'Too sweet', lines: [{ saleLineId: teaLine.id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201)).body;
  expect(ret.amountDue).toBe('49.50'); // 45.00 + 45/215 of the check's 21.50 charge

  const o2 = await open(r, { orderType: 'DINE_IN', tableId: r.t2 });
  await add(r, o2, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }, { variantId: r.tea, quantity: '1' }]);
  await fire(r, o2);
  const [burger2, tea2] = await items(r, o2);
  await status(burger2!.id, 'IN_PREP', r.manager);
  await times(r, burger2!.id, { prep: 30 });
  const wasted = (await voidItem(r, burger2!.id, { reason: 'Dropped on the floor', wasted: true })).body.items[0].wasteAdjustmentId as string;
  await voidItem(r, tea2!.id, { reason: 'Customer changed mind' });
  await add(r, o2, [{ variantId: r.tea, quantity: '1' }]);
  await fire(r, o2);
  const tea3 = (await items(r, o2))[2]!;
  await status(tea3.id, 'READY', r.manager);
  await status(tea3.id, 'SERVED', r.server);
  await times(r, tea3.id, { ready: 60, served: 90 });

  const o3 = await open(r, { orderType: 'TAKEAWAY', customerName: 'Ana' });
  await add(r, o3, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }]);
  await fire(r, o3);
  const [burger3] = await items(r, o3);
  const ticket3 = (await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId, stationId: r.grill }).set(r.manager).expect(200)).body.data[0].id;
  await http().post(`/v1/kitchen/tickets/${ticket3}/bump`).set(r.manager).expect(200);
  await times(r, burger3!.id, { ready: 300 });
  const bill3 = await bill(r, o3);
  expect(bill3.amountDue).toBe('150.00'); // takeaway: no service charge
  const c3 = await check(r, bill3.id, { allocations: [{ billLineId: bill3.lines[0].id, share: half }] });
  expect([c3.amountDue, c3.billSettled]).toEqual(['75.00', false]);

  const o4 = await open(r, { orderType: 'DINE_IN', tableId: r.t3 });
  await add(r, o4, [{ variantId: r.tea, quantity: '1' }]);
  await http().post(`/v1/restaurant/orders/${o4}/cancel`).set(r.server).send({ reason: 'Left' }).expect(200);

  await http().post('/v1/stock/adjustments').set(r.auth).set('Idempotency-Key', randomUUID()).send({ branchId: r.branchId, kind: 'WASTE', reason: 'Spoiled', items: [{ variantId: r.beef, quantity: '-0.1' }] }).expect(201);
  const beefNow = (await http().get('/v1/stock/balances').query({ branchId: r.branchId, variantId: r.beef }).set(r.auth).expect(200)).body.data[0].quantity as string;
  expect(beefNow).toBe('4.375'); // 5 − 0.30 (T1) − 0.15 (dropped) − 0.075 (half a takeaway burger) − 0.1 (spoiled)
  await http().post('/v1/stock/counts').set(r.auth).set(key()).send({ branchId: r.branchId, lines: [{ variantId: r.beef, countedQuantity: '4.325' }] }).expect(201);

  return { o1, o2, o3, o4, c1, c2, c3, ret, wasted, bill1, bill3 };
}

describe('restaurant reports over one service day', () => {
  let r: R;
  let d: Awaited<ReturnType<typeof serviceDay>>;
  let range: { branchId: string; from: string; to: string };
  const get = (path: string, q: Record<string, string> = range) => http().get(`/v1/reports/${path}`).query(q).set(r.manager).expect(200).then((x) => x.body);

  beforeAll(async () => {
    r = await restaurant('rr-day');
    d = await serviceDay(r);
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    range = { branchId: r.branchId, from: day, to: day };
  });

  it('item performance: modifiers nest under their item, COGS includes the recipe, and Σ = by-product', async () => {
    const rep = await get('item-performance');
    const burger = rep.data.find((x: { variantId: string }) => x.variantId === r.burger);
    // 1 + 1 (T1 checks) + ½ (takeaway); COGS 2.5 × (bun 5 + 0.15 kg × 400).
    expect(burger).toMatchObject({ quantitySold: '2.5', netQuantity: '2.5', netSales: '375.00', cogs: '162.50', checks: 3 });
    expect(burger.modifiers).toEqual([expect.objectContaining({ variantId: r.cheese, name: 'Cheese slice', netQuantity: '2', netSales: '40.00', cogs: '6.00', checks: 2 })]);
    expect(burger.withModifiers).toMatchObject({ netSales: '415.00', cogs: '168.50' });
    expect(toDec(burger.withModifiers.grossProfit).equals(toDec(burger.withModifiers.revenueExVat).minus('168.50'))).toBe(true);
    const tea = rep.data.find((x: { variantId: string }) => x.variantId === r.tea);
    expect(tea).toMatchObject({ quantitySold: '2', quantityReturned: '1', netQuantity: '1', netSales: '45.00', cogs: '0.00', modifiers: [] });
    expect(rep.data.map((x: { variantId: string }) => x.variantId)).toEqual([r.burger, r.tea]); // by net sales with modifiers

    // Reconciles with by-product: every line counted once, as an item or as a modifier.
    const byProduct = (await get('by-product')).data as { netSales: string; revenueExVat: string; cogs: string }[];
    const flat = rep.data.flatMap((x: { modifiers: unknown[] }) => [x, ...x.modifiers]) as typeof byProduct;
    for (const k of ['netSales', 'revenueExVat', 'cogs'] as const) expect(total(flat.map((x) => x[k]))).toBe(total(byProduct.map((x) => x[k])));
    expect(rep.totals.netSales).toBe('460.00');
    // ... and with the evidence: Σ sale lines − Σ return lines in the day.
    const [ev] = await sql<{ net: string }>(r, `SELECT ((SELECT sum(amount_due) FROM sale_lines) - (SELECT sum(amount_due) FROM sale_return_lines))::numeric(14,2)::text AS net`);
    expect(ev!.net).toBe('460.00');
  });

  it('ingredient usage: expected from recipes and sales, actual adds waste and the count; consumption = sold × recipe in force', async () => {
    const rep = await get('ingredient-usage');
    const row = (v: string) => rep.data.find((x: { variantId: string }) => x.variantId === v);
    expect(row(r.beef)).toMatchObject({
      unit: 'KG',
      quantity: { recipe: '0.375', sold: '0', expected: '0.375', preparedWaste: '0.15', otherWaste: '0.1', countVariance: '-0.05', actual: '0.675', variance: '0.3' },
      value: { recipe: '150.00', sold: '0.00', expected: '150.00', preparedWaste: '60.00', otherWaste: '40.00', countVariance: '-20.00', actual: '270.00', variance: '120.00' },
      variancePct: '80.0',
    });
    expect(row(r.bun)).toMatchObject({ quantity: { recipe: '2.5', expected: '2.5', preparedWaste: '1', actual: '3.5', variance: '1' }, value: { actual: '17.50', variance: '5.00' }, variancePct: '40.0' });
    // The cheese slice is an ingredient (of cheese sticks) and was sold as itself, as a burger extra.
    expect(row(r.cheese)).toMatchObject({ quantity: { recipe: '0', sold: '2', expected: '2', actual: '2', variance: '0' }, variancePct: '0.0' });
    expect(rep.data).toHaveLength(3);
    expect(rep.totals).toEqual({ expectedValue: '168.50', wasteValue: '105.00', countVarianceValue: '-20.00', actualValue: '293.50', varianceValue: '125.00' });

    // Each column is the movement evidence by type.
    const ev = await sql<{ type: string; q: string; v: string }>(r, `SELECT type, sum(quantity)::text AS q, sum(value)::text AS v FROM stock_movements WHERE variant_id = $1 AND type <> 'ADJUSTMENT' GROUP BY 1 ORDER BY 1`, [r.beef]);
    expect(ev).toEqual([
      { type: 'CONSUMPTION', q: '-0.3750', v: '-150.0000' }, { type: 'COUNT', q: '-0.0500', v: '-20.0000' }, { type: 'WASTE', q: '-0.2500', v: '-100.0000' },
    ]);
    // ADR-0014 §10: per ingredient, Σ CONSUMPTION = Σ over sale lines of quantity × the recipe in force at the sale.
    expect(await sql(r, `
      WITH expected AS (
        SELECT ri.ingredient_variant_id AS v, sum(l.quantity * ri.quantity) AS q
          FROM sale_lines l JOIN sales s ON s.id = l.sale_id
          JOIN LATERAL (SELECT rv.id FROM recipe_versions rv WHERE rv.variant_id = l.variant_id AND rv.effective_from <= s.completed_at + interval '5 seconds'
                         ORDER BY rv.effective_from DESC LIMIT 1) rv ON true
          JOIN recipe_ingredients ri ON ri.recipe_version_id = rv.id
         GROUP BY 1),
      actual AS (SELECT variant_id AS v, -sum(quantity) AS q FROM stock_movements WHERE type = 'CONSUMPTION' GROUP BY 1)
      SELECT coalesce(e.v, a.v) AS v, e.q::text AS expected, a.q::text AS actual FROM expected e FULL JOIN actual a ON a.v = e.v WHERE e.q IS DISTINCT FROM a.q`)).toEqual([]);
  });

  it('kitchen voids: stage reached, wasted or not, waste value = its WASTE entry, by reason and by user', async () => {
    const rep = await get('kitchen-voids');
    expect(rep.data.map((v: Record<string, unknown>) => [v.name, v.stationCode, (v.order as { tableCode: string }).tableCode, v.stage, v.cookingStarted, v.wasted, v.wasteValue, v.reason, v.modifiers])).toEqual([
      ['Burger', 'GRILL', 'T2', 'IN_PREP', true, true, '65.00', 'Dropped on the floor', ['Medium']],
      ['Iced tea', 'BAR', 'T2', 'FIRED', false, false, '0.00', 'Customer changed mind', []],
    ]);
    expect(rep.data[0].wasteAdjustmentId).toBe(d.wasted);
    expect(rep.byUser).toEqual([{ userId: r.managerId, displayName: expect.any(String), voids: 2, cookingStarted: 1, wasted: 1, wasteValue: '65.00' }]);
    expect(rep.byReason.map((x: { reason: string; voids: number }) => [x.reason, x.voids])).toEqual([['Dropped on the floor', 1], ['Customer changed mind', 1]]);
    expect(rep.totals).toEqual({ voids: 2, cookingStarted: 1, wasted: 1, wasteValue: '65.00' });
    const [entry] = await sql<{ net: string }>(r, `
      SELECT sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_id = $1 AND a.system_key = 'INVENTORY_WASTE'`, [d.wasted]);
    expect(entry!.net).toBe('65.0000');
  });

  it('prep times per station: fired → ready, waits and passes, voided items apart', async () => {
    const rep = await get('prep-times');
    // GRILL: T1 burger 600 s (prep started at 60 s, served 60 s after ready), takeaway burger 300 s, dropped burger untimed (started at 30 s).
    // BAR: T1 tea 120 s (served after 30 s), T2 second tea 60 s (served after 30 s), voided tea untimed.
    expect(rep.stations).toEqual([
      { stationId: r.bar, code: 'BAR', name: 'Bar', tickets: 3, items: 3, voided: 1, timed: 2, prepSeconds: { average: 90, median: 90, p90: 114, max: 120 }, waitSeconds: null, passSeconds: 30 },
      { stationId: r.grill, code: 'GRILL', name: 'Grill', tickets: 3, items: 3, voided: 1, timed: 2, prepSeconds: { average: 450, median: 450, p90: 570, max: 600 }, waitSeconds: 45, passSeconds: 60 },
    ]);
    expect(rep.overall).toEqual({ tickets: 6, items: 6, voided: 2, timed: 4, prepSeconds: { average: 270, median: 210, p90: 510, max: 600 }, waitSeconds: 45, passSeconds: 40 });
  });

  it('open orders at close: the open table and the half-paid takeaway; nothing before they were opened', async () => {
    const rep = await get('open-orders', { branchId: r.branchId, day: range.from });
    expect(rep.data.map((o: Record<string, unknown>) => [o.orderId, o.orderType, o.tableCode, o.customerName, o.status, o.items, o.notServed, o.bill])).toEqual([
      [d.o2, 'DINE_IN', 'T2', null, 'OPEN', 1, 0, null],
      [d.o3, 'TAKEAWAY', null, 'Ana', 'BILLED', 1, 1, { id: d.bill3.id, billNumber: 2, amountDue: '150.00', paid: '75.00', remaining: '75.00' }],
    ]);
    expect(rep.totals).toEqual({ orders: 2, unbilled: 1, billed: 1, unpaid: '75.00' });
    // Evidence: what the takeaway's checks paid; the settled and cancelled orders are closed.
    expect(await sql(r, `SELECT status FROM restaurant_orders WHERE id = ANY($1::uuid[]) AND closed_at IS NOT NULL ORDER BY order_number`, [[d.o1, d.o4]])).toEqual([{ status: 'SETTLED' }, { status: 'CANCELLED' }]);
    const yesterday = new Date(Date.parse(range.from) - 86_400_000).toISOString().slice(0, 10);
    expect((await get('open-orders', { branchId: r.branchId, day: yesterday })).data).toEqual([]);
  });

  it('service charge for DOLE distribution: charged − returned, ex VAT = the liability credited', async () => {
    const rep = await get('service-charge');
    expect(rep.totals).toMatchObject({ checks: 2, returns: 1, base: '383.93', charged: { exVat: '38.39', vat: '4.61', amountDue: '43.00' }, returned: { amountDue: '4.50' } });
    expect(rep.totals.net.amountDue).toBe('38.50');
    expect(rep.days).toHaveLength(1);
    expect([rep.distributable, rep.ledger]).toEqual([rep.totals.net.exVat, rep.totals.net.exVat]);
    const [ev] = await sql<{ n: string }>(r, `
      SELECT ((SELECT sum(amount_due - vat_amount) FROM sale_charges) - (SELECT sum(amount_due - vat_amount) FROM sale_return_charges))::numeric(14,2)::text AS n`);
    expect(rep.distributable).toBe(ev!.n);
    const [gl] = await sql<{ n: string }>(r, `SELECT sum(l.credit - l.debit)::numeric(14,2)::text AS n FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'SERVICE_CHARGE_PAYABLE'`);
    expect(gl!.n).toBe(rep.distributable);
  });

  it('every fired item is accounted for exactly once: paid in checks, voided (wasted or not), or still on a live order', async () => {
    const rows = await sql<{ name: string; order_status: string; status: string; wasted: boolean; paid: string | null }>(r, `
      SELECT i.name, o.status AS order_status, i.status, i.waste_adjustment_id IS NOT NULL AS wasted,
             (SELECT round(sum(a.share_num::numeric / a.share_den), 4)::text FROM order_bill_lines bl JOIN order_bills b ON b.id = bl.order_bill_id
                JOIN order_bill_allocations a ON a.bill_line_id = bl.id WHERE bl.order_item_id = i.id AND b.status <> 'VOIDED') AS paid
        FROM order_items i JOIN restaurant_orders o ON o.id = i.order_id
       WHERE i.kind = 'ITEM' AND i.status <> 'PENDING' ORDER BY o.order_number, i.created_at, i.id`);
    const fate = (x: (typeof rows)[number]) =>
      x.status === 'VOIDED' ? (x.paid === null ? (x.wasted ? 'voided, wasted' : 'voided') : 'VOIDED BUT BILLED')
      : x.order_status === 'SETTLED' ? (x.paid === '1.0000' ? 'paid' : `SETTLED BUT PAID ${x.paid}`)
      : `live (${x.order_status.toLowerCase()}, paid ${x.paid ?? 0})`;
    expect(rows.map((x) => [x.name, fate(x)])).toEqual([
      ['Burger', 'paid'], ['Iced tea', 'paid'],
      ['Burger', 'voided, wasted'], ['Iced tea', 'voided'], ['Iced tea', 'live (open, paid 0)'],
      ['Burger', 'live (billed, paid 0.5000)'],
    ]);
    expect(await asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('access and validation: reports.read at the branch; one day for open orders', async () => {
    for (const path of ['item-performance', 'ingredient-usage', 'kitchen-voids', 'prep-times', 'service-charge']) {
      await http().get(`/v1/reports/${path}`).query(range).set(r.server).expect(403);
    }
    await http().get('/v1/reports/open-orders').query({ branchId: r.branchId, day: range.from }).set(r.server).expect(403);
    await http().get('/v1/reports/open-orders').query({ branchId: r.branchId }).set(r.manager).expect(400);
    await http().get('/v1/reports/prep-times').query({ ...range, branchId: randomUUID() }).set(r.manager).expect(404);
  });
});
