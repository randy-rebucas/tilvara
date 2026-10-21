import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KitchenTicketPrint, OfflineSale, Snapshot } from '@1pos/sync-protocol';
import { DevPaymentProvider } from '../../src/payments/provider.js';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { traceabilityAudit } from './traceability-audit.js';

/**
 * Session 25 (ADR-0014 amendment): counter service for cafes and food trucks (pay first, then the
 * kitchen gets the order, online and offline), kitchen printing from the desktop till, tips, changing a
 * pending item's choices in place, free choices in item performance, and no selling by weight for a
 * restaurant.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Headers = Record<string, string>;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

/**
 * A café with counter service: Burger ₱150 (doneness required; Cheese ₱20, "No onions" free) → GRILL,
 * Iced tea ₱45 → BAR, on the takeaway menu; bottled water ₱20 is a shop item, not on the menu.
 */
async function cafe(prefix: string, counterService = true) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const register = async (code: string) => (await http().post('/v1/registers').set(auth).send({ branchId, code, name: code }).expect(201)).body.id as string;
  const [r1, r2] = [await register('R1'), await register('R2')];
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, tracked: boolean) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, trackInventory: tracked, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cheese = await product('Cheese slice', '20.00', true);
  const burger = await product('Burger', '150.00', false);
  const tea = await product('Iced tea', '45.00', false);
  const water = await product('Bottled water', '20.00', true);
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID())
    .send({ branchId, reason: 'Opening', items: [{ variantId: cheese, quantity: '40', unitCost: '3.00' }, { variantId: water, quantity: '40', unitCost: '8.00' }] }).expect(201);
  const grill = (await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'GRILL', name: 'Grill', isDefault: true }).expect(201)).body.id as string;
  const bar = (await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'BAR', name: 'Bar' }).expect(201)).body.id as string;
  const area = (await http().post('/v1/dining-areas').set(auth).send({ branchId, name: 'Hall' }).expect(201)).body.id as string;
  const t1 = (await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area, code: 'T1' }).expect(201)).body.id as string;
  const doneness = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(auth).send({ name: 'All day' }).expect(201)).body;
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [
    { name: 'Mains', items: [{ variantId: burger, stationCode: 'GRILL', modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea, stationCode: 'BAR' }] },
  ] }).expect(200);
  await http().post(`/v1/menu-versions/${menu.draft.id}/publish`).set(auth).expect(200);
  const settings = { dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0', serviceChargeDineIn: false, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE', counterService };
  await http().put(`/v1/branches/${branchId}/restaurant-settings`).set(auth).send(settings).expect(200);
  const member = async (role: string) => {
    const m = await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: branchId });
    return { ...m, auth: bearer(await loginToken(app, m.email)) };
  };
  const cashier = await member('cashier');
  const manager = await member('branch_manager');
  const crew = await member('kitchen_crew');
  const session = (await http().post('/v1/cashier-sessions').set(cashier.auth).send({ registerId: r1, openingFloat: '1000.00' }).expect(201)).body.id as string;
  const terminal = async (registerId: string) => {
    const res = (await http().post('/v1/terminals').set(auth).send({ registerId, name: `Till ${registerId.slice(-4)}` }).expect(201)).body;
    return { id: res.terminal.id as string, headers: { 'x-terminal-id': res.terminal.id, Authorization: `Terminal ${res.credential}` } as Headers };
  };
  const opt = (g: { options: { id: string; name: string }[] }, name: string) => g.options.find((o) => o.name === name)!.id;
  return {
    tenantId: t.tenantId, auth, branchId, r1, r2, menuId: menu.id, settings, cheese, burger, tea, water, grill, bar, t1,
    medium: opt(doneness, 'Medium'), wellDone: opt(doneness, 'Well done'), cheeseOpt: opt(extras, 'Cheese'), noOnions: opt(extras, 'No onions'),
    cashier, manager, crew, session, till1: await terminal(r1), till2: await terminal(r2),
  };
}
type C = Awaited<ReturnType<typeof cafe>>;

const key = () => ({ 'Idempotency-Key': randomUUID() });
const sql = <T = Record<string, unknown>>(c: C, q: string, params: unknown[] = []) => asOwnerInTenant(owner, c.tenantId, async (x) => (await x.query(q, params)).rows as T[]);
const sell = (c: C, body: Record<string, unknown>, who: Headers = c.cashier.auth) =>
  http().post('/v1/sales').set(who).set(key()).send({ cashierSessionId: c.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }], ...body });
