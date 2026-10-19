import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Restaurant leftovers closed in session 16 (ADR-0014 amendment): notes per course, voiding a choice
 * on its own, the floor push stream, prep times by hour and item, and open orders counted as they
 * stood at the cutoff.
 */
let app: INestApplication;
let owner: pg.Pool;
let base: string;
const http = () => request(app.getHttpServer());
type Headers = { Authorization: string };

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

/** Burger ₱150 (doneness required; cheese ₱20 extra, "No onions" free) → GRILL, Iced tea ₱45 → BAR. */
async function restaurant(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, tracked: boolean) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, trackInventory: tracked, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cheese = await product('Cheese slice', '20.00', true);
  const burger = await product('Burger', '150.00', false);
  const tea = await product('Iced tea', '45.00', false);
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId: cheese, quantity: '40', unitCost: '3.00' }] }).expect(201);
  await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'GRILL', name: 'Grill', isDefault: true }).expect(201);
  await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'BAR', name: 'Bar' }).expect(201);
  const area = (await http().post('/v1/dining-areas').set(auth).send({ branchId, name: 'Hall' }).expect(201)).body.id as string;
  const table = async (code: string) => (await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area, code }).expect(201)).body.id as string;
  const [t1, t2] = [await table('T1'), await table('T2')];
  const doneness = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(auth).send({ name: 'All day' }).expect(201)).body;
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [
    { name: 'Mains', items: [{ variantId: burger, stationCode: 'GRILL', modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea, stationCode: 'BAR' }] },
  ] }).expect(200);
  await http().post(`/v1/menu-versions/${menu.draft.id}/publish`).set(auth).expect(200);
  await http().put(`/v1/branches/${branchId}/restaurant-settings`).set(auth).send({ dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0', serviceChargeDineIn: false, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }).expect(200);
  const login = async (role: string) => bearer(await loginToken(app, (await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: branchId })).email));
  const opt = (g: { options: { id: string; name: string }[] }, name: string) => g.options.find((o) => o.name === name)!.id;
  return {
    tenantId: t.tenantId, auth, access: t.access, branchId, t1, t2, cheese, burger, tea,
    medium: opt(doneness, 'Medium'), cheeseOpt: opt(extras, 'Cheese'), noOnions: opt(extras, 'No onions'),
    server: await login('cashier'), manager: await login('branch_manager'), crew: await login('kitchen_crew'),
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;

const key = () => ({ 'Idempotency-Key': randomUUID() });
const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) => asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const open = (r: R, body: Record<string, unknown>) => http().post('/v1/restaurant/orders').set(r.server).send({ branchId: r.branchId, ...body }).expect(201).then((x) => x.body.id as string);
const add = (r: R, orderId: string, items: unknown[]) => http().post(`/v1/restaurant/orders/${orderId}/items`).set(r.server).set(key()).send({ items }).expect(201);
const fire = (r: R, orderId: string, courses?: number[]) => http().post(`/v1/restaurant/orders/${orderId}/fire`).set(r.server).send(courses ? { courses } : {}).expect(200);
type ItemView = { id: string; name: string; status: string; course: number; modifiers: { id: string; name: string; status: string }[] };
const order = async (r: R, orderId: string) => (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body as { items: ItemView[]; courseNotes: { course: number; note: string }[]; tickets: { course: number; courseNote: string | null }[] };
const tickets = async (r: R) => (await http().get('/v1/kitchen/tickets').query({ branchId: r.branchId }).set(r.crew).expect(200)).body.data as { id: string; course: number; courseNote: string | null; items: { name: string; modifiers: { name: string; status: string }[] }[] }[];

describe('notes per course', () => {
  it('a course note travels with the tickets fired for that course and stays as fired', async () => {
    const r = await restaurant('rl-notes');
    const o = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
    await add(r, o, [{ variantId: r.tea, quantity: '1', course: 1 }, { variantId: r.burger, quantity: '1', course: 2, modifierOptionIds: [r.medium] }]);
    const note = (body: Record<string, unknown>, who: Headers = r.server) => http().put(`/v1/restaurant/orders/${o}/course-notes`).set(who).send(body);
    await note({ course: 2, note: '  ' }).expect(400);
    await note({ course: 10, note: 'x' }).expect(400);
    await note({ course: 2, note: 'Birthday: bring with a candle' }, r.crew).expect(403);
    expect((await note({ course: 2, note: 'Birthday: bring with a candle' }).expect(200)).body.courseNotes).toEqual([{ course: 2, note: 'Birthday: bring with a candle' }]);
    await note({ course: 1, note: 'Drinks first' }).expect(200);
    await note({ course: 1, note: null }).expect(200);
    await fire(r, o, [1]);
    await fire(r, o, [2]);
    const fired = await tickets(r);
    expect(fired.map((t) => [t.course, t.courseNote]).sort()).toEqual([[1, null], [2, 'Birthday: bring with a candle']]);
    // Changing the note later does not rewrite what the kitchen was told.
    await note({ course: 2, note: 'Candle is lit' }).expect(200);
    expect((await tickets(r)).find((t) => t.course === 2)!.courseNote).toBe('Birthday: bring with a candle');
    // Billed: the order is closed for notes (the database refuses too).
    await http().post(`/v1/restaurant/orders/${o}/bill`).set(r.server).set(key()).send({}).expect(201);
    expect((await note({ course: 2, note: 'Late' }).expect(409)).body.error.code).toBe('ORDER_NOT_OPEN');
    const err = await sql(r, `UPDATE order_course_notes SET note = 'x'`).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/order is BILLED/);
  });
});

