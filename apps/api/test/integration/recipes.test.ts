import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Versioned recipes and ingredient consumption at checkout (ADR-0014 §4, Phase 4 slice 1). */
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

async function kitchen(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const uoms = (await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[];
  const uom = (code: string) => uoms.find((u) => u.code === code)!.id;
  const product = async (name: string, price: string, opts: { uom?: string; tracked?: boolean } = {}) =>
    (await http().post('/v1/products').set(auth).send({
      name, uomId: uom(opts.uom ?? 'PC'), taxCategoryId: vat, trackInventory: opts.tracked ?? true,
      ...(opts.uom === 'KG' && { soldBy: 'WEIGHT' }),
      variants: [{ sku: uniq('SKU'), price }],
    }).expect(201)).body.variants[0].id as string;
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  const manager = bearer(await loginToken(app, m.email));
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const cashier = bearer(await loginToken(app, c.email));
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: reg.body.id, openingFloat: '10000.00' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, auth, manager, cashier, legalEntityId: le.body.id as string, branchId: br.body.id as string, session, product };
}
type Kitchen = Awaited<ReturnType<typeof kitchen>>;

const stockIn = (k: Kitchen, items: { variantId: string; quantity: string; unitCost: string }[]) =>
  http().post('/v1/stock/adjustments').set(k.manager).set('Idempotency-Key', randomUUID()).send({ branchId: k.branchId, reason: 'Opening stock', items }).expect(201);
const recipe = (k: Kitchen, variantId: string, body: Record<string, unknown>, who = k.auth) =>
  http().post(`/v1/variants/${variantId}/recipe`).set(who).set('Idempotency-Key', randomUUID()).send(body);
const sell = async (k: Kitchen, lines: { variantId: string; quantity: string }[]) =>
  (await http().post('/v1/sales').set(k.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '9999.00' }] }).expect(201)).body;