const burgerLine = (c: C, over: Record<string, unknown> = {}) => ({ id: 'burger', variantId: c.burger, quantity: '1', choices: [c.medium, c.cheeseOpt, c.noOnions], ...over });
const kds = async (c: C, status = 'OPEN') =>
  (await http().get('/v1/kitchen/tickets').query({ branchId: c.branchId, status }).set(c.crew.auth).expect(200)).body.data as {
    id: string; station: { code: string }; order: { orderNumber: number; orderType: string; customerName: string | null }; printedAt: string | null;
    items: { id: string; name: string; note: string | null; status: string; modifiers: { name: string; status: string }[] }[];
  }[];
const audit = async (c: C) => {
  const found = await asOwnerInTenant(owner, c.tenantId, (x) => traceabilityAudit(x));
  return Object.fromEntries(Object.entries(found).filter(([, rows]) => rows.length));
};

describe('counter service: pay first, then the kitchen gets the order', { timeout: 60_000 }, () => {
  it('a paid sale sends its menu items with their choices to their stations; priced choices are lines; the receipt carries the call number', async () => {
    const c = await cafe('cs-sale');
    const res = await sell(c, {
      lines: [burgerLine(c, { kitchenNote: 'Cut in half' }), { id: 'tea', variantId: c.tea, quantity: '2' }, { id: 'water', variantId: c.water, quantity: '1' }],
      pickupName: 'Ana',
    }).expect(201);
    // Burger 150 + cheese 20 + 2 teas 90 + water 20.
    expect(res.body.amountDue).toBe('280.00');
    const lines = res.body.lines as { id: string; name: string; parentLineId: string | null; amountDue: string }[];
    const burgerRow = lines.find((l) => l.name === 'Burger')!;
    expect(lines.map((l) => [l.name, l.parentLineId === burgerRow.id, l.amountDue])).toEqual([
      ['Burger', false, '150.00'], ['Cheese slice', true, '20.00'], ['Iced tea', false, '90.00'], ['Bottled water', false, '20.00'],
    ]);
    expect(res.body.counterOrder).toMatchObject({ orderNumber: expect.any(Number), pickupName: 'Ana', tickets: expect.any(Array) });
    expect(res.body.counterOrder.tickets).toHaveLength(2);

    // The kitchen copy: a settled COUNTER order of the sale, fired at once, one ticket per station.
    const [order] = await sql<{ order_type: string; status: string; sale_id: string; customer_name: string }>(c, `SELECT order_type, status, sale_id, customer_name FROM restaurant_orders`);
    expect(order).toEqual({ order_type: 'COUNTER', status: 'SETTLED', sale_id: res.body.id, customer_name: 'Ana' });
    const tickets = await kds(c);
    expect(tickets.map((t) => [t.station.code, t.order.orderType, t.order.orderNumber, t.order.customerName, t.items.map((i) => [i.name, i.note, i.status])]).sort()).toEqual([
      ['BAR', 'COUNTER', res.body.counterOrder.orderNumber, 'Ana', [['Iced tea', null, 'FIRED']]],
      ['GRILL', 'COUNTER', res.body.counterOrder.orderNumber, 'Ana', [['Burger', 'Cut in half', 'FIRED']]],
    ]);
    expect(tickets.find((t) => t.station.code === 'GRILL')!.items[0]!.modifiers.map((m) => m.name).sort()).toEqual(['Cheese', 'Medium', 'No onions']);
    // The kitchen moves it along as any ticket; served, it leaves the open list.
    const grill = tickets.find((t) => t.station.code === 'GRILL')!;
    await http().post(`/v1/kitchen/tickets/${grill.id}/bump`).set(c.crew.auth).expect(200);
    await http().post(`/v1/order-items/${grill.items[0]!.id}/status`).set(c.crew.auth).send({ status: 'SERVED' }).expect(200);
    expect((await kds(c)).map((t) => t.station.code)).toEqual(['BAR']);

    // Receipt: the choice indented under its item, the number to call.
    const receipt = (await http().get(`/v1/sales/${res.body.id}/receipt`).set(c.cashier.auth).expect(200)).body;
    expect(receipt).toMatchObject({ callNumber: res.body.counterOrder.orderNumber, pickupName: 'Ana' });
    expect(receipt.lines.map((l: { name: string }) => l.name)).toEqual(['Burger', '+ Cheese slice', 'Iced tea', 'Bottled water']);
    // Stock: the cheese and the water left with the sale; the books and the audit agree.
    expect(await sql(c, `SELECT variant_id, quantity::text FROM stock_movements WHERE type = 'SALE' ORDER BY variant_id`)).toEqual(
      [{ variant_id: c.cheese, quantity: '-1.0000' }, { variant_id: c.water, quantity: '-1.0000' }].sort((a, b) => (a.variant_id < b.variant_id ? -1 : 1)),
    );
    expect(await audit(c)).toEqual({});
    // A counter order never takes the table-service paths (the database refuses too).
    const err = await sql(c, `UPDATE restaurant_orders SET status = 'BILLED'`).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/settled order cannot change/);
  });

  it('refuses what the kitchen could not make; without counter service a sale is an ordinary sale', async () => {
    const c = await cafe('cs-refuse');
    const code = async (body: Record<string, unknown>) => (await sell(c, body).expect(422)).body.error.code as string;
    expect(await code({ lines: [burgerLine(c, { choices: [c.cheeseOpt] })] })).toBe('MODIFIER_COUNT'); // doneness is required
    expect(await code({ lines: [burgerLine(c, { choices: [c.medium, c.medium] })] })).toBe('DUPLICATE_MODIFIER');
    expect(await code({ lines: [{ variantId: c.water, quantity: '1', choices: [c.medium] }] })).toBe('NOT_ON_MENU');
    expect(await code({ lines: [{ variantId: c.water, quantity: '1', kitchenNote: 'Cold' }] })).toBe('NOT_ON_MENU');
    await http().put(`/v1/branches/${c.branchId}/sold-out`).set(c.crew.auth).send({ variantId: c.tea, soldOut: true }).expect(200);
    expect(await code({ lines: [{ variantId: c.tea, quantity: '1' }] })).toBe('SOLD_OUT');
    expect(await sql(c, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 0 }]);

    // Off: an item on the menu sells without going to the kitchen; choices are refused.
    await http().put(`/v1/branches/${c.branchId}/restaurant-settings`).set(c.auth).send({ ...c.settings, counterService: false }).expect(200);
    expect(await code({ lines: [burgerLine(c)] })).toBe('COUNTER_SERVICE_OFF');
    const plain = (await sell(c, { lines: [{ variantId: c.burger, quantity: '1' }] }).expect(201)).body;
    expect(plain.counterOrder).toBeNull();
    expect(await sql(c, `SELECT count(*)::int AS n FROM restaurant_orders`)).toEqual([{ n: 0 }]);
    // Omitting the flag keeps it; turning it on needs a takeaway menu.
    const { counterService: _omit, ...rest } = c.settings;
    expect((await http().put(`/v1/branches/${c.branchId}/restaurant-settings`).set(c.auth).send(rest).expect(200)).body.counterService).toBe(false);
    expect((await http().put(`/v1/branches/${c.branchId}/restaurant-settings`).set(c.auth).send({ ...c.settings, takeawayMenuId: null }).expect(422)).body.error.code).toBe('COUNTER_NEEDS_MENU');
    // A cashier reads the takeaway menu for the Sell screen, with the flag.
    const served = (await http().get(`/v1/branches/${c.branchId}/menu`).query({ orderType: 'TAKEAWAY' }).set(c.cashier.auth).expect(200)).body;
    expect(served).toMatchObject({ counterService: false, menu: { menuVersionId: expect.any(String) } });
  });

  it('voiding the sale takes what the kitchen has not handed over off its screen', async () => {
    const c = await cafe('cs-void');
    const sale = (await sell(c, { lines: [burgerLine(c), { variantId: c.tea, quantity: '1' }] }).expect(201)).body;
    const bar = (await kds(c)).find((t) => t.station.code === 'BAR')!;
    await http().post(`/v1/order-items/${bar.items[0]!.id}/status`).set(c.crew.auth).send({ status: 'SERVED' }).expect(200);
    const back = await http().post(`/v1/sales/${sale.id}/returns`).set(c.manager.auth).set(key()).send({ cashierSessionId: c.session, kind: 'VOID', reason: 'Wrong order' }).expect(201);
    expect(back.body.amountDue).toBe('215.00');
    expect(await kds(c)).toEqual([]);
    const items = await sql<{ name: string; status: string; void_reason: string | null }>(c, `SELECT name, status, void_reason FROM order_items WHERE kind = 'ITEM' ORDER BY name`);
    expect(items).toEqual([{ name: 'Burger', status: 'VOIDED', void_reason: `Sale #${sale.saleNumber} voided` }, { name: 'Iced tea', status: 'SERVED', void_reason: null }]);
    expect(await audit(c)).toEqual({});
  });
});

