import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Weighted-average costing in the stock ledger (ADR-0012). */
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

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, referenceCost?: string) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price, ...(referenceCost && { referenceCost }) }] }).expect(201)).body.variants[0].id as string;
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: reg.body.id, openingFloat: '10000.00' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, auth, manager, branchId: br.body.id as string, session, product };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const adjust = (s: Shop, items: { variantId: string; quantity: string; unitCost?: string }[], reason = 'Count') =>
  http().post('/v1/stock/adjustments').set(s.manager).send({ branchId: s.branchId, reason, items });
const sell = async (s: Shop, lines: { variantId: string; quantity: string }[]) =>
  (await http().post('/v1/sales').set(s.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered: '9999.00' }] }).expect(201)).body;
const balance = async (s: Shop, variantId: string) =>
  (await http().get('/v1/stock/balances').query({ branchId: s.branchId, variantId }).set(s.manager).expect(200)).body.data[0] as { quantity: string; avgCost: string; value: string };
const lastMove = async (s: Shop, variantId: string) =>
  (await http().get('/v1/stock/movements').query({ branchId: s.branchId, variantId }).set(s.manager).expect(200)).body.data[0] as { type: string; quantity: string; unitCost: string; value: string };

/** Σ movement value = balance value and Σ quantity = balance quantity, for every item of the tenant. */
async function assertLedgerInvariant(s: Shop) {
  const drift = await asOwnerInTenant(owner, s.tenantId, async (c) =>
    (await c.query(`
      SELECT b.variant_id, b.quantity, b.value, sum(m.quantity) AS q, sum(m.value) AS v
        FROM stock_balances b JOIN stock_movements m ON m.branch_id = b.branch_id AND m.variant_id = b.variant_id
       GROUP BY 1, 2, 3 HAVING b.quantity <> sum(m.quantity) OR b.value <> sum(m.value)`)).rows,
  );
  expect(drift).toEqual([]);
}

