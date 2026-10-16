import type { INestApplication } from '@nestjs/common';
import { toDec } from '@1pos/money';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Bills, split checks and the service charge (ADR-0014 §8, §9 — Phase 4 slice 4). */
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
 * A VAT restaurant: Burger ₱150 (recipe: bun + 0.15 kg beef; doneness required; cheese slice ₱20 extra),
 * Iced tea ₱45. Service charge 10 % on dine-in, VATable. The server runs a cashier session on R1.
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
  await http().post('/v1/stock/adjustments').set(auth).send({ branchId, reason: 'Opening', items: [
    { variantId: bun, quantity: '50', unitCost: '5.00' }, { variantId: beef, quantity: '5', unitCost: '400.00' }, { variantId: cheese, quantity: '40', unitCost: '3.00' },
  ] }).expect(201);
  await http().post(`/v1/variants/${burger}/recipe`).set(auth).send({ ingredients: [{ variantId: bun, quantity: '1' }, { variantId: beef, quantity: '0.15' }] }).expect(201);
  await http().post('/v1/kitchen-stations').set(auth).send({ branchId, code: 'GRILL', name: 'Grill', isDefault: true }).expect(201);
  const area = (await http().post('/v1/dining-areas').set(auth).send({ branchId, name: 'Hall' }).expect(201)).body.id as string;
  const table = async (code: string) => (await http().post('/v1/restaurant-tables').set(auth).send({ areaId: area, code }).expect(201)).body.id as string;
  const [t1, t2] = [await table('T1'), await table('T2')];
  const doneness = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Doneness', minSelect: 1, maxSelect: 1, options: [{ name: 'Medium' }, { name: 'Well done' }] }).expect(201)).body;
  const extras = (await http().post('/v1/modifier-groups').set(auth).send({ name: 'Extras', maxSelect: 2, options: [{ name: 'Cheese', variantId: cheese }, { name: 'No onions' }] }).expect(201)).body;
  const menu = (await http().post('/v1/menus').set(auth).send({ name: 'All day' }).expect(201)).body;
  await http().put(`/v1/menu-versions/${menu.draft.id}/content`).set(auth).send({ sections: [
    { name: 'Mains', items: [{ variantId: burger, modifierGroupIds: [doneness.id, extras.id] }] },
    { name: 'Drinks', items: [{ variantId: tea }] },
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
    tenantId: t.tenantId, auth, branchId, legalEntityId: le.body.id as string, registerId, session, t1, t2, bun, beef, cheese, burger, tea,
    medium: opt(doneness, 'Medium'), cheeseOpt: opt(extras, 'Cheese'), server: server.headers, manager: manager.headers,
  };
}
type R = Awaited<ReturnType<typeof restaurant>>;

const key = () => ({ 'Idempotency-Key': randomUUID() });
const code = (res: request.Response) => res.body.error?.code;
const sql = <T = Record<string, unknown>>(r: R, q: string, params: unknown[] = []) => asOwnerInTenant(owner, r.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

async function servedOrder(r: R, tableId: string, items: unknown[]) {
  const o = (await http().post('/v1/restaurant/orders').set(r.server).send({ branchId: r.branchId, orderType: 'DINE_IN', tableId }).expect(201)).body;
  await http().post(`/v1/restaurant/orders/${o.id}/items`).set(r.server).set(key()).send({ items }).expect(201);
  await http().post(`/v1/restaurant/orders/${o.id}/fire`).set(r.server).send({}).expect(200);
  return o.id as string;
}
const billOrder = (r: R, orderId: string, body: Record<string, unknown> = {}, who: Headers = r.server) =>
  http().post(`/v1/restaurant/orders/${orderId}/bill`).set(who).set(key()).send(body);
const check = (r: R, billId: string, body: Record<string, unknown>, who: Headers = r.server) =>
  http().post(`/v1/restaurant/bills/${billId}/checks`).set(who).set(key()).send({ cashierSessionId: r.session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '2000.00' }], ...body });