describe('counter service offline', () => {
  it('the snapshot carries the menu and stations; an offline sale with choices records its kitchen copy as printed and served', async () => {
    const c = await cafe('cs-offline');
    const snap = (await http().get('/v1/terminal/snapshot').set(c.till1.headers).expect(200)).body as Snapshot;
    expect(snap.counter).toMatchObject({ menuVersionId: expect.any(String), stations: expect.arrayContaining([expect.objectContaining({ code: 'GRILL', isDefault: true })]) });
    const item = snap.counter!.items.find((i) => i.variantId === c.burger)!;
    expect(item).toMatchObject({ name: 'Burger', stationCode: 'GRILL' });
    expect(item.modifierGroups.map((g) => [g.name, g.minSelect, g.options.map((o) => [o.name, o.variantId])])).toEqual([
      ['Doneness', 1, [['Medium', null], ['Well done', null]]], ['Extras', 0, [['Cheese', c.cheese], ['No onions', null]]],
    ]);
    const cashierId = c.cashier.userId;
    const envelope = (over: Partial<OfflineSale>): OfflineSale => ({
      terminalTxnId: randomUUID(), deviceSeq: 1, snapshotId: snap.snapshotId, cashierSessionId: c.session, cashierUserId: cashierId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000001', menuVersionId: snap.counter!.menuVersionId, pickupName: 'Ben',
      lines: [{ id: 'b', variantId: c.burger, quantity: '1', choices: [c.medium, c.cheeseOpt], kitchenNote: 'No pickles' }],
      tenders: [{ method: 'CASH', tendered: '200.00' }], amountDue: '170.00', ...over,
    });
    const res = (await http().post('/v1/sync/sales').set(c.till1.headers).send({ sales: [envelope({})] }).expect(200)).body.results;
    expect(res[0]).toMatchObject({ status: 'RECORDED' });
    // Without the menu version the choices cannot be checked: quarantined, never lost.
    const bad = (await http().post('/v1/sync/sales').set(c.till1.headers).send({ sales: [envelope({ deviceSeq: 2, localReference: 'R1-OFF-000002', menuVersionId: undefined })] }).expect(200)).body.results;
    expect(bad[0]).toMatchObject({ status: 'QUARANTINED', code: 'COUNTER_SERVICE_OFF' });

    const lines = await sql<{ name: string; parent: boolean }>(c, `SELECT name, parent_line_id IS NOT NULL AS parent FROM sale_lines ORDER BY line_no`);
    expect(lines).toEqual([{ name: 'Burger', parent: false }, { name: 'Cheese slice', parent: true }]);
    const kitchen = await sql<{ status: string; printed: boolean; customer_name: string; note: string | null }>(c, `
      SELECT i.status, k.printed_at IS NOT NULL AS printed, o.customer_name, i.note FROM order_items i
        JOIN kitchen_tickets k ON k.id = i.kitchen_ticket_id JOIN restaurant_orders o ON o.id = i.order_id WHERE i.kind = 'ITEM'`);
    expect(kitchen).toEqual([{ status: 'SERVED', printed: true, customer_name: 'Ben', note: 'No pickles' }]);
    // The till printed it; nothing waits on the kitchen display or for a printer.
    expect(await kds(c)).toEqual([]);
    expect((await http().post('/v1/terminal/kitchen-tickets/claim').set(c.till1.headers).send({ stationIds: [c.grill, c.bar] }).expect(200)).body.data).toEqual([]);
    expect(await audit(c)).toEqual({});
  });
});

