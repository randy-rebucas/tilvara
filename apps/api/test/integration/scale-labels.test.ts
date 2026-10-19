import type { INestApplication } from '@nestjs/common';
import { ean13CheckDigit } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Weighing-scale labels at the counter (session 16). */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const label = (first12: string) => `${first12}${ean13CheckDigit(first12)}`;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('scale labels', () => {
  it('a weighed label finds the item by its scale code and sells the printed weight; a unit item cannot carry one', async () => {
    const t = await signup(app, 'scale');
    const auth = bearer(t.access);
    const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Scale Corp', vatStatus: 'VAT' }).expect(201);
    const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
    const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter' }).expect(201)).body.id as string;
    const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
    const uoms = Object.fromEntries(((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).map((u) => [u.code, u.id]));
    const pork = (await http().post('/v1/products').set(auth).send({ name: 'Pork belly', uomId: uoms.KG, soldBy: 'WEIGHT', taxCategoryId: taxes.VAT_EXEMPT, trackInventory: false, variants: [{ sku: uniq('PORK'), barcodes: ['212345'], price: '320.00' }] }).expect(201)).body.variants[0].id as string;
    await http().post('/v1/products').set(auth).send({ name: 'Soy sauce', uomId: uoms.PC, taxCategoryId: taxes.VAT, variants: [{ sku: uniq('SOY'), barcodes: ['254321'], price: '25.00' }] }).expect(201);
    const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
    const cashier = bearer(await loginToken(app, c.email));
    const lookup = (code: string) => http().get('/v1/catalog/lookup').query({ code, branchId }).set(cashier);

    const item = (await lookup(label('212345012340')).expect(200)).body;
    expect(item).toMatchObject({ variantId: pork, quantity: '1.234', soldBy: 'WEIGHT', price: { amount: '320.0000' } });
    // The scale code alone is still an ordinary barcode (no weight).
    expect((await lookup('212345').expect(200)).body.quantity).toBeUndefined();
    // A wrong check digit is not a label; a unit item's code cannot carry a weight.
    const good = label('212345012340');
    await lookup(`${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`).expect(404);
    expect((await lookup(label('254321010000')).expect(422)).body.error.code).toBe('SCALE_LABEL_NOT_BY_WEIGHT');

    // Sold at the weight on the label: 1.234 kg × ₱320.00 = ₱394.88.
    const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId, openingFloat: '500.00' }).expect(201)).body.id as string;
    const sale = (await http().post('/v1/sales').set(cashier).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: pork, quantity: item.quantity }], tenders: [{ method: 'CASH', tendered: '400.00' }] }).expect(201)).body;
    expect(sale.amountDue).toBe('394.88');
  });
});