describe('voiding a choice on its own', () => {
  it('a fired extra is voided alone and leaves the bill; a required choice cannot be; waste writes off the extra only', async () => {
    const r = await restaurant('rl-modvoid');
    const o = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
    await add(r, o, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.cheeseOpt, r.noOnions] }]);
    const pending = (await order(r, o)).items[0]!;
    const mod = (name: string, item = pending) => item.modifiers.find((m) => m.name === name)!.id;
    const voidIt = (id: string, body: Record<string, unknown>, who: Headers = r.manager) => http().post(`/v1/order-items/${id}/void`).set(who).set(key()).send(body);
    expect((await voidIt(mod('Cheese'), { reason: 'Changed mind' }).expect(409)).body.error.code).toBe('ITEM_NOT_FIRED');
    await fire(r, o);
    const fired = (await order(r, o)).items[0]!;
    await voidIt(mod('Cheese', fired), { reason: 'No cheese after all' }, r.server).expect(403); // needs sales.void
    expect((await voidIt(mod('Medium', fired), { reason: 'x' }).expect(409)).body.error).toMatchObject({ code: 'CHOICE_REQUIRED', details: { group: 'Doneness', min: 1 } });
    const after = (await voidIt(mod('Cheese', fired), { reason: 'No cheese after all', wasted: true }).expect(200)).body.items[0] as ItemView;
    expect(after.status).toBe('FIRED');
    expect(after.modifiers.map((m) => [m.name, m.status]).sort()).toEqual([['Cheese', 'VOIDED'], ['Medium', 'FIRED'], ['No onions', 'FIRED']]);
    expect((await voidIt(mod('Cheese', fired), { reason: 'again' }).expect(409)).body.error.code).toBe('ALREADY_VOIDED');
    // The free instruction can go too.
    await voidIt(mod('No onions', fired), { reason: 'They want onions' }).expect(200);
    // The kitchen sees the struck choices; the bill charges the burger alone.
    expect((await tickets(r))[0]!.items[0]!.modifiers.filter((m) => m.status === 'VOIDED').map((m) => m.name).sort()).toEqual(['Cheese', 'No onions']);
    expect((await http().post(`/v1/restaurant/orders/${o}/bill`).set(r.server).set(key()).send({}).expect(201)).body.amountDue).toBe('150.00');
    // Waste: one cheese slice, nothing for the burger.
    const waste = await sql<{ variant_id: string; quantity: string }>(r, `SELECT variant_id, quantity::text FROM stock_movements WHERE type = 'WASTE'`);
    expect(waste).toEqual([{ variant_id: r.cheese, quantity: '-1.0000' }]);
    const audit = await sql<{ action: string }>(r, `SELECT action FROM audit_logs WHERE action LIKE 'order.%voided' ORDER BY occurred_at`);
    expect(audit.map((a) => a.action)).toEqual(['order.modifier_voided', 'order.modifier_voided']);
  });
});