describe('kitchen printing from the desktop till', () => {
  it('tills claim their stations’ tickets once each, mark them printed or give them back; a reprint prints again', async () => {
    const c = await cafe('cs-print');
    const stations = (await http().get('/v1/terminal/kitchen-stations').set(c.till1.headers).expect(200)).body.data as { code: string }[];
    expect(stations.map((s) => s.code)).toEqual(['BAR', 'GRILL']);
    await sell(c, { lines: [burgerLine(c), { variantId: c.tea, quantity: '1' }], pickupName: 'Cy' }).expect(201);
    const claim = async (till: C['till1'], stationIds: string[]) =>
      (await http().post('/v1/terminal/kitchen-tickets/claim').set(till.headers).send({ stationIds }).expect(200)).body.data as KitchenTicketPrint[];
    const [g] = await claim(c.till1, [c.grill]);
    expect(g).toMatchObject({ reprint: false, station: { code: 'GRILL' }, order: { orderType: 'COUNTER', customerName: 'Cy' } });
    expect(g!.items).toEqual([{ name: 'Burger', quantity: '1', seat: null, note: null, choices: ['Medium', 'Cheese', 'No onions'] }]);
    // Held by till 1: till 2 gets nothing at the grill, the bar ticket for itself.
    expect(await claim(c.till2, [c.grill])).toEqual([]);
    const [b] = await claim(c.till2, [c.grill, c.bar]);
    expect(b!.station.code).toBe('BAR');
    expect((await http().post(`/v1/terminal/kitchen-tickets/${g!.id}/printed`).set(c.till2.headers).expect(409)).body.error.code).toBe('NOT_CLAIMED');
    expect((await http().post(`/v1/terminal/kitchen-tickets/${g!.id}/printed`).set(c.till1.headers).expect(200)).body).toMatchObject({ printCount: 1 });
    // The bar printer was out of paper: given back, till 1 prints it on its next round.
    await http().post(`/v1/terminal/kitchen-tickets/${b!.id}/release`).set(c.till2.headers).expect(200);
    expect((await claim(c.till1, [c.bar])).map((t) => t.id)).toEqual([b!.id]);
    // A claim that lapsed (till 1 crashed mid-print) is taken over.
    await sql(c, `UPDATE kitchen_tickets SET print_claimed_at = now() - interval '2 minutes' WHERE id = $1`, [b!.id]);
    expect((await claim(c.till2, [c.bar])).map((t) => t.id)).toEqual([b!.id]);
    await http().post(`/v1/terminal/kitchen-tickets/${b!.id}/printed`).set(c.till1.headers).expect(409);
    await http().post(`/v1/terminal/kitchen-tickets/${b!.id}/printed`).set(c.till2.headers).expect(200);
    // Reprint from the KDS: printed again, marked as a reprint.
    await http().post(`/v1/kitchen/tickets/${g!.id}/reprint`).set(c.cashier.auth).expect(200); // the floor may ask
    const [again] = await claim(c.till1, [c.grill]);
    expect(again).toMatchObject({ id: g!.id, reprint: true });
    await http().post(`/v1/terminal/kitchen-tickets/${g!.id}/printed`).set(c.till1.headers).expect(200);
    expect(await sql(c, `SELECT print_count FROM kitchen_tickets WHERE id = $1`, [g!.id])).toEqual([{ print_count: 2 }]);
    expect(await sql(c, `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'kitchen_ticket.reprint_requested'`)).toEqual([{ n: 1 }]);
    // Another business's till cannot claim or settle these.
    const other = await cafe('cs-print-other');
    expect(await claim(other.till1, [c.grill])).toEqual([]);
    await http().post(`/v1/terminal/kitchen-tickets/${g!.id}/printed`).set(other.till1.headers).expect(404);
  });
});

