import type { INestApplication } from '@nestjs/common';
import { toDec } from '@1pos/money';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Phase 4 exit review — restaurant drills (ADR-0014). Two tills paying one bill at once, two tablets
 * on one order, voids racing the kitchen, the bill and settlement, and the connection dying in the
 * middle of a check: a bill line is never paid twice, Σ checks = the bill, nothing is half-recorded,
 * and stock and books stay traceable after every drill.
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

type Headers = { Authorization: string };

/**
 * A VAT restaurant with two tills: Burger ₱150 (recipe bun + 0.15 kg beef; doneness required; cheese
 * slice ₱20 extra), Iced tea ₱45; service charge 10 % on dine-in. Till 1 (R1) and till 2 (R2) each have
 * their own cashier and shift; a manager voids.
 */
async function restaurant(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const register = async (code: string) => (await http().post('/v1/registers').set(auth).send({ branchId, code, name: code }).expect(201)).body.id as string;
  const [r1, r2] = [await register('R1'), await register('R2')];
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
  await http().post('/v1/stock/adjustments').set(auth).send({ branchId, reason: 'Opening', items: [
    { variantId: bun, quantity: '50', unitCost: '5.00' }, { variantId: beef, quantity: '5', unitCost: '400.00' }, { variantId: cheese, quantity: '40', unitCost: '3.00' },
  ] }).expect(201);
  await http().post(`/v1/variants/${burger}/recipe`).set(auth).send({ ingredients: [{ variantId: bun, quantity: '1' }, { variantId: beef, quantity: '0.15' }] }).expect(201);
  await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'GRILL', name: 'Grill', isDefault: true }).expect(201);
  const area = (await http().post('/v1/dining-areas').set(auth).send({ branchId, name: 'Hall' }).expect(201)).body.id as string;
  const tables: string[] = [];
  for (const code of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) tables.push((await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area, code }).expect(201)).body.id);
  const doneness = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(auth).send({ name: 'All day' }).expect(201)).body;
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [
    { name: 'Mains', items: [{ variantId: burger, modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea }] },
  ] }).expect(200);
  await http().post(`/v1/menu-versions/${menu.draft.id}/publish`).set(auth).expect(200);
  await http().put(`/v1/branches/${branchId}/restaurant-settings`).set(auth).send({ dineInMenuId: menu.id, takeawayMenuId: menu.id, serviceChargeRate: '0.10', serviceChargeDineIn: true, serviceChargeTakeaway: false, serviceChargeVatTreatment: 'VATABLE' }).expect(200);
  const login = async (role: string) => bearer(await loginToken(app, (await addMember(owner, t.tenantId, role, { type: 'BRANCH', id: branchId })).email));
  const till = async (registerId: string) => {
    const headers = await login('cashier');
    const session = (await http().post('/v1/cashier-sessions').set(headers).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
    return { headers, session };
  };
  const opt = (g: { options: { id: string; name: string }[] }, name: string) => g.options.find((o) => o.name === name)!.id;
  return {
    tenantId: t.tenantId, auth, branchId, tables, bun, beef, cheese, burger, tea,
    medium: opt(doneness, 'Medium'), cheeseOpt: opt(extras, 'Cheese'),
    till1: await till(r1), till2: await till(r2), manager: await login('branch_manager'), kitchen: await login('branch_manager'),
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;
type Till = R['till1'];

const key = () => ({ 'Idempotency-Key': randomUUID() });
const code = (res: request.Response) => res.body.error?.code;
const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) => asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const audit = (r: R) => asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c));

const BURGERS_AND_TEA = (r: R) => [
  { variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] },
  { variantId: r.tea, quantity: '2' },
]; // ₱430.00 + service charge 38.39 + VAT 4.61 = ₱473.00

const openOrder = async (r: R, table: string, who: Headers = r.till1.headers) =>
  (await http().post('/v1/restaurant/orders').set(who).send({ branchId: r.branchId, orderType: 'DINE_IN', tableId: table }).expect(201)).body.id as string;
