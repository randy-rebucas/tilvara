import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApp, ownerPool, signup, uniq } from './helpers.js';

/**
 * Audit 2026-10-27 (session 45) #21, the rest: an API key on the routes every member may read. A key
 * answers as the person who made it, so a route that lets a cashier read their own sales or shift without
 * a permission would hand those to a key of any scope; such routes now ask a key for the scope. Lists that
 * show each row only to whoever holds its read permission answer a key without that scope with nothing.
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

/** A shop whose owner rang a sale to a customer on their own shift, with a supplier order and a till. */
async function shop() {
  const t = await signup(app, 'a45-apikeys');
  const auth = bearer(t.access);
  await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [t.tenantId]);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Keys Corp', vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const variantId = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '20.00' }] }).expect(201)).body.variants[0].id as string;
  const customerId = (await http().post('/v1/customers').set(auth).send({ displayName: 'Maria', marketingConsent: false }).expect(201)).body.id as string;
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId, openingFloat: '100.00' }).expect(201)).body.id as string;
  const sale = (await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID())
    .send({ cashierSessionId: session, clientTransactionId: randomUUID(), customerId, lines: [{ variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '20.00' }] }).expect(201)).body;
  const supplierId = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body.id as string;
  await http().post('/v1/purchase-orders').set(auth).send({ branchId, supplierId, lines: [{ variantId, quantity: '6', unitCost: '10.00' }] }).expect(201);
  await http().post('/v1/terminals').set(auth).send({ registerId, name: 'Till 1' }).expect(201);
  const key = async (scopes: string[]): Promise<Headers> =>
    ({ Authorization: `ApiKey ${(await http().post('/v1/api-keys').set(auth).send({ name: uniq('k'), scopes }).expect(201)).body.key}` });
  return { auth, le, branchId, registerId, customerId, session, sale, key };
}

describe('API keys on routes that check inside the service (#21)', () => {
  it('a key is refused the sales, the shift report and the payments of its maker without the scope, and reads them with it', async () => {
    const s = await shop();
    const narrow = await s.key(['customers.read']);
    const sales = await s.key(['sales.read']);
    const reports = await s.key(['reports.read']);
    const catalog = await s.key(['catalog.read']);

    const needs: [string, string, Headers][] = [
      ['/v1/sales', 'sales.read', sales],
      [`/v1/sales/${s.sale.id}`, 'sales.read', sales],
      [`/v1/sales/${s.sale.id}/receipt`, 'sales.read', sales],
      [`/v1/sales/${s.sale.id}/returns`, 'sales.read', sales],
      [`/v1/payment-intents?cashierSessionId=${s.session}`, 'sales.read', sales],
      [`/v1/reports/cashier-sessions/${s.session}`, 'reports.read', reports],
      ['/v1/discount-schemes', 'catalog.read', catalog],
    ];
    for (const [path, scope, allowed] of needs) {
      const refused = (await http().get(path).set(narrow).expect(403)).body.error;
      expect([path, refused.code, refused.details?.missing]).toEqual([path, 'FORBIDDEN', [scope]]);
      expect([path, (await http().get(path).set(allowed)).status]).toEqual([path, 200]);
    }
    // A sale return id that does not exist: past the guard with the scope (404), refused without it.
    for (const path of [`/v1/sale-returns/${randomUUID()}`, `/v1/sale-returns/${randomUUID()}/receipt`]) {
      expect((await http().get(path).set(narrow).expect(403)).body.error.details.missing).toEqual(['sales.read']);
      await http().get(path).set(sales).expect(404);
    }
    expect(((await http().get('/v1/sales').set(sales).expect(200)).body.data as { id: string }[]).map((x) => x.id)).toEqual([s.sale.id]);

    // The customer's purchases: a customers.read key sees the customer, not the sale its maker rang.
    expect((await http().get(`/v1/customers/${s.customerId}`).set(narrow).expect(200)).body.id).toBe(s.customerId);
    expect((await http().get(`/v1/customers/${s.customerId}/sales`).set(narrow).expect(200)).body.data).toEqual([]);
    const both = await s.key(['customers.read', 'sales.read']);
    expect(((await http().get(`/v1/customers/${s.customerId}/sales`).set(both).expect(200)).body.data as { id: string }[]).map((x) => x.id)).toEqual([s.sale.id]);
    // Its own scope's routes are refused to the sales key.
    expect((await http().get('/v1/customers').set(sales).expect(403)).body.error.details.missing).toEqual(['customers.read']);
  });

  it('lists that show each row to its readers only give a key without the scope nothing; with it, the rows', async () => {
    const s = await shop();
    const narrow = await s.key(['customers.read']);
    const org = await s.key(['org.read']);
    const inventory = await s.key(['inventory.read']);
    const empty = ['/v1/legal-entities', '/v1/branches', '/v1/registers', '/v1/terminals', '/v1/pos/workstations', '/v1/purchase-orders',
      '/v1/cashier-sessions', '/v1/sync/terminals', '/v1/sync/transactions'];
    for (const path of empty) expect([path, (await http().get(path).set(narrow).expect(200)).body.data]).toEqual([path, []]);
    for (const path of ['/v1/legal-entities', '/v1/branches', '/v1/registers']) {
      expect([path, (await http().get(path).set(org).expect(200)).body.data.length]).toEqual([path, 1]);
    }
    expect((await http().get('/v1/purchase-orders').set(inventory).expect(200)).body.data).toHaveLength(1);
    // Neither a key nor its maker's own shift opens the shift list or the till list: their permissions are not key scopes.
    expect((await http().get('/v1/cashier-sessions').set(org).expect(200)).body.data).toEqual([]);
    expect((await http().get('/v1/pos/workstations').set(org).expect(200)).body.data).toEqual([]);
  });
});