describe('tips', () => {
  it('cash and card tips are owed to staff, outside the sale; a void gives the tip back; paying out clears it', async () => {
    const c = await cafe('cs-tips');
    // ₱45 tea, ₱100 cash, ₱10 tip: ₱45 change.
    const cash = (await sell(c, { lines: [{ variantId: c.tea, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], tip: { amount: '10.00' } }).expect(201)).body;
    expect(cash).toMatchObject({ amountDue: '45.00', amountTendered: '90.00', changeDue: '45.00', tip: { method: 'CASH', amount: '10.00' } });
    expect(cash.tenders.map((t: { amount: string; tendered: string; change: string }) => [t.amount, t.tendered, t.change])).toEqual([['45.00', '90.00', '45.00']]);
    expect((await http().get(`/v1/sales/${cash.id}/receipt`).set(c.cashier.auth).expect(200)).body.tip).toEqual({ method: 'CASH', amount: '10.00' });
    // Card tip: its own payment of the same checkout.
    const txn = randomUUID();
    const intent = (amount: string, purpose = 'SALE') => http().post('/v1/payment-intents').set(c.cashier.auth).set(key()).send({ cashierSessionId: c.session, clientTransactionId: txn, method: 'CARD', amount, purpose }).expect(201).then((r) => r.body.id as string);
    const [pay, tipPay] = [await intent('45.00'), await intent('15.00', 'TIP')];
    // A tip's charge is never one of the sale's tenders, nor the sale's charge a tip.
    expect((await sell(c, { clientTransactionId: txn, lines: [{ variantId: c.tea, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: tipPay }, { method: 'CASH', tendered: '30.00' }] }).expect(422)).body.error.code).toBe('TIP_PAYMENT_AS_TENDER');
    const body = { clientTransactionId: txn, lines: [{ variantId: c.tea, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: pay }] };
    expect((await sell(c, { ...body, tip: { amount: '20.00', paymentIntentId: tipPay } }).expect(422)).body.error.code).toBe('TIP_MISMATCH');
    expect((await sell(c, { ...body, tip: { amount: '15.00', paymentIntentId: pay } }).expect(422)).body.error.code).toBe('DUPLICATE_TENDER');
    // A cash tip needs cash to come from.
    expect((await sell(c, { ...body, tip: { amount: '15.00' } }).expect(422)).body.error.code).toBe('INSUFFICIENT_TENDER');
    const card = (await sell(c, { ...body, tip: { amount: '15.00', paymentIntentId: tipPay } }).expect(201)).body;
    expect(card).toMatchObject({ amountDue: '45.00', tip: { method: 'CARD', amount: '15.00' } });
    expect((await http().get(`/v1/payment-intents/${tipPay}`).set(c.cashier.auth).expect(200)).body.saleId).toBe(card.id);

    // Void of the cash sale: the ₱45 and the ₱10 tip go back.
    const back = (await http().post(`/v1/sales/${cash.id}/returns`).set(c.manager.auth).set(key()).send({ cashierSessionId: c.session, kind: 'VOID', reason: 'Wrong drink' }).expect(201)).body;
    expect(back).toMatchObject({ amountDue: '45.00', tipRefund: '10.00' });
    // Tips handed to staff from the drawer.
    await http().post(`/v1/cashier-sessions/${c.session}/movements`).set(c.cashier.auth).send({ type: 'TIP_PAYOUT', amount: '15.00', reason: 'Card tips to the crew' }).expect(201);
    await http().post(`/v1/cashier-sessions/${c.session}/movements`).set(c.cashier.auth).send({ type: 'TIP_PAYOUT', amount: '99999.00', reason: 'Too much' }).expect(422);
    // Drawer: float 1000 + 45 + 10 − 45 − 10 − 15 (the card sale moved no cash).
    expect((await http().get(`/v1/cashier-sessions/${c.session}`).set(c.cashier.auth).expect(200)).body.expectedCash).toBe('985.00');

    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const report = (await http().get('/v1/reports/tips').query({ branchId: c.branchId, from: day, to: day }).set(c.auth).expect(200)).body;
    expect(report.totals).toEqual({ tips: 2, cash: '10.00', electronic: '15.00', taken: '25.00', refunded: '10.00', paidOut: '15.00', owed: '0.00' });
    expect(report.ledger).toBe('0.00');
    expect(report.byCashier).toEqual([{ userId: c.cashier.userId, name: expect.any(String), tips: 2, amount: '25.00' }]);
    const gl = await sql<{ net: string }>(c, `SELECT coalesce(sum(l.credit - l.debit), 0)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'TIPS_PAYABLE'`);
    expect(Number(gl[0]!.net)).toBe(0);
    expect(await audit(c)).toEqual({});
  });

  it('a restaurant check takes a tip too', async () => {
    const c = await cafe('cs-tips-check');
    const o = (await http().post('/v1/restaurant/orders').set(c.cashier.auth).send({ branchId: c.branchId, orderType: 'DINE_IN', tableId: c.t1 }).expect(201)).body.id as string;
    await http().post(`/v1/restaurant/orders/${o}/items`).set(c.cashier.auth).set(key()).send({ items: [{ variantId: c.tea, quantity: '2' }] }).expect(201);
    await http().post(`/v1/restaurant/orders/${o}/fire`).set(c.cashier.auth).send({}).expect(200);
    const bill = (await http().post(`/v1/restaurant/orders/${o}/bill`).set(c.cashier.auth).set(key()).send({}).expect(201)).body;
    const check = (await http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(c.cashier.auth).set(key())
      .send({ cashierSessionId: c.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '100.00' }], tip: { amount: '10.00' } }).expect(201)).body;
    expect(check).toMatchObject({ amountDue: '90.00', changeDue: '0.00', billSettled: true, tip: { amount: '10.00' } });
    expect(await audit(c)).toEqual({});
  });
});