const addItems = (r: R, orderId: string, items: unknown[], who: Headers = r.till1.headers) =>
  http().post(`/v1/restaurant/orders/${orderId}/items`).set(who).set(key()).send({ items });
const fire = (r: R, orderId: string, who: Headers = r.till1.headers) => http().post(`/v1/restaurant/orders/${orderId}/fire`).set(who).send({});
const getOrder = async (r: R, orderId: string) => (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.manager).expect(200)).body;
async function servedOrder(r: R, table: string, items: unknown[]) {
  const id = await openOrder(r, table);
  await addItems(r, id, items).expect(201);
  await fire(r, id).expect(200);
  return id;
}
const billOrder = (r: R, orderId: string, who: Headers = r.till1.headers) => http().post(`/v1/restaurant/orders/${orderId}/bill`).set(who).set(key()).send({});
const checkBody = (till: Till, body: Record<string, unknown> = {}) => ({ cashierSessionId: till.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '1000.00' }], ...body });
const check = (billId: string, till: Till, body: Record<string, unknown> = {}, idem = key()) =>
  http().post(`/v1/restaurant/bills/${billId}/checks`).set(till.headers).set(idem).send(checkBody(till, body));
const preview = (billId: string, till: Till, body: Record<string, unknown> = {}) => http().post(`/v1/restaurant/bills/${billId}/checks/preview`).set(till.headers).send(body);
const voidItem = (r: R, itemId: string, wasted = true) => http().post(`/v1/order-items/${itemId}/void`).set(r.manager).set(key()).send({ reason: 'Dropped', wasted });

/** What a bill's checks recorded, bucket by bucket, and whether any line was paid beyond the whole. */
async function billEvidence(r: R, billId: string) {
  const [row] = await sql<Record<string, string | number>>(r, `
    SELECT (SELECT count(*)::int FROM sales WHERE order_bill_id = $1) AS checks,
           (SELECT coalesce(sum(amount_due), 0)::text FROM sales WHERE order_bill_id = $1) AS paid,
           (SELECT coalesce(sum(c.base), 0)::text FROM sale_charges c JOIN sales s ON s.id = c.sale_id WHERE s.order_bill_id = $1) AS bases,
           (SELECT count(*)::int FROM (SELECT bill_line_id FROM order_bill_allocations WHERE order_bill_id = $1
               GROUP BY 1 HAVING sum(share_num::numeric / share_den) > 1.0000001) x) AS overpaid,
           (SELECT status FROM order_bills WHERE id = $1) AS status`, [billId]);
  return row!;
}

/** Everything a check writes, to show a failed one left nothing behind. */
async function footprint(r: R) {
  return asOwnerInTenant(owner, r.tenantId, async (q) => {
    const n = async (s: string) => Number((await q.query(s)).rows[0].n);
    return {
      sales: await n(`SELECT count(*) AS n FROM sales`),
      lines: await n(`SELECT count(*) AS n FROM sale_lines`),
      charges: await n(`SELECT count(*) AS n FROM sale_charges`),
      allocations: await n(`SELECT count(*) AS n FROM order_bill_allocations`),
      cash: await n(`SELECT count(*) AS n FROM cash_movements WHERE type = 'SALE'`),
      stock: await n(`SELECT count(*) AS n FROM stock_movements WHERE sale_id IS NOT NULL`),
      numbers: await n(`SELECT coalesce(sum(next_value - 1), 0) AS n FROM sequence_counters WHERE name = 'SALE'`),
      entries: await n(`SELECT count(*) AS n FROM journal_entries WHERE source_type = 'SALE'`),
      keys: await n(`SELECT count(*) AS n FROM idempotency_records`),
    };
  });
}

/** Close a till's shift with its expected cash; it must reconcile to the centavo. */
async function closeBalanced(r: R, till: Till) {
  const s = (await http().get(`/v1/cashier-sessions/${till.session}`).set(till.headers).expect(200)).body;
  const closed = (await http().post(`/v1/cashier-sessions/${till.session}/close`).set(till.headers).send({ countedCash: s.expectedCash }).expect(200)).body;
  expect(closed.status).toBe('RECONCILED');
  const [drawer] = await sql<{ cash: string }>(r, `SELECT coalesce(sum(amount), 0)::text AS cash FROM cash_movements WHERE cashier_session_id = $1`, [till.session]);
  expect(toDec(drawer!.cash).equals(s.expectedCash)).toBe(true);
  return s.expectedCash as string;
}

