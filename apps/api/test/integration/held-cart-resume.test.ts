import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Resuming a held cart is replay-safe (audit 2026-10-27 #32): a lost answer does not lose the cart. */
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

describe('resuming a held cart with an Idempotency-Key', () => {
  it('a replay with the same key returns the same lines and SC/PWD details; another key is refused as closed', async () => {
    const t = await signup(app, 'resume-key');
    const auth = bearer(t.access);
    const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Resume Corp', vatStatus: 'VAT' }).expect(201);
    const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
    const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
    const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const cola = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '22.40' }] }).expect(201)).body.variants[0].id as string;
    const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
    const manager = bearer(await loginToken(app, m.email));
    const session = (await http().post('/v1/cashier-sessions').set(manager).send({ registerId: reg.body.id, openingFloat: '1000.00' }).expect(201)).body.id as string;
    const cart = {
      cashierSessionId: session, label: 'Lady in blue',
      lines: [{ id: 'l1', variantId: cola, sku: 'COLA', name: 'Cola', quantity: '2', statutory: { scheme: 'SC', beneficiary: 'b1' } }],
      beneficiaries: [{ ref: 'b1', scheme: 'SC', name: 'Corazon Dela Cruz', idNumber: 'OSCA-0001' }],
    };
    const held = (await http().post('/v1/held-carts').set(manager).set('Idempotency-Key', randomUUID()).send(cart).expect(201)).body;

    const key = randomUUID();
    const resume = (k: string) => http().post(`/v1/held-carts/${held.id}/resume`).set(manager).set('Idempotency-Key', k).send({ cashierSessionId: session });
    const first = await resume(key).expect(200);
    expect(first.body).toMatchObject({ label: 'Lady in blue', lines: cart.lines, beneficiaries: cart.beneficiaries });
    // The answer was lost: the till sends the same request with the same key and gets the cart back.
    const again = await resume(key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    // A different resume (new key) finds it already resumed.
    expect((await resume(randomUUID()).expect(409)).body.error.code).toBe('HELD_CART_CLOSED');
    // The same key for another body is refused.
    expect((await http().post(`/v1/held-carts/${held.id}/resume`).set(manager).set('Idempotency-Key', key).send({ cashierSessionId: randomUUID() }).expect(422)).body.error.code)
      .toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