describe('tips given back on a void, offline tips, the till’s call number', () => {
  const provider = () => app.get(DevPaymentProvider) as unknown as { charges: Map<string, unknown>; cancel: (id: string) => Promise<unknown>; retrieve: (id: string) => Promise<unknown> };
  async function cardTipSale(c: C, tip = '15.00') {
    const txn = randomUUID();
    const tipPay = (await http().post('/v1/payment-intents').set(c.cashier.auth).set(key()).send({ cashierSessionId: c.session, clientTransactionId: txn, method: 'CARD', amount: tip, purpose: 'TIP' }).expect(201)).body.id as string;
    const sale = (await sell(c, { clientTransactionId: txn, lines: [{ variantId: c.tea, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '50.00' }], tip: { amount: tip, paymentIntentId: tipPay } }).expect(201)).body;
    return { sale, tipPay };
  }
  const voidSale = (c: C, saleId: string) => http().post(`/v1/sales/${saleId}/returns`).set(c.manager.auth).set(key()).send({ cashierSessionId: c.session, kind: 'VOID', reason: 'Wrong order' });
  const drawer = async (c: C) => (await http().get(`/v1/cashier-sessions/${c.session}`).set(c.cashier.auth).expect(200)).body.expectedCash as string;

  it('a void cancels the card tip’s charge with the provider; no cash leaves for it', async () => {
    const c = await cafe('cs-tipvoid-card');
    const { sale, tipPay } = await cardTipSale(c);
    const back = (await voidSale(c, sale.id).expect(201)).body;
    expect(back).toMatchObject({ amountDue: '45.00', tipRefund: '0.00', cardTipRefund: { method: 'CARD', amount: '15.00' }, tipRefundPending: false });
    expect((await http().get(`/v1/payment-intents/${tipPay}`).set(c.cashier.auth).expect(200)).body.status).toBe('CANCELED');
    expect(await drawer(c)).toBe('1000.00'); // +45 sale −45 void; the card tip never touched the drawer
    // Once only.
    expect((await http().post(`/v1/sale-returns/${back.id}/tip-refund`).set(c.manager.auth).send({}).expect(200)).body.cardTipRefund.method).toBe('CARD');
    expect(await sql(c, `SELECT count(*)::int AS n FROM sale_tip_refunds`)).toEqual([{ n: 1 }]);
    const gl = await sql<{ net: string }>(c, `SELECT coalesce(sum(l.credit - l.debit), 0)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'TIPS_PAYABLE'`);
    expect(Number(gl[0]!.net)).toBe(0);
    expect(await audit(c)).toEqual({});
    // The entry is final: no reversal by hand.
    const [entry] = await sql<{ id: string }>(c, `SELECT id FROM journal_entries WHERE source_type = 'SALE_TIP_REFUND'`);
    expect((await http().post(`/v1/journal-entries/${entry!.id}/reverse`).set(c.auth).set(key()).send({ memo: 'Undo the tip refund' }).expect(422)).body.error.code).toBe('NOT_REVERSIBLE');
  });

  it('a provider that cannot be reached leaves it pending; the retry finishes it; one that refuses gives cash', async () => {
    const c = await cafe('cs-tipvoid-retry');
    const p = provider();
    const { sale, tipPay } = await cardTipSale(c);
    const cancel = p.cancel.bind(p);
    p.cancel = async () => { throw new Error('provider down'); };
    let back;
    try {
      back = (await voidSale(c, sale.id).expect(201)).body;
    } finally {
      p.cancel = cancel;
    }
    expect(back).toMatchObject({ tipRefundPending: true, cardTipRefund: null });
    expect((await http().post(`/v1/sale-returns/${back.id}/tip-refund`).set(c.cashier.auth).send({}).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await http().post(`/v1/sale-returns/${back.id}/tip-refund`).set(c.manager.auth).send({}).expect(200)).body).toMatchObject({ tipRefundPending: false, cardTipRefund: { method: 'CARD' } });
    expect((await http().get(`/v1/payment-intents/${tipPay}`).set(c.cashier.auth).expect(200)).body.status).toBe('CANCELED');

    // The charge the provider no longer knows: refused, so the tip goes back in cash from the drawer.
    const second = await cardTipSale(c, '12.00');
    p.charges.delete(second.tipPay);
    const refused = (await voidSale(c, second.sale.id).expect(201)).body;
    expect(refused.cardTipRefund).toEqual({ method: 'CASH', amount: '12.00' });
    expect(await drawer(c)).toBe('988.00'); // the two teas came and went; 12 out for the refused card tip
    expect(await audit(c)).toEqual({});
  });

  it('an offline till takes a cash tip, and its call number stays the order’s', async () => {
    const c = await cafe('cs-offline-tip');
    const snap = (await http().get('/v1/terminal/snapshot').set(c.till1.headers).expect(200)).body as Snapshot;
    const env: OfflineSale = {
      terminalTxnId: randomUUID(), deviceSeq: 42, snapshotId: snap.snapshotId, cashierSessionId: c.session, cashierUserId: c.cashier.userId,
      occurredAt: new Date().toISOString(), localReference: 'R1-OFF-000042', menuVersionId: snap.counter!.menuVersionId,
      lines: [{ variantId: c.tea, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }], amountDue: '45.00', tip: { amount: '5.00' },
    };
    expect((await http().post('/v1/sync/sales').set(c.till1.headers).send({ sales: [env] }).expect(200)).body.results[0]).toMatchObject({ status: 'RECORDED' });
    const [saleRow] = await sql<{ id: string }>(c, `SELECT id FROM sales`);
    const sale = (await http().get(`/v1/sales/${saleRow!.id}`).set(c.cashier.auth).expect(200)).body;
    expect(sale).toMatchObject({ amountDue: '45.00', changeDue: '50.00', tip: { method: 'CASH', amount: '5.00' }, counterOrder: { callNumber: 42 } });
    expect((await http().get(`/v1/sales/${sale.id}/receipt`).set(c.cashier.auth).expect(200)).body.callNumber).toBe(42);
    expect((await kds(c, 'ALL'))[0]!.order.orderNumber).toBe(42);
    expect(await drawer(c)).toBe('1050.00');
    expect(await audit(c)).toEqual({});
  });
});