describe('two tills, one bill', () => {
  it('two diners pay their halves at two tills at once: both recorded, the second to commit settles, Σ checks = the bill', async () => {
    const r = await restaurant('drill-halves');
    const orderId = await servedOrder(r, r.tables[0]!, BURGERS_AND_TEA(r));
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const half = { num: 1, den: 2 };
    const allocations = bill.lines.filter((l: { parentLineId: string | null }) => !l.parentLineId).map((l: { id: string }) => ({ billLineId: l.id, share: half }));
    const shown = (await preview(bill.id, r.till1, { allocations }).expect(200)).body.amountDue;
    expect(shown).toBe('236.50');

    const [a, b] = await Promise.all([r.till1, r.till2].map((t) => check(bill.id, t, { allocations, expectedAmountDue: shown })));
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect([a!.body.billSettled, b!.body.billSettled].sort()).toEqual([false, true]);
    expect([a!.body.amountDue, b!.body.amountDue]).toEqual(['236.50', '236.50']);
    expect(await billEvidence(r, bill.id)).toEqual({ checks: 2, paid: '473.0000', bases: '383.9300', overpaid: 0, status: 'SETTLED' });
    expect((await getOrder(r, orderId)).status).toBe('SETTLED');

    // Each till's drawer holds only its own diner's cash.
    expect(await closeBalanced(r, r.till1)).toBe('1236.50');
    expect(await closeBalanced(r, r.till2)).toBe('1236.50');
    expect(await audit(r)).toEqual(CLEAN);
  });

  it('three thirds from one preview at three requests: the check that turns out last is refused with its new amount, never charged a different total', async () => {
    const r = await restaurant('drill-thirds');
    const orderId = await servedOrder(r, r.tables[0]!, BURGERS_AND_TEA(r));
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const third = { num: 1, den: 3 };
    const allocations = bill.lines.filter((l: { parentLineId: string | null }) => !l.parentLineId).map((l: { id: string }) => ({ billLineId: l.id, share: third }));
    const shown = (await preview(bill.id, r.till1, { allocations }).expect(200)).body.amountDue;
    expect(shown).toBe('157.66');

    const tills = [r.till1, r.till2, r.till1];
    const res = await Promise.all(tills.map((t) => check(bill.id, t, { allocations, expectedAmountDue: shown })));
    expect(res.map((x) => x.status).sort()).toEqual([201, 201, 409]);
    const refused = res.find((x) => x.status === 409)!;
    // The last third takes the remainder (473.00 − 2 × 157.66), so it is not the amount the diner was shown.
    expect(refused.body.error).toMatchObject({ code: 'TOTAL_CHANGED', details: { amountDue: '157.68' } });
    expect(await billEvidence(r, bill.id)).toMatchObject({ checks: 2, paid: '315.3200', overpaid: 0, status: 'ACTIVE' });

    // The till re-previews, shows ₱157.68, and the last diner pays it.
    const again = (await preview(bill.id, r.till2, { allocations }).expect(200)).body;
    expect([again.amountDue, again.settles]).toEqual(['157.68', true]);
    expect((await check(bill.id, r.till2, { allocations, expectedAmountDue: again.amountDue }).expect(201)).body.billSettled).toBe(true);
    expect(await billEvidence(r, bill.id)).toEqual({ checks: 3, paid: '473.0000', bases: '383.9300', overpaid: 0, status: 'SETTLED' });
    expect(await audit(r)).toEqual(CLEAN);
  });

  it('the same item at both tills, then "pay the rest" by cash at one and by card at the other: each paid once; the losing card is cancelled before the shift closes', async () => {
    const r = await restaurant('drill-rest');
    const orderId = await servedOrder(r, r.tables[0]!, BURGERS_AND_TEA(r));
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const teaLine = bill.lines.find((l: { name: string }) => l.name === 'Iced tea');

    // Both tills take one tea for the same diner: one check, the other is told the line is paid.
    const teas = await Promise.all([r.till1, r.till2].map((t) => check(bill.id, t, { allocations: [{ billLineId: teaLine.id, quantity: '2' }] })));
    expect(teas.map((x) => x.status).sort()).toEqual([201, 422]);
    expect(code(teas.find((x) => x.status === 422)!)).toBe('ALLOCATION_EXCEEDS_LINE');

    // The rest: till 1 in cash, till 2 by a card already authorized for it. One wins.
    const rest = (await preview(bill.id, r.till2).expect(200)).body.amountDue;
    expect(rest).toBe('374.00'); // 473.00 − the teas' check (90.00 + 9.00 of the charge)
    const cardTx = randomUUID();
    const intent = (await http().post('/v1/payment-intents').set(r.till2.headers).set(key())
      .send({ cashierSessionId: r.till2.session, clientTransactionId: cardTx, method: 'CARD', amount: rest }).expect(201)).body;
    expect(intent.status).toBe('SUCCEEDED');
    const [cash, card] = await Promise.all([
      check(bill.id, r.till1, { expectedAmountDue: rest }),
      http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(r.till2.headers).set(key())
        .send({ cashierSessionId: r.till2.session, clientTransactionId: cardTx, tenders: [{ method: 'INTENT', paymentIntentId: intent.id }], expectedAmountDue: rest }),
    ]);
    expect([cash!.status, card!.status].sort()).toEqual([201, 409]);
    expect(code([cash!, card!].find((x) => x.status === 409)!)).toBe('BILL_NOT_ACTIVE');
    expect(await billEvidence(r, bill.id)).toEqual({ checks: 2, paid: '473.0000', bases: '383.9300', overpaid: 0, status: 'SETTLED' });

    if (card!.status === 409) {
      // The authorized card paid nothing: till 2 cannot close over it until it is cancelled (ADR-0010 §6).
      const blocked = await http().post(`/v1/cashier-sessions/${r.till2.session}/close`).set(r.till2.headers).send({ countedCash: '1000.00' }).expect(409);
      expect(code(blocked)).toBe('PAYMENTS_OUTSTANDING');
      await http().post(`/v1/payment-intents/${intent.id}/cancel`).set(r.till2.headers).expect(200);
    }
    await closeBalanced(r, r.till1);
    await closeBalanced(r, r.till2);
    const [intents] = await sql<{ consumed: number; open: number }>(r, `
      SELECT count(*) FILTER (WHERE sale_id IS NOT NULL)::int AS consumed, count(*) FILTER (WHERE sale_id IS NULL AND status = 'SUCCEEDED')::int AS open FROM payment_intents`);
    expect(intents).toEqual({ consumed: card!.status === 201 ? 1 : 0, open: 0 });
    expect(await audit(r)).toEqual(CLEAN);
  });

  it('a double-tapped check (same key ×5, at once) records one sale; reopening the bill while a check is paid: one of them wins', async () => {
    const r = await restaurant('drill-tap');
    const orderId = await servedOrder(r, r.tables[0]!, BURGERS_AND_TEA(r));
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const idem = key();
    const body = checkBody(r.till1, { allocations: [{ billLineId: bill.lines[0].id, quantity: '1' }] });
    const taps = await Promise.all([0, 1, 2, 3, 4].map(() => http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(r.till1.headers).set(idem).send(body)));
    const ok = taps.filter((x) => x.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((x) => x.body.id)).size).toBe(1); // replays answer the same sale
    for (const x of taps.filter((t) => t.status !== 201)) expect(code(x)).toMatch(/IDEMPOTENCY_IN_PROGRESS|DUPLICATE_TRANSACTION/);
    expect(await billEvidence(r, bill.id)).toMatchObject({ checks: 1, overpaid: 0 });

    // A second bill on another table: the reopen and the first check race.
    const other = await servedOrder(r, r.tables[1]!, BURGERS_AND_TEA(r));
    const b2 = (await billOrder(r, other).expect(201)).body;
    const [paid, reopened] = await Promise.all([
      check(b2.id, r.till2, { allocations: [{ billLineId: b2.lines[0].id, quantity: '1' }] }),
      http().post(`/v1/restaurant/bills/${b2.id}/void`).set(r.till1.headers).send({ reason: 'Adding dessert' }),
    ]);
    if (paid!.status === 201) {
      expect([reopened!.status, code(reopened!)]).toEqual([409, 'BILL_HAS_CHECKS']);
      expect((await getOrder(r, other)).status).toBe('BILLED');
    } else {
      expect([paid!.status, code(paid!), reopened!.status]).toEqual([409, 'BILL_NOT_ACTIVE', 200]);
      expect((await getOrder(r, other)).status).toBe('OPEN');
      expect(await billEvidence(r, b2.id)).toMatchObject({ checks: 0, status: 'VOIDED' });
    }
    expect(await audit(r)).toEqual(CLEAN);
  });
});