describe('floor push stream', () => {
  /** Read SSE events from a live stream until `n` arrive or the time is up. */
  async function listen(r: R, token: string, branchId: string, until: (events: string[]) => boolean, act: () => Promise<unknown>, ms = 4_000) {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/restaurant/stream?branchId=${branchId}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    if (!res.ok) {
      ac.abort();
      return { status: res.status, events: [] as string[], body: await res.json().catch(() => null) };
    }
    const reader = res.body!.getReader();
    const events: string[] = [];
    const dec = new TextDecoder();
    let buf = '';
    let acted = false;
    const deadline = Date.now() + ms;
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      while (Date.now() < deadline && !until(events)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) events.push(ev);
          if (ev === 'ready' && !acted) {
            acted = true;
            await act();
          }
        }
      }
    } catch {
      // aborted at the deadline
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    return { status: res.status, events, body: null };
  }

  it('tells a branch\'s screens that something changed, once per transaction, and nothing to another business', async () => {
    const r = await restaurant('rl-push');
    const other = await restaurant('rl-push-b');
    const crewToken = (r.crew.Authorization as string).slice('Bearer '.length);
    const o = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
    await add(r, o, [{ variantId: r.tea, quantity: '1' }]);
    // Firing (a ticket and an item in one transaction) arrives as changes on the kitchen's stream.
    const got = await listen(r, crewToken, r.branchId, (e) => e.includes('changed'), () => fire(r, o));
    expect(got.status).toBe(200);
    expect(got.events[0]).toBe('ready');
    expect(got.events).toContain('changed');
    // Another business's change: the stream stays quiet.
    const o2 = await open(other, { orderType: 'DINE_IN', tableId: other.t1 });
    const quiet = await listen(r, crewToken, r.branchId, () => false, async () => {
      await add(other, o2, [{ variantId: other.tea, quantity: '1' }]);
      await fire(other, o2);
    }, 1_500);
    expect(quiet.events).toEqual(['ready']);
    // Someone else's branch id is not found, without a stream.
    const foreign = await listen(r, crewToken, other.branchId, () => true, async () => undefined);
    expect(foreign.status).toBe(404);
    // No token, no stream.
    expect((await fetch(`${base}/v1/restaurant/stream?branchId=${r.branchId}`)).status).toBe(401);
  });
});

describe('prep times by hour and by item', () => {
  it('groups the same timings by the local hour fired and by menu item', async () => {
    const r = await restaurant('rl-prep');
    const o = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
    await add(r, o, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }, { variantId: r.tea, quantity: '2' }]);
    await fire(r, o);
    const [burger, tea] = (await order(r, o)).items;
    // Fired at 12:10 and 19:05 Manila time; the burger took 10 min, the teas 2.
    await sql(r, `UPDATE order_items SET fired_at = '2026-10-10 12:10:00+08', ready_at = '2026-10-10 12:20:00+08' WHERE id = $1 OR parent_item_id = $1`, [burger!.id]);
    await sql(r, `UPDATE order_items SET fired_at = '2026-10-10 19:05:00+08', ready_at = '2026-10-10 19:07:00+08' WHERE id = $1`, [tea!.id]);
    const q = (by: string) => http().get('/v1/reports/prep-times').query({ branchId: r.branchId, from: '2026-10-10', to: '2026-10-10', by }).set(r.manager).expect(200);
    expect((await q('hour')).body.groups.map((g: { hour: number; items: number; prepSeconds: { average: number } }) => [g.hour, g.items, g.prepSeconds.average])).toEqual([[12, 1, 600], [19, 1, 120]]);
    expect((await q('item')).body.groups.map((g: { name: string; prepSeconds: { average: number } }) => [g.name, g.prepSeconds.average])).toEqual([['Burger', 600], ['Iced tea', 120]]);
    expect((await q('station')).body.stations).toHaveLength(2);
    await http().get('/v1/reports/prep-times').query({ branchId: r.branchId, from: '2026-10-10', to: '2026-10-10', by: 'seat' }).set(r.manager).expect(400);
  });
});