describe('changing a pending item’s choices in place', () => {
  it('replaces the choices whole, checked against the menu; refused once sent', async () => {
    const c = await cafe('cs-choices');
    const o = (await http().post('/v1/restaurant/orders').set(c.cashier.auth).send({ branchId: c.branchId, orderType: 'DINE_IN', tableId: c.t1 }).expect(201)).body.id as string;
    const added = (await http().post(`/v1/restaurant/orders/${o}/items`).set(c.cashier.auth).set(key()).send({ items: [{ variantId: c.burger, quantity: '2', seat: 1, modifierOptionIds: [c.medium] }] }).expect(201)).body;
    const itemId = added.items[0].id as string;
    const patch = (body: Record<string, unknown>) => http().patch(`/v1/order-items/${itemId}`).set(c.cashier.auth).send(body);
    expect((await patch({ modifierOptionIds: [c.cheeseOpt] }).expect(422)).body.error.code).toBe('MODIFIER_COUNT');
    const changed = (await patch({ modifierOptionIds: [c.wellDone, c.cheeseOpt], note: 'Toasted bun' }).expect(200)).body.items[0];
    expect(changed.note).toBe('Toasted bun');
    expect(changed.modifiers.map((m: { name: string; quantity: string; seat: number }) => [m.name, m.quantity, m.seat])).toEqual([['Well done', '2', 1], ['Cheese', '2', 1]]);
    // The bill charges the new choices.
    await http().post(`/v1/restaurant/orders/${o}/fire`).set(c.cashier.auth).send({}).expect(200);
    expect((await patch({ modifierOptionIds: [c.medium] }).expect(409)).body.error.code).toBe('ITEM_FIRED');
    expect((await http().post(`/v1/restaurant/orders/${o}/bill`).set(c.cashier.auth).set(key()).send({}).expect(201)).body.amountDue).toBe('340.00');
  });
});