describe('two tablets, one order', () => {
  it('one tablet sends to the kitchen while the other adds and edits: no item lost, none fired twice, the bill holds exactly the live items', async () => {
    const r = await restaurant('drill-tablets');
    const tabletB = r.till2.headers;
    const orderId = await openOrder(r, r.tables[0]!);
    await addItems(r, orderId, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] }]).expect(201);
    const pending = (await addItems(r, orderId, [{ variantId: r.tea, quantity: '1' }], tabletB).expect(201)).body;
    const teaId = pending.items.find((i: { name: string }) => i.name === 'Iced tea').id;

    // A fires; B adds two more teas and changes the first tea to 3, all at once.
    const [fired, added, edited] = await Promise.all([
      fire(r, orderId),
      addItems(r, orderId, [{ variantId: r.tea, quantity: '2' }], tabletB),
      http().patch(`/v1/order-items/${teaId}`).set(tabletB).send({ quantity: '3' }),
    ]);
    expect([fired.status, added.status]).toEqual([200, 201]);
    // The edit landed before the fire (200) or was refused because the tea had gone to the kitchen.
    if (edited.status !== 200) expect(code(edited)).toBe('ITEM_FIRED');
    await fire(r, orderId).expect(200); // whatever B added after the fire goes now

    const order = await getOrder(r, orderId);
    const items = order.items.filter((i: { kind: string }) => i.kind === 'ITEM');
    expect(items.map((i: { status: string }) => i.status)).toEqual(['FIRED', 'FIRED', 'FIRED']);
    const tickets = await sql<{ item: string; n: number }>(r, `SELECT id::text AS item, count(DISTINCT kitchen_ticket_id)::int AS n FROM order_items WHERE order_id = $1 GROUP BY 1`, [orderId]);
    expect(tickets.every((t) => t.n === 1)).toBe(true); // every item (and choice) on exactly one ticket
    const teas = items.filter((i: { name: string }) => i.name === 'Iced tea').reduce((a: number, i: { quantity: string }) => a + Number(i.quantity), 0);
    expect(teas).toBe(edited.status === 200 ? 5 : 3);

    // B adds while A prints the bill: either the bill waits for it to be sent, or the add is refused.
    const [late, bill] = await Promise.all([addItems(r, orderId, [{ variantId: r.tea, quantity: '1' }], tabletB), billOrder(r, orderId)]);
    if (late.status === 201) {
      expect([bill.status, code(bill)]).toEqual([409, 'ORDER_HAS_PENDING_ITEMS']);
      await fire(r, orderId).expect(200);
    } else {
      expect([late.status, code(late), bill.status]).toEqual([409, 'ORDER_NOT_OPEN', 201]);
    }
    const final = bill.status === 201 ? bill.body : (await billOrder(r, orderId).expect(201)).body;
    const live = (await getOrder(r, orderId)).items.filter((i: { status: string }) => i.status !== 'VOIDED');
    const billed = final.lines.reduce((a: number, l: { quantity: string }) => a + Number(l.quantity), 0);
    expect(billed).toBe(live.reduce((a: number, i: { quantity: string }) => a + Number(i.quantity), 0));
    await check(final.id, r.till1).expect(201);
    expect(await audit(r)).toEqual(CLEAN);
  });
});

