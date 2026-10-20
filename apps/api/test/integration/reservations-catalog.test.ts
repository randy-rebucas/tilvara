import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/** Session 20: stock reservations (available = on hand − reserved) and the supplier catalog. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

let t: SignedUp;
let auth: Auth;
let branch: string;
let register: string;
let cola: string;
let rice: string;
let wrap: string;
let cashier: Auth;
let officer: Auth;
let accountant: Auth;

const reserve = (as: Auth, body: Record<string, unknown>) => http().post('/v1/stock/reservations').set(as).send({ branchId: branch, variantId: cola, quantity: '1', note: 'Maria, Saturday', ...body });
const balance = async () => (await http().get('/v1/stock/balances').query({ branchId: branch, variantId: cola }).set(auth).expect(200)).body.data[0] as { quantity: string; reserved: string; available: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
  t = await signup(app, 'resv');
  auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Resv Corp', vatStatus: 'VAT' }).expect(201)).body.id;
  branch = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id;
  register = (await http().post('/v1/registers').set(auth).send({ branchId: branch, code: 'R1', name: 'One' }).expect(201)).body.id;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (body: Record<string, unknown>, price: string) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: taxes.VAT, ...body, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  cola = await product({ name: 'Cola' }, '22.40');
  rice = await product({ name: 'Rice', taxCategoryId: taxes.VAT_EXEMPT }, '56.00');
  wrap = await product({ name: 'Gift wrap', productType: 'SERVICE', trackInventory: false }, '15.00');
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch, reason: 'Opening', items: [{ variantId: cola, quantity: '5', unitCost: '12.00' }] }).expect(201);
  // BLOCK: a counter sale may not take what is reserved for someone else.
  await http().put(`/v1/branches/${branch}/inventory-settings`).set(auth).send({ negativeStockPolicy: 'BLOCK', lowStockAlerts: false }).expect(200);
  const scope = { type: 'BRANCH' as const, id: branch };
  cashier = bearer(await loginToken(app, (await addMember(owner, t.tenantId, 'cashier', scope)).email));
  officer = bearer(await loginToken(app, (await addMember(owner, t.tenantId, 'inventory_officer', scope)).email));
  accountant = bearer(await loginToken(app, (await addMember(owner, t.tenantId, 'accountant')).email));
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('stock reservations', () => {
  it('set stock aside: available = on hand − reserved; a counter sale under BLOCK cannot take it', async () => {
    const maria = (await http().post('/v1/customers').set(auth).send({ displayName: 'Maria Santos' }).expect(201)).body;
    const held = (await reserve(cashier, { quantity: '3', customerId: maria.id }).expect(201)).body;
    expect(held).toMatchObject({ quantity: '3', status: 'ACTIVE', customerId: maria.id, name: 'Cola' });
    expect(await balance()).toMatchObject({ quantity: '5', reserved: '3', available: '2' });
    expect((await reserve(officer, { quantity: '3' }).expect(409)).body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: '2' } });
    await reserve(accountant, {}).expect(403);
    expect((await reserve(auth, { variantId: wrap }).expect(422)).body.error.code).toBe('NOT_TRACKED');
    expect((await reserve(auth, { expiresAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(422)).body.error.code).toBe('EXPIRY_IN_PAST');

    const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: register, openingFloat: '100.00' }).expect(201)).body.id;
    const sell = (quantity: string) => http().post('/v1/sales').set(cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: cola, quantity }], tenders: [{ method: 'CASH', tendered: '100.00' }] });
    await sell('2').expect(201);
    const refused = await sell('1').expect(409);
    expect(refused.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { lines: [{ onHand: '3', reserved: '3', requested: '1' }] } });
    expect(refused.body.error.message).toContain('3 reserved');

    // Maria collects: the reservation is released, and the units can be sold.
    expect((await http().get('/v1/stock/reservations').query({ branchId: branch }).set(officer).expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([held.id]);
    const released = (await http().post(`/v1/stock/reservations/${held.id}/release`).set(cashier).send({ reason: 'Collected and paid' }).expect(200)).body;
    expect(released).toMatchObject({ status: 'RELEASED', releaseReason: 'Collected and paid' });
    await http().post(`/v1/stock/reservations/${held.id}/release`).set(cashier).send({ reason: 'again' }).expect(409);
    expect(await balance()).toMatchObject({ quantity: '3', reserved: '0', available: '3' });
    await sell('3').expect(201);
    expect((await http().get('/v1/stock/reservations').query({ branchId: branch }).set(auth).expect(200)).body.data).toEqual([]);
    expect((await http().get('/v1/stock/reservations').query({ branchId: branch, status: 'ALL' }).set(auth).expect(200)).body.data).toHaveLength(1);
  });

  it('two reservations for the last units: one gets them; an expired one stops counting; the table guards itself', async () => {
    await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: branch, reason: 'Delivery', items: [{ variantId: cola, quantity: '2', unitCost: '12.00' }] }).expect(201);
    const both = await Promise.all([reserve(auth, { quantity: '2' }), reserve(officer, { quantity: '2' })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const kept = both.find((r) => r.status === 201)!.body;
    // Pretend it ran out an hour ago: it no longer holds anything.
    await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`
      INSERT INTO stock_reservations (tenant_id, branch_id, variant_id, quantity, note, created_by, created_at, expires_at)
      SELECT tenant_id, branch_id, variant_id, 5, 'Old hold', created_by, now() - interval '2 hours', now() - interval '1 hour' FROM stock_reservations WHERE id = $1`, [kept.id]));
    expect(await balance()).toMatchObject({ quantity: '2', reserved: '2', available: '0' });
    const list = (await http().get('/v1/stock/reservations').query({ branchId: branch }).set(auth).expect(200)).body.data;
    expect(list.find((r: { note: string }) => r.note === 'Old hold')).toMatchObject({ expired: true });
    for (const q of [`UPDATE stock_reservations SET quantity = 1`, `UPDATE stock_reservations SET status = 'ACTIVE', released_at = NULL, released_by = NULL, release_reason = NULL WHERE status = 'RELEASED'`, `DELETE FROM stock_reservations`]) {
      expect(String(await asOwnerInTenant(owner, t.tenantId, (c) => c.query(q)).catch((e: Error) => e))).toMatch(/only released|never deleted/);
    }
  });
});

describe('supplier catalog', () => {
  it('a supplier’s SKU and cost per item; one preferred supplier per item; purchase orders take the cost from it', async () => {
    const coke = (await http().post('/v1/suppliers').set(auth).send({ code: 'COKE', name: 'Coca-Cola Beverages' }).expect(201)).body.id;
    const other = (await http().post('/v1/suppliers').set(auth).send({ code: 'DIST', name: 'Distributor' }).expect(201)).body.id;
    const item = (await http().post(`/v1/suppliers/${coke}/items`).set(auth).send({ variantId: cola, supplierSku: 'CK-290-24', unitCost: '11.50', preferred: true }).expect(201)).body;
    expect(item).toMatchObject({ supplierSku: 'CK-290-24', unitCost: '11.5000', preferred: true, name: 'Cola', supplierName: 'Coca-Cola Beverages' });
    expect((await http().post(`/v1/suppliers/${coke}/items`).set(auth).send({ variantId: cola }).expect(409)).body.error.code).toBe('SUPPLIER_ITEM_EXISTS');
    await http().post(`/v1/suppliers/${coke}/items`).set(cashier).send({ variantId: rice }).expect(403);
    // Making the distributor preferred takes it from Coca-Cola.
    await http().post(`/v1/suppliers/${other}/items`).set(auth).send({ variantId: cola, unitCost: '12.10', preferred: true }).expect(201);
    const sources = (await http().get(`/v1/variants/${cola}/suppliers`).set(officer).expect(200)).body.data;
    expect(sources.map((s: { supplierName: string; preferred: boolean }) => [s.supplierName, s.preferred])).toEqual([['Distributor', true], ['Coca-Cola Beverages', false]]);

    const order = (await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch, supplierId: coke, lines: [{ variantId: cola, quantity: '24' }] }).expect(201)).body;
    expect(order.lines[0]).toMatchObject({ unitCost: '11.5000', supplierSku: 'CK-290-24', lineValue: '276.00' });
    const noCost = await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch, supplierId: coke, lines: [{ variantId: cola, quantity: '1' }, { variantId: rice, quantity: '1' }] }).expect(422);
    expect(noCost.body.error).toMatchObject({ code: 'UNIT_COST_REQUIRED', details: { path: ['lines', 1, 'unitCost'] } });
    // A cost given on the line wins over the catalog.
    expect((await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch, supplierId: coke, lines: [{ variantId: cola, quantity: '1', unitCost: '10.00' }] }).expect(201)).body.lines[0].unitCost).toBe('10.0000');

    await http().patch(`/v1/supplier-items/${item.id}`).set(auth).send({ unitCost: '11.75' }).expect(200);
    expect((await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch, supplierId: coke, lines: [{ variantId: cola, quantity: '1' }] }).expect(201)).body.lines[0].unitCost).toBe('11.7500');
    await http().post(`/v1/supplier-items/${item.id}/archive`).set(auth).expect(200);
    expect((await http().get(`/v1/suppliers/${coke}/items`).set(auth).expect(200)).body.data).toEqual([]);
    await http().post('/v1/purchase-orders').set(auth).send({ branchId: branch, supplierId: coke, lines: [{ variantId: cola, quantity: '1' }] }).expect(422);
    // Archived, not deleted: the history stays.
    expect(String(await asOwnerInTenant(owner, t.tenantId, (c) => c.query(`DELETE FROM supplier_items`)).catch((e: Error) => e))).toMatch(/append-only/);
  });
});