describe('free choices in item performance', () => {
  it('count once their order is fully paid, under their item, unless voided', async () => {
    const c = await cafe('cs-free');
    await sell(c, { lines: [burgerLine(c, { quantity: '2' })] }).expect(201);
    const voided = (await sell(c, { lines: [burgerLine(c)] }).expect(201)).body;
    await http().post(`/v1/sales/${voided.id}/returns`).set(c.manager.auth).set(key()).send({ cashierSessionId: c.session, kind: 'VOID', reason: 'Mistake' }).expect(201);
    // A table order with "No onions" not yet paid does not count.
    const o = (await http().post('/v1/restaurant/orders').set(c.cashier.auth).send({ branchId: c.branchId, orderType: 'DINE_IN', tableId: c.t1 }).expect(201)).body.id as string;
    await http().post(`/v1/restaurant/orders/${o}/items`).set(c.cashier.auth).set(key()).send({ items: [{ variantId: c.burger, quantity: '1', modifierOptionIds: [c.medium, c.noOnions] }] }).expect(201);
    await http().post(`/v1/restaurant/orders/${o}/fire`).set(c.cashier.auth).send({}).expect(200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const report = async () => ((await http().get('/v1/reports/item-performance').query({ branchId: c.branchId, from: day, to: day }).set(c.auth).expect(200)).body.data as { name: string; freeChoices: { name: string; quantity: string; orders: number }[] }[])
      .find((d) => d.name === 'Burger')!.freeChoices;
    expect(await report()).toEqual([{ modifierOptionId: c.medium, name: 'Medium', quantity: '2', orders: 1 }, { modifierOptionId: c.noOnions, name: 'No onions', quantity: '2', orders: 1 }]);
    const bill = (await http().post(`/v1/restaurant/orders/${o}/bill`).set(c.cashier.auth).set(key()).send({}).expect(201)).body;
    await http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(c.cashier.auth).set(key()).send({ cashierSessionId: c.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '200.00' }] }).expect(201);
    expect(await report()).toEqual([{ modifierOptionId: c.medium, name: 'Medium', quantity: '3', orders: 2 }, { modifierOptionId: c.noOnions, name: 'No onions', quantity: '3', orders: 2 }]);
  });
});

describe('selling by weight', () => {
  it('a restaurant cannot create a product sold by weight; a business that is both can', async () => {
    const c = await cafe('cs-weight');
    const kg = ((await http().get('/v1/uoms').set(c.auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'KG')!.id;
    const vat = ((await http().get('/v1/tax-categories').set(c.auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const create = () => http().post('/v1/products').set(c.auth).send({ name: uniq('Rice'), uomId: kg, taxCategoryId: vat, soldBy: 'WEIGHT', trackInventory: true, variants: [{ sku: uniq('SKU'), price: '60.00' }] });
    await http().patch('/v1/business').set(c.auth).send({ businessType: 'RESTAURANT' }).expect(200);
    expect((await create().expect(422)).body.error).toMatchObject({ code: 'BUSINESS_TYPE_EXCLUDES_FEATURE', details: { feature: 'sold_by_weight' } });
    await http().patch('/v1/business').set(c.auth).send({ businessType: 'HYBRID' }).expect(200);
    await create().expect(201);
  });
});