describe('voids racing the kitchen, the bill and each other', () => {
  it('a void while the bill is printed: either the bill leaves the item out, or the void is refused; never a billed item that was voided', async () => {
    const r = await restaurant('drill-void-bill');
    const outcomes: string[] = [];
    // Several tables so both interleavings get a chance to happen.
    for (const table of r.tables.slice(0, 4)) {
      const orderId = await servedOrder(r, table, BURGERS_AND_TEA(r));
      const teaItem = (await getOrder(r, orderId)).items.find((i: { name: string }) => i.name === 'Iced tea');
      const [voided, bill] = await Promise.all([voidItem(r, teaItem.id, false), billOrder(r, orderId)]);
      if (voided.status === 200) {
        // Void first: the bill (if it waited) has no tea; if the bill had been refused it is printed now.
        const b = bill.status === 201 ? bill.body : (await billOrder(r, orderId).expect(201)).body;
        expect(b.lines.map((l: { name: string }) => l.name)).toEqual(['Burger', 'Cheese']);
        expect(b.amountDue).toBe('374.00'); // 340 + 30.36 charge + 3.64 VAT
        outcomes.push('void first');
      } else {
        expect([voided.status, code(voided), bill.status]).toEqual([409, 'ORDER_NOT_OPEN', 201]);
        expect(bill.body.amountDue).toBe('473.00');
        outcomes.push('bill first');
      }
      const b = (await getOrder(r, orderId)).bill;
      await check(b.id, r.till1).expect(201);
    }
    expect(outcomes).toHaveLength(4);
    expect(await audit(r)).toEqual(CLEAN);
  });

  it('a wasted void while the kitchen marks the item ready, and two managers voiding it at once: voided once, written off once', async () => {
    const r = await restaurant('drill-void-kds');
    const orderId = await servedOrder(r, r.tables[0]!, [{ variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.cheeseOpt] }]);
    const burger = (await getOrder(r, orderId)).items.find((i: { name: string }) => i.name === 'Burger');
    await http().post(`/v1/order-items/${burger.id}/status`).set(r.kitchen).send({ status: 'IN_PREP' }).expect(200);
    const ticket = burger.kitchenTicketId as string;

    const [v1, v2, ready, bump] = await Promise.all([
      voidItem(r, burger.id),
      voidItem(r, burger.id),
      http().post(`/v1/order-items/${burger.id}/status`).set(r.kitchen).send({ status: 'READY' }),
      http().post(`/v1/kitchen/tickets/${ticket}/bump`).set(r.kitchen).send({}),
    ]);
    expect([v1.status, v2.status].sort()).toEqual([200, 409]);
    expect(code([v1, v2].find((x) => x.status === 409)!)).toBe('ALREADY_VOIDED');
    // The kitchen either got there first or is told the item is voided; bump simply skips it.
    if (ready.status !== 200) expect(code(ready)).toBe('INVALID_TRANSITION');
    expect(bump.status).toBe(200);

    const items = await sql<{ kind: string; status: string }>(r, `SELECT kind, status FROM order_items WHERE order_id = $1 ORDER BY kind`, [orderId]);
    expect(items.map((i) => [i.kind, i.status])).toEqual([['ITEM', 'VOIDED'], ['MODIFIER', 'VOIDED'], ['MODIFIER', 'VOIDED']]); // burger, Medium, Cheese
    const waste = await sql<{ docs: number; buns: string; cheese: string }>(r, `
      SELECT (SELECT count(*)::int FROM stock_adjustments WHERE kind = 'WASTE') AS docs,
             (SELECT sum(quantity)::text FROM stock_movements WHERE type = 'WASTE' AND variant_id = $1) AS buns,
             (SELECT sum(quantity)::text FROM stock_movements WHERE type = 'WASTE' AND variant_id = $2) AS cheese`, [r.bun, r.cheese]);
    expect(waste).toEqual([{ docs: 1, buns: '-1.0000', cheese: '-1.0000' }]);
    // The order now has nothing to bill and can be cancelled.
    expect(code(await billOrder(r, orderId).expect(422))).toBe('NOTHING_TO_BILL');
    await http().post(`/v1/restaurant/orders/${orderId}/cancel`).set(r.till1.headers).send({ reason: 'Guest left' }).expect(200);
    expect(await audit(r)).toEqual(CLEAN);
  });
});