const sql = <T = Record<string, string>>(k: Kitchen, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, k.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

/** Burger = 1 bun + 0.15 kg beef + 1 cheese slice; Cola is sold off the shelf. */
async function menu(k: Kitchen) {
  const bun = await k.product('Bun', '10.00');
  const beef = await k.product('Ground beef', '500.00', { uom: 'KG' });
  const cheese = await k.product('Cheese slice', '8.00');
  const cola = await k.product('Cola', '45.00');
  const burger = await k.product('Cheeseburger', '150.00', { tracked: false });
  await stockIn(k, [
    { variantId: bun, quantity: '10', unitCost: '5.00' },
    { variantId: beef, quantity: '2', unitCost: '400.00' },
    { variantId: cheese, quantity: '20', unitCost: '3.00' },
    { variantId: cola, quantity: '10', unitCost: '20.00' },
  ]);
  const v1 = await recipe(k, burger, { ingredients: [{ variantId: bun, quantity: '1' }, { variantId: beef, quantity: '0.15' }, { variantId: cheese, quantity: '1' }] }).expect(201);
  return { bun, beef, cheese, cola, burger, v1: v1.body.id as string };
}

async function assertClean(k: Kitchen) {
  expect(await asOwnerInTenant(owner, k.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  const drift = await sql(k, `
    SELECT b.variant_id FROM stock_balances b JOIN stock_movements m ON m.branch_id = b.branch_id AND m.variant_id = b.variant_id
     GROUP BY b.variant_id, b.quantity, b.value HAVING b.quantity <> sum(m.quantity) OR b.value <> sum(m.value)`);
  expect(drift).toEqual([]);
}

describe('recipes and consumption (ADR-0014 §4)', () => {
  it('selling a dish consumes its ingredients at average cost, inside the sale and its one journal entry', async () => {
    const k = await kitchen('rcp-sale');
    const m = await menu(k);
    const sale = await sell(k, [{ variantId: m.burger, quantity: '2' }, { variantId: m.cola, quantity: '1' }]);

    const moves = await sql(k, `SELECT type, variant_id, quantity::text, unit_cost::text, value::text, sale_line_id, recipe_version_id FROM stock_movements WHERE sale_id = $1 ORDER BY variant_id`, [sale.id]);
    const by = (v: string) => moves.find((x) => x.variant_id === v);
    expect(by(m.bun)).toMatchObject({ type: 'CONSUMPTION', quantity: '-2.0000', unit_cost: '5.0000', value: '-10.0000', sale_line_id: sale.lines[0].id, recipe_version_id: m.v1 });
    expect(by(m.beef)).toMatchObject({ type: 'CONSUMPTION', quantity: '-0.3000', unit_cost: '400.0000', value: '-120.0000' });
    expect(by(m.cheese)).toMatchObject({ type: 'CONSUMPTION', quantity: '-2.0000', value: '-6.0000' });
    expect(by(m.cola)).toMatchObject({ type: 'SALE', quantity: '-1.0000', value: '-20.0000', recipe_version_id: null });
    expect(moves.some((x) => x.variant_id === m.burger)).toBe(false); // the dish itself has no stock

    // One entry for the sale: COGS = 136 (ingredients) + 20 (cola), credited to inventory.
    const gl = await sql(k, `
      SELECT a.system_key, sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'SALE' AND e.source_id = $1 AND a.system_key IN ('COGS', 'INVENTORY') GROUP BY 1 ORDER BY 1`, [sale.id]);
    expect(gl).toEqual([{ system_key: 'COGS', net: '156.0000' }, { system_key: 'INVENTORY', net: '-156.0000' }]);

    const bal = (await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: m.beef }).set(k.manager).expect(200)).body.data[0];
    expect(bal).toMatchObject({ quantity: '1.7', value: '680.00' });
    const report = (await http().get('/v1/reports/stock-movements').query({ branchId: k.branchId, from: today(), to: today() }).set(k.manager).expect(200)).body;
    const beefRow = report.data.find((r: { variantId: string }) => r.variantId === m.beef);
    expect(beefRow.movements.CONSUMPTION).toMatchObject({ quantity: '-0.3', value: '-120.00' });
    await assertClean(k);
  });

  it('versions: the version in force at sale time is consumed; scheduled ones wait; history is append-only and never backdated', async () => {
    const k = await kitchen('rcp-ver');
    const m = await menu(k);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await recipe(k, m.burger, { ingredients: [{ variantId: m.bun, quantity: '1' }], effectiveFrom: future, note: 'Plain bun next week' }).expect(201);
    expect(scheduled.body.version).toBe(2);
    const s1 = await sell(k, [{ variantId: m.burger, quantity: '1' }]);
    expect((await sql(k, `SELECT DISTINCT recipe_version_id FROM stock_movements WHERE sale_id = $1`, [s1.id])).map((r) => r.recipe_version_id)).toEqual([m.v1]);

    // Double cheese from now on.
    const v3 = (await recipe(k, m.burger, { ingredients: [{ variantId: m.bun, quantity: '1' }, { variantId: m.beef, quantity: '0.15' }, { variantId: m.cheese, quantity: '2' }] }).expect(201)).body;
    const s2 = await sell(k, [{ variantId: m.burger, quantity: '1' }]);
    expect(await sql(k, `SELECT quantity::text, recipe_version_id FROM stock_movements WHERE sale_id = $1 AND variant_id = $2`, [s2.id, m.cheese])).toEqual([{ quantity: '-2.0000', recipe_version_id: v3.id }]);

    const history = (await http().get(`/v1/variants/${m.burger}/recipe`).set(k.auth).expect(200)).body.data as { version: number; state: string; ingredients: unknown[] }[];
    expect(history.map((h) => [h.version, h.state])).toEqual([[2, 'SCHEDULED'], [3, 'IN_FORCE'], [1, 'SUPERSEDED']]);
    expect(history.find((h) => h.version === 3)!.ingredients).toHaveLength(3);

    // An empty version stops consumption.
    await recipe(k, m.burger, { ingredients: [], note: 'Discontinued recipe tracking' }).expect(201);
    const s3 = await sell(k, [{ variantId: m.burger, quantity: '1' }]);
    expect(await sql(k, `SELECT id FROM stock_movements WHERE sale_id = $1`, [s3.id])).toEqual([]);

    expect((await recipe(k, m.burger, { ingredients: [], effectiveFrom: new Date(Date.now() - 3_600_000).toISOString() }).expect(422)).body.error.code).toBe('RECIPE_BACKDATED');
    await expect(sql(k, `UPDATE recipe_ingredients SET quantity = 9`)).rejects.toThrow();
    await expect(sql(k, `DELETE FROM recipe_versions`)).rejects.toThrow();
    await expect(sql(k, `INSERT INTO recipe_versions (tenant_id, variant_id, version, effective_from, created_by) VALUES ($1, $2, 99, now() - interval '1 hour', $1)`, [k.tenantId, m.burger])).rejects.toThrow(/backdated/);
    await assertClean(k);
  });

  it('rules: dish must not track stock, ingredients must; each once; restaurant.manage and the restaurant plan', async () => {
    const k = await kitchen('rcp-rules');
    const m = await menu(k);
    const service = await k.product('Corkage', '100.00', { tracked: false });
    expect((await recipe(k, m.cola, { ingredients: [{ variantId: m.bun, quantity: '1' }] }).expect(422)).body.error.code).toBe('RECIPE_ITEM_TRACKS_STOCK');
    expect((await recipe(k, m.burger, { ingredients: [{ variantId: service, quantity: '1' }] }).expect(422)).body.error.code).toBe('INGREDIENT_NOT_STOCKED');
    await recipe(k, m.burger, { ingredients: [{ variantId: m.bun, quantity: '1' }, { variantId: m.bun, quantity: '2' }] }).expect(400);
    await recipe(k, m.burger, { ingredients: [{ variantId: m.bun, quantity: '0' }] }).expect(400);
    await recipe(k, randomUUID(), { ingredients: [] }).expect(404);
    await http().get(`/v1/variants/${randomUUID()}/recipe`).set(k.auth).expect(404);
    await recipe(k, m.burger, { ingredients: [] }, k.manager).expect(403);
    await recipe(k, m.burger, { ingredients: [] }, k.cashier).expect(403);
    // The DB refuses what the API would: an untracked ingredient.
    await expect(sql(k, `INSERT INTO recipe_ingredients (tenant_id, recipe_version_id, ingredient_variant_id, quantity) VALUES ($1, $2, $3, 1)`, [k.tenantId, m.v1, service])).rejects.toThrow(/tracks stock/);

    await owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [k.tenantId, 'starter', 'ACTIVE', null, null]);
    expect((await recipe(k, m.burger, { ingredients: [] }).expect(403)).body.error.code).toBe('ENTITLEMENT_REQUIRED');
    // Consumption keeps running without the plan feature: the books must stay right after a downgrade.
    const sale = await sell(k, [{ variantId: m.burger, quantity: '1' }]);
    expect(await sql(k, `SELECT count(*)::int AS n FROM stock_movements WHERE sale_id = $1 AND type = 'CONSUMPTION'`, [sale.id])).toEqual([{ n: 3 }]);
  });

  it('cooked food is not restocked: returns of a dish are DAMAGED only, a void restocks only shelf items', async () => {
    const k = await kitchen('rcp-ret');
    const m = await menu(k);
    const sale = await sell(k, [{ variantId: m.burger, quantity: '2' }, { variantId: m.cola, quantity: '2' }]);
    const ret = (lines: unknown[]) =>
      http().post(`/v1/sales/${sale.id}/returns`).set(k.manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, kind: 'RETURN', reason: 'Cold', lines });
    expect((await ret([{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'RESTOCK' }]).expect(422)).body.error.code).toBe('NOT_RESTOCKABLE');
    const back = (await ret([{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'DAMAGED' }]).expect(201)).body;
    expect(back.amountDue).toBe('150.00');
    expect(await sql(k, `SELECT count(*)::int AS n FROM stock_movements WHERE type = 'RETURN'`)).toEqual([{ n: 0 }]);

    const sale2 = await sell(k, [{ variantId: m.burger, quantity: '1' }, { variantId: m.cola, quantity: '1' }]);
    const voided = (await http().post(`/v1/sales/${sale2.id}/returns`).set(k.manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, kind: 'VOID', reason: 'Wrong table' }).expect(201)).body;
    expect(voided.lines.map((l: { saleLineId: string; disposition: string }) => [l.saleLineId, l.disposition])).toEqual([[sale2.lines[0].id, 'DAMAGED'], [sale2.lines[1].id, 'RESTOCK']]);
    expect(await sql(k, `SELECT variant_id, quantity::text FROM stock_movements WHERE type = 'RETURN'`)).toEqual([{ variant_id: m.cola, quantity: '1.0000' }]);
    // Ingredients stay consumed: bun 10 − 2 − 1 = 7.
    expect((await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: m.bun }).set(k.manager).expect(200)).body.data[0]).toMatchObject({ quantity: '7' });
    await assertClean(k);
  });

  it('concurrent dish and shelf sales sharing an ingredient, in opposite item order: no deadlock, ledger consistent', async () => {
    const k = await kitchen('rcp-race');
    const m = await menu(k);
    await stockIn(k, [{ variantId: m.bun, quantity: '90', unitCost: '5.00' }]);
    // Buns are also sold on their own, so dish and shelf sales lock the same balance rows.
    const lines = (i: number) => (i % 2 ? [{ variantId: m.burger, quantity: '1' }, { variantId: m.bun, quantity: '1' }] : [{ variantId: m.bun, quantity: '1' }, { variantId: m.cola, quantity: '1' }, { variantId: m.burger, quantity: '1' }]);
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        http().post('/v1/sales').set(k.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, clientTransactionId: randomUUID(), lines: lines(i), tenders: [{ method: 'CASH', tendered: '500.00' }] }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(201));
    // 100 buns − 10 in burgers − 10 sold alone = 80; beef 2 − 10 × 0.15 = 0.5.
    const bal = async (v: string) => (await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: v }).set(k.manager).expect(200)).body.data[0];
    expect(await bal(m.bun)).toMatchObject({ quantity: '80', value: '400.00' });
    expect(await bal(m.beef)).toMatchObject({ quantity: '0.5', value: '200.00' });
    await assertClean(k);
  });
});

function today() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Asia/Manila business day
}
