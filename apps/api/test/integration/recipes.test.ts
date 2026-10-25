import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Versioned recipes (a salon's "supplies used") and their consumption at checkout (ADR-0014 §4, ADR-0022 §9). */
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

/** A HYBRID business (the sign-up default), which serves appointments and so may keep recipes. */
async function salon(prefix: string) {
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
type Salon = Awaited<ReturnType<typeof salon>>;

const stockIn = (k: Salon, items: { variantId: string; quantity: string; unitCost: string }[]) =>
  http().post('/v1/stock/adjustments').set(k.manager).set('Idempotency-Key', randomUUID()).send({ branchId: k.branchId, reason: 'Opening stock', items }).expect(201);
const recipe = (k: Salon, variantId: string, body: Record<string, unknown>, who = k.auth) =>
  http().post(`/v1/variants/${variantId}/recipe`).set(who).set('Idempotency-Key', randomUUID()).send(body);
const sell = async (k: Salon, lines: { variantId: string; quantity: string }[]) =>
  (await http().post('/v1/sales').set(k.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '9999.00' }] }).expect(201)).body;
const sql = <T = Record<string, string>>(k: Salon, q: string, params: unknown[] = []) =>
  asOwnerInTenant(owner, k.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

/** Hair colour = 1 developer + 0.15 kg dye + 1 foil sheet; shampoo is sold off the shelf. */
async function services(k: Salon) {
  const developer = await k.product('Developer 60ml', '10.00');
  const dye = await k.product('Hair dye', '500.00', { uom: 'KG' });
  const foil = await k.product('Foil sheet', '8.00');
  const shampoo = await k.product('Shampoo 250ml', '45.00');
  const colour = await k.product('Hair colour', '150.00', { tracked: false });
  await stockIn(k, [
    { variantId: developer, quantity: '10', unitCost: '5.00' },
    { variantId: dye, quantity: '2', unitCost: '400.00' },
    { variantId: foil, quantity: '20', unitCost: '3.00' },
    { variantId: shampoo, quantity: '10', unitCost: '20.00' },
  ]);
  const v1 = await recipe(k, colour, { ingredients: [{ variantId: developer, quantity: '1' }, { variantId: dye, quantity: '0.15' }, { variantId: foil, quantity: '1' }] }).expect(201);
  return { developer, dye, foil, shampoo, colour, v1: v1.body.id as string };
}

async function assertClean(k: Salon) {
  expect(await asOwnerInTenant(owner, k.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  const drift = await sql(k, `
    SELECT b.variant_id FROM stock_balances b JOIN stock_movements m ON m.branch_id = b.branch_id AND m.variant_id = b.variant_id
     GROUP BY b.variant_id, b.quantity, b.value HAVING b.quantity <> sum(m.quantity) OR b.value <> sum(m.value)`);
  expect(drift).toEqual([]);
}

describe('recipes and consumption (ADR-0014 §4, ADR-0022 §9)', () => {
  it('selling a service consumes its supplies at average cost, inside the sale and its one journal entry', async () => {
    const k = await salon('rcp-sale');
    const m = await services(k);
    const sale = await sell(k, [{ variantId: m.colour, quantity: '2' }, { variantId: m.shampoo, quantity: '1' }]);

    const moves = await sql(k, `SELECT type, variant_id, quantity::text, unit_cost::text, value::text, sale_line_id, recipe_version_id FROM stock_movements WHERE sale_id = $1 ORDER BY variant_id`, [sale.id]);
    const by = (v: string) => moves.find((x) => x.variant_id === v);
    expect(by(m.developer)).toMatchObject({ type: 'CONSUMPTION', quantity: '-2.0000', unit_cost: '5.0000', value: '-10.0000', sale_line_id: sale.lines[0].id, recipe_version_id: m.v1 });
    expect(by(m.dye)).toMatchObject({ type: 'CONSUMPTION', quantity: '-0.3000', unit_cost: '400.0000', value: '-120.0000' });
    expect(by(m.foil)).toMatchObject({ type: 'CONSUMPTION', quantity: '-2.0000', value: '-6.0000' });
    expect(by(m.shampoo)).toMatchObject({ type: 'SALE', quantity: '-1.0000', value: '-20.0000', recipe_version_id: null });
    expect(moves.some((x) => x.variant_id === m.colour)).toBe(false); // the service itself has no stock

    // One entry for the sale: COGS = 136 (supplies) + 20 (shampoo), credited to inventory.
    const gl = await sql(k, `
      SELECT a.system_key, sum(l.debit - l.credit)::text AS net FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'SALE' AND e.source_id = $1 AND a.system_key IN ('COGS', 'INVENTORY') GROUP BY 1 ORDER BY 1`, [sale.id]);
    expect(gl).toEqual([{ system_key: 'COGS', net: '156.0000' }, { system_key: 'INVENTORY', net: '-156.0000' }]);

    const bal = (await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: m.dye }).set(k.manager).expect(200)).body.data[0];
    expect(bal).toMatchObject({ quantity: '1.7', value: '680.00' });
    const report = (await http().get('/v1/reports/stock-movements').query({ branchId: k.branchId, from: today(), to: today() }).set(k.manager).expect(200)).body;
    const dyeRow = report.data.find((r: { variantId: string }) => r.variantId === m.dye);
    expect(dyeRow.movements.CONSUMPTION).toMatchObject({ quantity: '-0.3', value: '-120.00' });
    await assertClean(k);
  });

  it('versions: the version in force at sale time is consumed; scheduled ones wait; history is append-only and never backdated', async () => {
    const k = await salon('rcp-ver');
    const m = await services(k);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await recipe(k, m.colour, { ingredients: [{ variantId: m.developer, quantity: '1' }], effectiveFrom: future, note: 'Plain bun next week' }).expect(201);
    expect(scheduled.body.version).toBe(2);
    const s1 = await sell(k, [{ variantId: m.colour, quantity: '1' }]);
    expect((await sql(k, `SELECT DISTINCT recipe_version_id FROM stock_movements WHERE sale_id = $1`, [s1.id])).map((r) => r.recipe_version_id)).toEqual([m.v1]);

    // Two foil sheets from now on.
    const v3 = (await recipe(k, m.colour, { ingredients: [{ variantId: m.developer, quantity: '1' }, { variantId: m.dye, quantity: '0.15' }, { variantId: m.foil, quantity: '2' }] }).expect(201)).body;
    const s2 = await sell(k, [{ variantId: m.colour, quantity: '1' }]);
    expect(await sql(k, `SELECT quantity::text, recipe_version_id FROM stock_movements WHERE sale_id = $1 AND variant_id = $2`, [s2.id, m.foil])).toEqual([{ quantity: '-2.0000', recipe_version_id: v3.id }]);

    const history = (await http().get(`/v1/variants/${m.colour}/recipe`).set(k.auth).expect(200)).body.data as { version: number; state: string; ingredients: unknown[] }[];
    expect(history.map((h) => [h.version, h.state])).toEqual([[2, 'SCHEDULED'], [3, 'IN_FORCE'], [1, 'SUPERSEDED']]);
    expect(history.find((h) => h.version === 3)!.ingredients).toHaveLength(3);

    // An empty version stops consumption.
    await recipe(k, m.colour, { ingredients: [], note: 'Discontinued recipe tracking' }).expect(201);
    const s3 = await sell(k, [{ variantId: m.colour, quantity: '1' }]);
    expect(await sql(k, `SELECT id FROM stock_movements WHERE sale_id = $1`, [s3.id])).toEqual([]);

    expect((await recipe(k, m.colour, { ingredients: [], effectiveFrom: new Date(Date.now() - 3_600_000).toISOString() }).expect(422)).body.error.code).toBe('RECIPE_BACKDATED');
    await expect(sql(k, `UPDATE recipe_ingredients SET quantity = 9`)).rejects.toThrow();
    await expect(sql(k, `DELETE FROM recipe_versions`)).rejects.toThrow();
    await expect(sql(k, `INSERT INTO recipe_versions (tenant_id, variant_id, version, effective_from, created_by) VALUES ($1, $2, 99, now() - interval '1 hour', $1)`, [k.tenantId, m.colour])).rejects.toThrow(/backdated/);
    await assertClean(k);
  });

  it('rules: the service must not track stock, its supplies must; each once; catalog.manage; salons and HYBRID only', async () => {
    const k = await salon('rcp-rules');
    const m = await services(k);
    const service = await k.product('Blow-dry', '100.00', { tracked: false });
    expect((await recipe(k, m.shampoo, { ingredients: [{ variantId: m.developer, quantity: '1' }] }).expect(422)).body.error.code).toBe('RECIPE_ITEM_TRACKS_STOCK');
    expect((await recipe(k, m.colour, { ingredients: [{ variantId: service, quantity: '1' }] }).expect(422)).body.error.code).toBe('INGREDIENT_NOT_STOCKED');
    await recipe(k, m.colour, { ingredients: [{ variantId: m.developer, quantity: '1' }, { variantId: m.developer, quantity: '2' }] }).expect(400);
    await recipe(k, m.colour, { ingredients: [{ variantId: m.developer, quantity: '0' }] }).expect(400);
    await recipe(k, randomUUID(), { ingredients: [] }).expect(404);
    await http().get(`/v1/variants/${randomUUID()}/recipe`).set(k.auth).expect(404);
    await recipe(k, m.colour, { ingredients: [] }, k.manager).expect(403);
    await recipe(k, m.colour, { ingredients: [] }, k.cashier).expect(403);
    // The DB refuses what the API would: an untracked ingredient.
    await expect(sql(k, `INSERT INTO recipe_ingredients (tenant_id, recipe_version_id, ingredient_variant_id, quantity) VALUES ($1, $2, $3, 1)`, [k.tenantId, m.v1, service])).rejects.toThrow(/tracks stock/);

    // Any plan will do (no plan feature); a business type without services may not change recipes.
    await owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [k.tenantId, 'starter', 'ACTIVE', null, null]);
    await recipe(k, m.colour, { ingredients: [{ variantId: m.developer, quantity: '1' }, { variantId: m.dye, quantity: '0.15' }, { variantId: m.foil, quantity: '1' }] }).expect(201);
    await http().patch('/v1/business').set(k.auth).send({ businessType: 'RETAIL' }).expect(200);
    expect((await recipe(k, m.colour, { ingredients: [] }).expect(403)).body.error).toMatchObject({ code: 'BUSINESS_TYPE_EXCLUDES_FEATURE', details: { feature: 'recipes' } });
    await http().get(`/v1/variants/${m.colour}/recipe`).set(k.auth).expect(200);
    // Consumption keeps running after the change of type: the books must stay right.
    const sale = await sell(k, [{ variantId: m.colour, quantity: '1' }]);
    expect(await sql(k, `SELECT count(*)::int AS n FROM stock_movements WHERE sale_id = $1 AND type = 'CONSUMPTION'`, [sale.id])).toEqual([{ n: 3 }]);
  });

  it('supplies used are not restocked: returns of a service are DAMAGED only, a void restocks only shelf items', async () => {
    const k = await salon('rcp-ret');
    const m = await services(k);
    const sale = await sell(k, [{ variantId: m.colour, quantity: '2' }, { variantId: m.shampoo, quantity: '2' }]);
    const ret = (lines: unknown[]) =>
      http().post(`/v1/sales/${sale.id}/returns`).set(k.manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, kind: 'RETURN', reason: 'Unhappy with the colour', lines });
    expect((await ret([{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'RESTOCK' }]).expect(422)).body.error.code).toBe('NOT_RESTOCKABLE');
    const back = (await ret([{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'DAMAGED' }]).expect(201)).body;
    expect(back.amountDue).toBe('150.00');
    expect(await sql(k, `SELECT count(*)::int AS n FROM stock_movements WHERE type = 'RETURN'`)).toEqual([{ n: 0 }]);

    const sale2 = await sell(k, [{ variantId: m.colour, quantity: '1' }, { variantId: m.shampoo, quantity: '1' }]);
    const voided = (await http().post(`/v1/sales/${sale2.id}/returns`).set(k.manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, kind: 'VOID', reason: 'Rung up twice' }).expect(201)).body;
    expect(voided.lines.map((l: { saleLineId: string; disposition: string }) => [l.saleLineId, l.disposition])).toEqual([[sale2.lines[0].id, 'DAMAGED'], [sale2.lines[1].id, 'RESTOCK']]);
    expect(await sql(k, `SELECT variant_id, quantity::text FROM stock_movements WHERE type = 'RETURN'`)).toEqual([{ variant_id: m.shampoo, quantity: '1.0000' }]);
    // Supplies stay consumed: developer 10 − 2 − 1 = 7.
    expect((await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: m.developer }).set(k.manager).expect(200)).body.data[0]).toMatchObject({ quantity: '7' });
    await assertClean(k);
  });

  it('concurrent service and shelf sales sharing a supply, in opposite item order: no deadlock, ledger consistent', async () => {
    const k = await salon('rcp-race');
    const m = await services(k);
    await stockIn(k, [{ variantId: m.developer, quantity: '90', unitCost: '5.00' }]);
    // Developer is also sold on its own, so service and shelf sales lock the same balance rows.
    const lines = (i: number) => (i % 2 ? [{ variantId: m.colour, quantity: '1' }, { variantId: m.developer, quantity: '1' }] : [{ variantId: m.developer, quantity: '1' }, { variantId: m.shampoo, quantity: '1' }, { variantId: m.colour, quantity: '1' }]);
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        http().post('/v1/sales').set(k.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: k.session, clientTransactionId: randomUUID(), lines: lines(i), tenders: [{ method: 'CASH', tendered: '500.00' }] }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(201));
    // 100 developers − 10 in services − 10 sold alone = 80; dye 2 − 10 × 0.15 = 0.5.
    const bal = async (v: string) => (await http().get('/v1/stock/balances').query({ branchId: k.branchId, variantId: v }).set(k.manager).expect(200)).body.data[0];
    expect(await bal(m.developer)).toMatchObject({ quantity: '80', value: '400.00' });
    expect(await bal(m.dye)).toMatchObject({ quantity: '0.5', value: '200.00' });
    await assertClean(k);
  });
});

function today() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Asia/Manila business day
}