describe('the audit itself', () => {
  it('reports an order settled behind its bill’s back (mutation check of the restaurant rules)', async () => {
    const r = await restaurant('drill-audit');
    const orderId = await servedOrder(r, r.tables[0]!, [{ variantId: r.tea, quantity: '1' }]);
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const found = await asOwnerInTenant(owner, r.tenantId, async (c) => {
      await c.query('SAVEPOINT forge');
      await c.query(`UPDATE restaurant_orders SET status = 'SETTLED', closed_at = now() WHERE id = $1`, [orderId]); // the bill is still ACTIVE
      const audit = await traceabilityAudit(c);
      await c.query('ROLLBACK TO SAVEPOINT forge');
      return audit;
    });
    expect(found['order and bill states disagree']).toEqual([{ id: orderId, status: 'SETTLED', bill: 'ACTIVE' }]);
    await check(bill.id, r.till1).expect(201);
    expect(await audit(r)).toEqual(CLEAN);
  });
});

describe('connection lost in the middle of a check', () => {
  it('the check waits on the bill, its connection is killed: 503, nothing written, the bill unpaid; the same key then pays once', async () => {
    const r = await restaurant('drill-check-kill');
    const orderId = await servedOrder(r, r.tables[0]!, BURGERS_AND_TEA(r));
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const idem = key();
    const body = checkBody(r.till1, { expectedAmountDue: '473.00' });
    const before = await footprint(r);

    // Hold the bill row so the check is provably in flight inside its transaction, then kill it.
    const blocker = await owner.connect();
    const killer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await killer.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [r.tenantId]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM order_bills WHERE id = $1 FOR UPDATE', [bill.id]);
      const pending = http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(r.till1.headers).set(idem).send(body).then((x) => x);
      let victim: number | undefined;
      for (let i = 0; i < 100 && !victim; i++) {
        victim = (await killer.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blockerPid])).rows[0]?.pid;
        if (!victim) await new Promise((res) => setTimeout(res, 50));
      }
      expect(victim).toBeDefined();
      expect((await killer.query('SELECT pg_terminate_backend($1) AS ok', [victim])).rows[0].ok).toBe(true);
      const res = await pending;
      expect([res.status, code(res), res.headers['retry-after']]).toEqual([503, 'SERVICE_UNAVAILABLE', '2']);
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
      await killer.end();
    }
    expect(await footprint(r)).toEqual(before);
    expect(await billEvidence(r, bill.id)).toMatchObject({ checks: 0, status: 'ACTIVE' });

    // The till keeps the key (unknown outcome) and retries: one check, the table settles.
    const paid = (await http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(r.till1.headers).set(idem).send(body).expect(201)).body;
    expect([paid.amountDue, paid.billSettled, paid.saleNumber]).toEqual(['473.00', true, 1]);
    const replay = await http().post(`/v1/restaurant/bills/${bill.id}/checks`).set(r.till1.headers).set(idem).send(body).expect(201);
    expect([replay.body.id, replay.headers['idempotent-replayed']]).toEqual([paid.id, 'true']);
    const after = await footprint(r);
    expect({ sales: after.sales - before.sales, numbers: after.numbers - before.numbers, entries: after.entries - before.entries }).toEqual({ sales: 1, numbers: 1, entries: 1 });
    expect(await closeBalanced(r, r.till1)).toBe('1473.00');
    expect(await audit(r)).toEqual(CLEAN);
  });
});