describe('open orders as they stood at the cutoff', () => {
  it('counts an item on the order it was on at the close of the day, voided or served as it was then', async () => {
    const r = await restaurant('rl-open');
    const a = await open(r, { orderType: 'DINE_IN', tableId: r.t1 });
    const b = await open(r, { orderType: 'DINE_IN', tableId: r.t2 });
    await add(r, a, [{ variantId: r.tea, quantity: '1' }, { variantId: r.tea, quantity: '1' }, { variantId: r.tea, quantity: '1' }]);
    await fire(r, a);
    const [moved, voided, served] = (await order(r, a)).items;
    // Yesterday's service: the orders and their items are pushed back a day.
    await sql(r, `UPDATE restaurant_orders SET opened_at = opened_at - interval '1 day' WHERE id = ANY($1)`, [[a, b]]);
    await sql(r, `UPDATE order_items SET created_at = created_at - interval '1 day', fired_at = fired_at - interval '1 day' WHERE order_id = $1`, [a]);
    // Today: one tea moves to T2, one is voided, one is served.
    await http().post(`/v1/restaurant/orders/${a}/move-items`).set(r.server).send({ toOrderId: b, itemIds: [moved!.id] }).expect(200);
    await http().post(`/v1/order-items/${voided!.id}/void`).set(r.manager).set(key()).send({ reason: 'Spilled' }).expect(200);
    await http().post(`/v1/order-items/${served!.id}/status`).set(r.server).send({ status: 'SERVED' }).expect(200);
    const yesterday = (await sql<{ d: string }>(r, `SELECT to_char((now() AT TIME ZONE 'Asia/Manila') - interval '1 day', 'YYYY-MM-DD') AS d`))[0]!.d;
    const today = (await sql<{ d: string }>(r, `SELECT to_char(now() AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS d`))[0]!.d;
    const report = async (day: string) => (await http().get('/v1/reports/open-orders').query({ branchId: r.branchId, day }).set(r.manager).expect(200)).body.data as { orderId: string; items: number; notServed: number }[];
    const at = (rows: { orderId: string; items: number; notServed: number }[], id: string) => rows.find((x) => x.orderId === id) && [rows.find((x) => x.orderId === id)!.items, rows.find((x) => x.orderId === id)!.notServed];
    // Close of yesterday: all three teas on T1, none voided or served yet; T2 empty.
    const y = await report(yesterday);
    expect([at(y, a), at(y, b)]).toEqual([[3, 3], [0, 0]]);
    // Now: T1 has the served tea (and the voided one does not count), T2 the moved one.
    const n = await report(today);
    expect([at(n, a), at(n, b)]).toEqual([[1, 0], [1, 1]]);
    // The move was recorded, and the history cannot be rewritten.
    expect(await sql(r, `SELECT from_order_id, to_order_id FROM order_item_moves WHERE item_id = $1`, [moved!.id])).toEqual([{ from_order_id: a, to_order_id: b }]);
    const err = await sql(r, `DELETE FROM order_item_moves`).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/append-only|not allowed|forbidden/i);
  });
});
