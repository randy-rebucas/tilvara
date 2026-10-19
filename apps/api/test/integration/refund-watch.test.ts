import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/** Refund watch (THREAT_MODEL T5, session 16): who refunds what, against the branch, as signals. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('refund watch', () => {
  it('flags someone refunding at twice the branch rate, and refunds of one’s own sales; a clean cashier is not flagged', async () => {
    const t = await signup(app, 'refund-watch');
    const auth = bearer(t.access);
    const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Watch Corp', vatStatus: 'VAT' }).expect(201);
    const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
    const reg = async (code: string) => (await http().post('/v1/registers').set(auth).send({ branchId, code, name: code }).expect(201)).body.id as string;
    const [r1, r2] = [await reg('R1'), await reg('R2')];
    const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
    const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
    const fee = (await http().post('/v1/products').set(auth).send({ name: 'Service', uomId: pc, taxCategoryId: vat, productType: 'SERVICE', trackInventory: false, variants: [{ sku: uniq('S'), price: '100.00' }] }).expect(201)).body.variants[0].id as string;
    const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
    const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
    const cashier = bearer(await loginToken(app, c.email));
    const manager = bearer(await loginToken(app, m.email));
    const shift = async (who: typeof cashier, registerId: string) => (await http().post('/v1/cashier-sessions').set(who).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
    const [cs, ms] = [await shift(cashier, r1), await shift(manager, r2)];
    const sell = async (who: typeof cashier, session: string) =>
      (await http().post('/v1/sales').set(who).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: fee, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '100.00' }] }).expect(201)).body.id as string;
    for (let i = 0; i < 6; i++) await sell(cashier, cs);
    const mine = [await sell(manager, ms), await sell(manager, ms), await sell(manager, ms), await sell(manager, ms)];
    for (const id of mine.slice(0, 3)) {
      await http().post(`/v1/sales/${id}/returns`).set(manager).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: ms, kind: 'VOID', reason: 'Customer changed mind' }).expect(201);
    }

    const rep = (await http().get('/v1/reports/refund-watch').query({ branchId, from: today, to: today }).set(auth).expect(200)).body;
    // Branch: ₱1,000 sold, ₱300 refunded → 0.30. The manager: ₱300 of ₱400 → 0.75, three of their own sales.
    expect(rep.branch).toEqual({ sales: '1000.00', refunded: '300.00', refundRate: '0.3000' });
    const by = (id: string) => rep.data.find((x: { userId: string }) => x.userId === id);
    expect(by(m.userId)).toMatchObject({ salesCount: 4, sales: '400.00', voidsCount: 3, voids: '300.00', returnsCount: 0, ownSalesRefunded: 3, refunded: '300.00', refundRate: '0.7500', flags: ['HIGH_RATE', 'OWN_SALES'] });
    expect(by(c.userId)).toMatchObject({ salesCount: 6, sales: '600.00', voidsCount: 0, refunded: '0.00', refundRate: '0.0000', flags: [] });
    // Branch-scoped like every report: a cashier cannot read it; another business's branch is not found.
    await http().get('/v1/reports/refund-watch').query({ branchId, from: today, to: today }).set(cashier).expect(403);
    const other = await signup(app, 'refund-watch-b');
    await http().get('/v1/reports/refund-watch').query({ branchId, from: today, to: today }).set(bearer(other.access)).expect(404);
  });
});