describe('weighted-average cost (ADR-0012)', () => {
  it('receipts average, sales leave at the average, returns come back at the sale cost, emptying leaves no residue', async () => {
    const s = await shop('cost-avg');
    const cola = await s.product('Cola', '22.40');
    await adjust(s, [{ variantId: cola, quantity: '10', unitCost: '10.00' }]).expect(201);
    await adjust(s, [{ variantId: cola, quantity: '10', unitCost: '12.00' }]).expect(201);
    expect(await balance(s, cola)).toMatchObject({ quantity: '20', avgCost: '11.0000', value: '220.00' });

    const sale = await sell(s, [{ variantId: cola, quantity: '5' }]);
    expect(await lastMove(s, cola)).toMatchObject({ type: 'SALE', quantity: '-5', unitCost: '11.0000', value: '-55.00' });
    await http().post(`/v1/sales/${sale.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: s.session, kind: 'RETURN', reason: 'Dented', lines: [{ saleLineId: sale.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    expect(await lastMove(s, cola)).toMatchObject({ type: 'RETURN', quantity: '1', unitCost: '11.0000', value: '11.00' });

    await adjust(s, [{ variantId: cola, quantity: '4', unitCost: '14.50' }]).expect(201);
    expect(await balance(s, cola)).toMatchObject({ quantity: '20', avgCost: '11.7000', value: '234.00' });
    await sell(s, [{ variantId: cola, quantity: '20' }]);
    expect(await lastMove(s, cola)).toMatchObject({ value: '-234.00' });
    expect(await balance(s, cola)).toMatchObject({ quantity: '0', value: '0.00', avgCost: '11.7000' });
    await assertLedgerInvariant(s);
  });

  it('selling short costs at the last average; the next receipt restarts the average and shows the revaluation', async () => {
    const s = await shop('cost-neg');
    const cola = await s.product('Cola', '22.40');
    await adjust(s, [{ variantId: cola, quantity: '1', unitCost: '11.70' }]).expect(201);
    await sell(s, [{ variantId: cola, quantity: '3' }]);
    expect(await balance(s, cola)).toMatchObject({ quantity: '-2', avgCost: '11.7000', value: '-23.40' });
    await adjust(s, [{ variantId: cola, quantity: '5', unitCost: '13.00' }], 'Delivery').expect(201);
    // 3 on hand at 13.00 = 39.00; the movement moved 62.40, i.e. 65.00 at cost − 2.60 revaluation of the 2 sold short.
    expect(await balance(s, cola)).toMatchObject({ quantity: '3', avgCost: '13.0000', value: '39.00' });
    expect(await lastMove(s, cola)).toMatchObject({ quantity: '5', unitCost: '13.0000', value: '62.40' });
    await assertLedgerInvariant(s);
  });

  it('rounding: the last unit out takes the exact remainder', async () => {
    const s = await shop('cost-round');
    const item = await s.product('Item', '50.00');
    for (const c of ['10.00', '10.00', '11.00']) await adjust(s, [{ variantId: item, quantity: '1', unitCost: c }]).expect(201);
    expect(await balance(s, item)).toMatchObject({ quantity: '3', avgCost: '10.3333', value: '31.00' });
    const values = [];
    for (let i = 0; i < 3; i++) {
      await sell(s, [{ variantId: item, quantity: '1' }]);
      values.push((await lastMove(s, item)).value);
    }
    expect(values).toEqual(['-10.33', '-10.33', '-10.33']); // 2-dp view of −10.3333, −10.3333, −10.3334
    const exact = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT m.value::text FROM stock_movements m JOIN sales s ON s.id = m.sale_id WHERE m.type = 'SALE' ORDER BY s.sale_number`)).rows.map((r) => r.value));
    expect(exact).toEqual(['-10.3333', '-10.3333', '-10.3334']);
    expect(await balance(s, item)).toMatchObject({ quantity: '0', value: '0.00' });
  });

  it('adjustment default cost: the average while on hand, else the reference cost', async () => {
    const s = await shop('cost-default');
    const item = await s.product('Item', '50.00', '9.50');
    await adjust(s, [{ variantId: item, quantity: '2' }]).expect(201);
    expect(await lastMove(s, item)).toMatchObject({ unitCost: '9.5000', value: '19.00' });
    await adjust(s, [{ variantId: item, quantity: '2', unitCost: '11.50' }]).expect(201);
    await adjust(s, [{ variantId: item, quantity: '1' }]).expect(201);
    expect(await lastMove(s, item)).toMatchObject({ unitCost: '10.5000' });
    await adjust(s, [{ variantId: item, quantity: '-1' }]).expect(201);
    expect(await lastMove(s, item)).toMatchObject({ unitCost: '10.5000', value: '-10.50' });
    await adjust(s, [{ variantId: item, quantity: '1', unitCost: '-1' }]).expect(400);
  });

  it('the app role cannot choose an outbound cost nor bring stock in without one', async () => {
    const s = await shop('cost-guard');
    const item = await s.product('Item', '50.00');
    await adjust(s, [{ variantId: item, quantity: '2', unitCost: '10.00' }]).expect(201);
    const runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const c = await runtime.connect();
    const insert = (quantity: string, unitCost: string | null) =>
      c.query(
        // Attached to an existing adjustment document: a movement without one is refused (stock_movements_adjustment_link).
        `INSERT INTO stock_movements (tenant_id, branch_id, variant_id, quantity, unit_cost, type, reason, stock_adjustment_id, created_by)
         SELECT $1, $2, $3, $4, $5, 'ADJUSTMENT', 'direct', stock_adjustment_id, created_by FROM stock_movements LIMIT 1 RETURNING unit_cost::text, value::text`,
        [s.tenantId, s.branchId, item, quantity, unitCost],
      );
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.tenantId]);
      expect((await insert('-1', '999.00')).rows[0]).toEqual({ unit_cost: '10.0000', value: '-10.0000' });
      const err = await insert('1', null).then(() => null, (e: Error) => e.message);
      expect(err).toMatch(/needs a unit cost/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.tenantId]);
      expect(await c.query('UPDATE stock_balances SET value = 0').then(() => null, (e: { code?: string }) => e.code)).toBe('42501');
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await runtime.end();
    }
  });

  it('concurrent multi-item sales in opposite item order do not deadlock and keep the ledger consistent', async () => {
    const s = await shop('cost-race');
    const a = await s.product('A', '10.00');
    const b = await s.product('B', '10.00');
    await adjust(s, [{ variantId: a, quantity: '100', unitCost: '4.00' }, { variantId: b, quantity: '100', unitCost: '6.00' }]).expect(201);
    const lines = (i: number) => (i % 2 ? [{ variantId: a, quantity: '1' }, { variantId: b, quantity: '2' }] : [{ variantId: b, quantity: '2' }, { variantId: a, quantity: '1' }]);
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        http().post('/v1/sales').set(s.auth).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: s.session, clientTransactionId: randomUUID(), lines: lines(i), tenders: [{ method: 'CASH', tendered: '100.00' }] }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(await balance(s, a)).toMatchObject({ quantity: '88', value: '352.00' });
    expect(await balance(s, b)).toMatchObject({ quantity: '76', value: '456.00' });
    await assertLedgerInvariant(s);
  });
});