const gl = (r: R, saleIds: string[]) =>
  sql<{ system_key: string; net: string }>(r, `
    SELECT a.system_key, sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.source_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [saleIds]).then((rows) => Object.fromEntries(rows.map((x) => [x.system_key, x.net])));

describe('the restaurant service cycle (SPEC restaurant scenarios 1–10)', () => {
  it('order with modifiers → kitchen → bill with service charge → split evenly → settled; stock, books and reports reconcile', async () => {
    const r = await restaurant('bill-cycle');
    const orderId = await servedOrder(r, r.t1, [
      { variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] },
      { variantId: r.tea, quantity: '2' },
    ]);
    // Burger 2×150 + cheese 2×20 + tea 2×45 = ₱430.00 incl. VAT; base ex VAT 267.86 + 35.71 + 80.36 = 383.93;
    // service charge 10 % = 38.39 + VAT 4.61 = 43.00; the table pays ₱473.00.
    const bill = (await billOrder(r, orderId, { expectedAmountDue: '473.00' }).expect(201)).body;
    expect(bill).toMatchObject({ status: 'ACTIVE', billNumber: 1, amountDue: '473.00', vatAmount: '50.68', amountRemaining: '473.00' });
    expect(bill.lines.map((l: { name: string; quantity: string; amountDue: string; parentLineId: string | null }) => [l.name, l.quantity, l.amountDue, l.parentLineId !== null]))
      .toEqual([['Burger', '2', '300.00', false], ['Cheese', '2', '40.00', true], ['Iced tea', '2', '90.00', false]]);
    expect(bill.charges).toMatchObject([{ kind: 'SERVICE_CHARGE', base: '383.93', rate: '0.1', vatableSales: '38.39', vatAmount: '4.61', amountDue: '43.00' }]);

    // Billed: the order is frozen.
    const order = (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body;
    expect([order.status, order.bill]).toEqual(['BILLED', { id: bill.id, billNumber: 1, status: 'ACTIVE', amountDue: '473.00' }]);
    expect(code(await http().post(`/v1/restaurant/orders/${orderId}/items`).set(r.server).set(key()).send({ items: [{ variantId: r.tea, quantity: '1' }] }).expect(409))).toBe('ORDER_NOT_OPEN');
    expect(code(await http().post(`/v1/order-items/${order.items[1].id}/void`).set(r.manager).set(key()).send({ reason: 'x' }).expect(409))).toBe('ORDER_NOT_OPEN');
    expect(code(await billOrder(r, orderId).expect(409))).toBe('ORDER_NOT_OPEN');

    // Two diners split evenly: half of every line (modifiers follow), then "the rest".
    const [burgerLine, , teaLine] = bill.lines;
    const half = { num: 1, den: 2 };
    const c1 = (await check(r, bill.id, { allocations: [{ billLineId: burgerLine.id, share: half }, { billLineId: teaLine.id, share: half }], expectedAmountDue: '236.50' }).expect(201)).body;
    expect([c1.amountDue, c1.billSettled, c1.lines.map((l: { name: string; quantity: string; amountDue: string }) => [l.name, l.quantity, l.amountDue])]).toEqual([
      '236.50', false, [['Burger', '1', '150.00'], ['Cheese', '1', '20.00'], ['Iced tea', '1', '45.00']],
    ]);
    expect(c1.charges).toMatchObject([{ kind: 'SERVICE_CHARGE', amountDue: '21.50' }]);
    expect(c1.lines[1].parentLineId).toBe(c1.lines[0].id);
    const mid = (await http().get(`/v1/restaurant/bills/${bill.id}`).set(r.server).expect(200)).body;
    expect([mid.amountPaid, mid.amountRemaining, mid.lines.map((l: { paidShare: string }) => l.paidShare)]).toEqual(['236.50', '236.50', ['1/2', '1/2', '1/2']]);

    const c2 = (await check(r, bill.id, {}).expect(201)).body;
    expect([c2.amountDue, c2.billSettled]).toEqual(['236.50', true]);
    const settled = (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body;
    expect([settled.status, settled.bill.status]).toEqual(['SETTLED', 'SETTLED']);
    expect(code(await check(r, bill.id, {}).expect(409))).toBe('BILL_NOT_ACTIVE');
    await http().post('/v1/restaurant/orders').set(r.server).send({ branchId: r.branchId, orderType: 'DINE_IN', tableId: r.t1 }).expect(201); // the table is free

    // Σ checks = the bill, bucket by bucket (lines and charges).
    const sums = await sql<Record<string, string>>(r, `
      SELECT (SELECT sum(amount_due) FROM sales WHERE order_bill_id = $1)::text AS checks,
             (SELECT sum(l.vat_amount) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.order_bill_id = $1)::text AS line_vat,
             (SELECT sum(c.amount_due) FROM sale_charges c JOIN sales s ON s.id = c.sale_id WHERE s.order_bill_id = $1)::text AS charges,
             (SELECT sum(c.base) FROM sale_charges c JOIN sales s ON s.id = c.sale_id WHERE s.order_bill_id = $1)::text AS bases`, [bill.id]);
    expect(sums).toEqual([{ checks: '473.0000', line_vat: '46.0700', charges: '43.0000', bases: '383.9300' }]); // 191.97 + the rest, 191.96

    // Stock: each burger consumed its recipe once (half per check); the cheese slices left as themselves.
    const moved = await sql<{ variant_id: string; type: string; q: string }>(r, `SELECT variant_id, type, sum(quantity)::text AS q FROM stock_movements WHERE sale_id = ANY($1::uuid[]) GROUP BY 1, 2`, [[c1.id, c2.id]]);
    const q = (v: string, t: string) => moved.find((m) => m.variant_id === v && m.type === t)?.q;
    expect([q(r.bun, 'CONSUMPTION'), q(r.beef, 'CONSUMPTION'), q(r.cheese, 'SALE')]).toEqual(['-2.0000', '-0.3000', '-2.0000']);

    // Books: items to Sales, the service charge to a liability (RA 11360), all VAT to output VAT.
    expect(await gl(r, [c1.id, c2.id])).toEqual({
      CASH_ON_HAND: '473.0000', SALES: '-383.9300', SERVICE_CHARGE_PAYABLE: '-38.3900', OUTPUT_VAT: '-50.6800',
      COGS: '136.0000', INVENTORY: '-136.0000', // 2 × (bun 5 + 0.15 kg beef 60) + 2 cheese slices × 3
    });
    expect(await asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);

    // Receipt shows the charge on its own line.
    const receipt = (await http().get(`/v1/sales/${c1.id}/receipt`).set(r.server).expect(200)).body;
    expect(receipt.charges).toEqual([{ kind: 'SERVICE_CHARGE', label: 'Service charge 10%', amount: '19.19' }]);

    // Reports: Σ products + Σ charges = the summary; COGS of the burger includes its ingredients.
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const range = { branchId: r.branchId, from: day, to: day };
    const summary = (await http().get('/v1/reports/sales-summary').query(range).set(r.manager).expect(200)).body;
    const byProduct = (await http().get('/v1/reports/by-product').query(range).set(r.manager).expect(200)).body;
    const products = byProduct.data.reduce((a: number, p: { netSales: string }) => a + Math.round(Number(p.netSales) * 100), 0);
    expect(byProduct.charges).toMatchObject([{ kind: 'SERVICE_CHARGE', net: '43.00', netExVat: '38.39' }]);
    expect(products + 4300).toBe(Math.round(Number(summary.totals.net.amountDue) * 100));
    expect(summary.totals.net.amountDue).toBe('473.00');
    const burgerRow = byProduct.data.find((p: { variantId: string }) => p.variantId === r.burger);
    expect(burgerRow).toMatchObject({ netSales: '300.00', cogs: '130.00' }); // 2 × (bun 5 + beef 60)

    // Close the shift: the drawer holds the float plus what the table paid.
    const close = (await http().post(`/v1/cashier-sessions/${r.session}/close`).set(r.server).send({ countedCash: '1473.00' }).expect(200)).body;
    expect(close.status).toBe('RECONCILED');
  });
});

describe('splitting', () => {
  it('by item and by quantity; never more than what is left; concurrent "pay the rest" settles once', async () => {
    const r = await restaurant('bill-split');
    const orderId = await servedOrder(r, r.t1, [
      { variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium, r.cheeseOpt] },
      { variantId: r.tea, quantity: '3' },
    ]);
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const [burgerLine, cheeseLine, teaLine] = bill.lines;
    expect(code(await check(r, bill.id, { allocations: [{ billLineId: cheeseLine.id }] }).expect(422))).toBe('PAY_WHOLE_ITEMS');
    expect(code(await check(r, bill.id, { allocations: [{ billLineId: teaLine.id, quantity: '4' }] }).expect(422))).toBe('ALLOCATION_EXCEEDS_LINE');
    await check(r, bill.id, { allocations: [{ billLineId: randomUUID() }] }).expect(404);
    expect(code(await check(r, bill.id, { tenders: [{ method: 'CASH', tendered: '1.00' }] }).expect(422))).toBe('INSUFFICIENT_TENDER');

    const one = (await check(r, bill.id, { allocations: [{ billLineId: teaLine.id, quantity: '1' }] }).expect(201)).body;
    expect(one.lines.map((l: { name: string; quantity: string; amountDue: string }) => [l.name, l.quantity, l.amountDue])).toEqual([['Iced tea', '1', '45.00']]);
    expect(code(await check(r, bill.id, { allocations: [{ billLineId: teaLine.id, quantity: '3' }] }).expect(422))).toBe('ALLOCATION_EXCEEDS_LINE');
    await check(r, bill.id, { allocations: [{ billLineId: burgerLine.id }] }).expect(201); // the burger, whole, with its cheese

    // Three people tap "pay the rest" at once: one check, the others are refused, nothing is paid twice.
    const rest = await Promise.all([0, 1, 2].map(() => check(r, bill.id, {})));
    expect(rest.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    const paid = await sql<{ n: string }>(r, `SELECT sum(amount_due)::text AS n FROM sales WHERE order_bill_id = $1`, [bill.id]);
    expect(paid).toEqual([{ n: toFixed4(bill.amountDue) }]);
    expect(await sql(r, `SELECT bill_line_id, sum(share_num::numeric / share_den)::numeric(10,4)::text AS s FROM order_bill_allocations GROUP BY 1 HAVING sum(share_num::numeric / share_den) > 1.0000001`)).toEqual([]);
  });
});

describe('check preview', () => {
  it('shows exactly what the check will pay, records nothing, and a check paid in between is caught', async () => {
    const r = await restaurant('bill-preview');
    const orderId = await servedOrder(r, r.t1, [{ variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] }, { variantId: r.tea, quantity: '2' }]);
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const preview = (body: Record<string, unknown>) => http().post(`/v1/restaurant/bills/${bill.id}/checks/preview`).set(r.server).send(body);
    const third = { num: 1, den: 3 };
    const allocations = bill.lines.filter((l: { parentLineId: string | null }) => !l.parentLineId).map((l: { id: string }) => ({ billLineId: l.id, share: third }));

    const p1 = (await preview({ allocations }).expect(200)).body;
    // A third: burger 100.00 + cheese 13.33 + tea 30.00 + charge 14.33; the last third takes the remainder.
    expect(p1).toMatchObject({ billId: bill.id, settles: false, amountDue: '157.66' });
    expect(p1.lines.map((l: { name: string; quantity: string; parentBillLineId: string | null }) => [l.name, l.quantity, l.parentBillLineId !== null])).toEqual([['Burger', '0.6667', false], ['Cheese', '0.6667', true], ['Iced tea', '0.6667', false]]);
    expect(await sql(r, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 0 }]); // nothing recorded
    const c1 = (await check(r, bill.id, { allocations, expectedAmountDue: p1.amountDue }).expect(201)).body;
    expect([c1.amountDue, c1.charges[0].amountDue]).toEqual([p1.amountDue, p1.charges[0].amountDue]);

    // The rest, previewed by two tills; the first pays, the second's preview is now stale.
    const rest = (await preview({}).expect(200)).body;
    expect([rest.settles, toDec(rest.amountDue).plus(c1.amountDue).toFixed(2)]).toEqual([true, '473.00']);
    const p2 = (await preview({ allocations }).expect(200)).body;
    await check(r, bill.id, { allocations, expectedAmountDue: p2.amountDue }).expect(201);
    const stale = await check(r, bill.id, { expectedAmountDue: rest.amountDue }).expect(409);
    expect(code(stale)).toBe('TOTAL_CHANGED');
    const last = (await preview({}).expect(200)).body;
    expect((await check(r, bill.id, { expectedAmountDue: last.amountDue }).expect(201)).body.billSettled).toBe(true);
    expect(code(await preview({}).expect(409))).toBe('BILL_NOT_ACTIVE');
    expect((await http().get(`/v1/restaurant/bills/${bill.id}`).set(r.server).expect(200)).body.amountPaid).toBe('473.00');
  });
});

describe('SC/PWD, discounts and reopening', () => {
  it("a senior's own burger is discounted and VAT-exempt; an order discount spares statutory lines; a bill reopens only before any check", async () => {
    const r = await restaurant('bill-sc');
    const orderId = await servedOrder(r, r.t1, [
      { variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] },
      { variantId: r.burger, quantity: '1', modifierOptionIds: [r.medium] },
      { variantId: r.tea, quantity: '1' },
    ]);
    const items = (await http().get(`/v1/restaurant/orders/${orderId}`).set(r.server).expect(200)).body.items;
    const lola = { ref: 'lola', scheme: 'SC', name: 'Lola Cruz', idNumber: 'OSCA-123' };
    const bill = (await billOrder(r, orderId, { beneficiaries: [lola], statutory: [{ orderItemId: items[1].id, beneficiary: 'lola' }] }).expect(201)).body;
    // Regular burger 150; SC burger 133.93 exempt − 26.79 = 107.14; tea 45 → items 302.14.
    // Base 133.93 + 107.14 + 40.18 = 281.25 → charge 28.13 + VAT 3.38 = 31.51 → ₱333.65.
    expect(bill.lines.map((l: { amountDue: string; statutoryDiscount: string; beneficiaryId: string | null }) => [l.amountDue, l.statutoryDiscount, l.beneficiaryId !== null]))
      .toEqual([['150.00', '0.00', false], ['107.14', '26.79', true], ['45.00', '0.00', false]]);
    expect(bill.charges[0]).toMatchObject({ base: '281.25', amountDue: '31.51' });
    expect([bill.amountDue, bill.requiresProfessionalReview]).toEqual(['333.65', true]);

    // Reopen, add a drink, re-bill with 10 % off (a manager: needs sales.discount); the senior's line keeps only the statutory discount.
    expect((await http().post(`/v1/restaurant/bills/${bill.id}/void`).set(r.server).send({ reason: 'Adding a drink' }).expect(200)).body.status).toBe('VOIDED');
    await http().post(`/v1/restaurant/orders/${orderId}/items`).set(r.server).set(key()).send({ items: [{ variantId: r.tea, quantity: '1' }] }).expect(201);
    expect(code(await billOrder(r, orderId).expect(409))).toBe('ORDER_HAS_PENDING_ITEMS');
    await http().post(`/v1/restaurant/orders/${orderId}/fire`).set(r.server).send({}).expect(200);
    const body = { discountRate: '0.10', beneficiaries: [lola], statutory: [{ orderItemId: items[1].id, beneficiary: 'lola' }] };
    expect(code(await billOrder(r, orderId, body).expect(403))).toBe('FORBIDDEN'); // cashier has no sales.discount
    const again = (await billOrder(r, orderId, body, r.manager).expect(201)).body;
    expect(again.billNumber).toBe(2);
    expect(again.lines.map((l: { discount: string; statutoryDiscount: string }) => [l.discount, l.statutoryDiscount]))
      .toEqual([['15.00', '0.00'], ['0.00', '26.79'], ['4.50', '0.00'], ['4.50', '0.00']]);

    // The senior pays their own burger: the check carries them as beneficiary, with the signature block.
    const own = (await check(r, again.id, { allocations: [{ billLineId: again.lines[1].id }] }).expect(201)).body;
    expect(own.beneficiaries).toMatchObject([{ schemeCode: 'SC', name: 'Lola Cruz', idNumber: 'OSCA-123' }]);
    expect((await http().get(`/v1/sales/${own.id}/receipt`).set(r.server).expect(200)).body.statutory).toMatchObject([{ scheme: 'SC', discount: '26.79', signatureLine: true }]);
    expect(code(await http().post(`/v1/restaurant/bills/${again.id}/void`).set(r.server).send({ reason: 'x' }).expect(409))).toBe('BILL_HAS_CHECKS');
    await check(r, again.id, {}).expect(201);
    expect(await asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('returns of a check with a service charge', () => {
  it('the charge goes back in proportion; the last return takes the rest; the liability nets to zero', async () => {
    const r = await restaurant('bill-return');
    const orderId = await servedOrder(r, r.t1, [{ variantId: r.burger, quantity: '2', modifierOptionIds: [r.medium, r.cheeseOpt] }, { variantId: r.tea, quantity: '2' }]);
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const sale = (await check(r, bill.id, {}).expect(201)).body;
    const ret = (lines: unknown[]) => http().post(`/v1/sales/${sale.id}/returns`).set(r.manager).set(key()).send({ cashierSessionId: r.session, kind: 'RETURN', reason: 'Too sweet', lines });
    const teaLine = sale.lines.find((l: { name: string }) => l.name === 'Iced tea');
    // Tea is 90/430 of the items: 9.00 of the 43.00 charge goes back with it.
    const first = (await ret([{ saleLineId: teaLine.id, quantity: '2', disposition: 'DAMAGED' }]).expect(201)).body;
    expect(first.amountDue).toBe('99.00');
    const rest = (await ret(sale.lines.filter((l: { id: string }) => l.id !== teaLine.id).map((l: { id: string; quantity: string }) => ({ saleLineId: l.id, quantity: l.quantity, disposition: 'DAMAGED' }))).expect(201)).body;
    expect(rest.amountDue).toBe('374.00'); // 473 − 99: the rest of the charge with it
    const back = await sql<{ n: string }>(r, `SELECT sum(amount_due)::text AS n FROM sale_return_charges`);
    expect(back).toEqual([{ n: '43.0000' }]);
    const liability = await sql<{ net: string }>(r, `
      SELECT sum(l.debit - l.credit)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key = 'SERVICE_CHARGE_PAYABLE'`);
    expect(liability).toEqual([{ net: '0.0000' }]);
    expect(await asOwnerInTenant(owner, r.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});

describe('database guards', () => {
  it('a bill line is never paid beyond the whole; bills move forward only; bill evidence is append-only', async () => {
    const r = await restaurant('bill-guard');
    const orderId = await servedOrder(r, r.t1, [{ variantId: r.tea, quantity: '1' }]);
    const bill = (await billOrder(r, orderId).expect(201)).body;
    const sale = (await check(r, bill.id, { allocations: [{ billLineId: bill.lines[0].id, share: { num: 1, den: 3 } }] }).expect(201)).body;
    // A fresh sale line (a counter sale) so only the share guard can refuse: 1/3 already paid + 3/4 > 1.
    const counter = (await http().post('/v1/sales').set(r.server).set(key()).send({ cashierSessionId: r.session, clientTransactionId: randomUUID(), lines: [{ variantId: r.tea, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '45.00' }] }).expect(201)).body;
    const insert = (num: number, den: number) =>
      sql(r, `INSERT INTO order_bill_allocations (tenant_id, order_bill_id, bill_line_id, sale_id, sale_line_id, share_num, share_den)
              SELECT tenant_id, order_bill_id, bill_line_id, $3, $4, $1, $2 FROM order_bill_allocations LIMIT 1`, [num, den, counter.id, counter.lines[0].id]);
    await expect(insert(3, 4)).rejects.toThrow(/cannot be paid more than once/);
    await expect(sql(r, `UPDATE order_bill_lines SET amount_due = 0`)).rejects.toThrow();
    await expect(sql(r, `UPDATE order_bills SET status = 'VOIDED', voided_at = now(), void_reason = 'x' WHERE id = $1`, [bill.id])).rejects.toThrow(/paid checks/);
    await expect(sql(r, `DELETE FROM sale_charges`)).rejects.toThrow();
    expect(sale.amountDue).toBe('16.50'); // 45/3 = 15.00 + 1.50 of the 4.50 charge
  });
});

function toFixed4(v: string) {
  return Number(v).toFixed(4);
}
