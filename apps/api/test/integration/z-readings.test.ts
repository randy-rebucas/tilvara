import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Z-readings (session 16; fiscal gate G2, not BIR-accredited), and one shift that spans local midnight
 * (a LEFTOVER test): its sales split into the two business days, the shift report keeps them together,
 * and the accumulated grand total carries from one day's Z-reading to the next.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const manila = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d);
const today = manila(new Date());
const yesterday = manila(new Date(Date.now() - 86_400_000));
const tomorrow = manila(new Date(Date.now() + 86_400_000));

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

async function shop() {
  const t = await signup(app, 'zread');
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Z Corp', vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Counter' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const item = (await http().post('/v1/products').set(auth).send({ name: 'Service', uomId: pc, taxCategoryId: vat, productType: 'SERVICE', trackInventory: false, variants: [{ sku: uniq('S'), price: '112.00' }] }).expect(201)).body.variants[0].id as string;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  return { tenantId: t.tenantId, auth, branchId, registerId, item, cashier: bearer(await loginToken(app, c.email)), manager: bearer(await loginToken(app, m.email)) };
}

const sql = (tenantId: string, q: string, params: unknown[] = []) => asOwnerInTenant(owner, tenantId, async (c) => (await c.query(q, params)).rows);

describe('Z-readings', () => {
  it('a shift across midnight: two business days, one shift report, Z-readings in order with the grand total carried', async () => {
    const s = await shop();
    const session = (await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: s.registerId, openingFloat: '500.00' }).expect(201)).body.id as string;
    const sell = async (n: string) =>
      (await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: s.item, quantity: n }], tenders: [{ method: 'CASH', tendered: '1000.00' }] }).expect(201)).body;
    const before = await sell('1'); // ₱112.00
    const after = await sell('2'); // ₱224.00
    await http().post(`/v1/sales/${after.id}/returns`).set(s.manager).set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: session, kind: 'RETURN', reason: 'One too many', lines: [{ saleLineId: after.lines[0].id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201);
    // The shift opened at 23:50 yesterday (Manila); the first sale rang at 23:55, the second (and its return) after midnight.
    await sql(s.tenantId, `
      DO $$ BEGIN
        ALTER TABLE cashier_sessions DISABLE TRIGGER USER; ALTER TABLE sales DISABLE TRIGGER USER;
        UPDATE cashier_sessions SET opened_at = ('${yesterday}'::date + time '23:50') AT TIME ZONE 'Asia/Manila' WHERE id = '${session}';
        UPDATE sales SET completed_at = ('${yesterday}'::date + time '23:55') AT TIME ZONE 'Asia/Manila' WHERE id = '${before.id}';
        ALTER TABLE cashier_sessions ENABLE TRIGGER USER; ALTER TABLE sales ENABLE TRIGGER USER;
      END $$`);

    // Shift report: both sales, one shift.
    const x = (await http().get(`/v1/reports/cashier-sessions/${session}`).set(s.manager).expect(200)).body;
    expect(x.sales).toMatchObject({ count: 2, amountDue: '336.00', firstNumber: 1, lastNumber: 2 });
    // Daily summary: the first sale on yesterday's local day, the second (and its return) on today's.
    const days = (await http().get('/v1/reports/sales-summary').query({ branchId: s.branchId, from: yesterday, to: today }).set(s.manager).expect(200)).body.days as { day: string; salesCount: number; returnsCount: number }[];
    expect(days.map((d) => [d.day, d.salesCount, d.returnsCount])).toEqual([[yesterday, 1, 0], [today, 1, 1]]);

    // Z-readings: not while the shift is open; then yesterday, then today.
    const z = (day: string, who = s.manager) => http().post(`/v1/registers/${s.registerId}/z-readings`).set(who).send({ day });
    expect((await z(yesterday).expect(409)).body.error.code).toBe('SHIFT_OPEN');
    await http().post(`/v1/cashier-sessions/${session}/close`).set(s.cashier).send({ countedCash: '724.00' }).expect(200);
    await z(yesterday, s.cashier).expect(403);
    expect((await z(tomorrow).expect(422)).body.error.code).toBe('DAY_NOT_STARTED');
    const z1 = (await z(yesterday).expect(201)).body;
    expect(z1).toMatchObject({ zNumber: 1, businessDay: yesterday, firstSaleNumber: 1, lastSaleNumber: 1, salesCount: 1, salesAmount: '112.00', vatableSales: '100.00', vatAmount: '12.00', returnsAmount: '0.00', netAmount: '112.00', previousGrandTotal: '0.00', grandTotal: '112.00', tenders: { CASH: '112.00' } });
    expect(z1.note).toMatch(/Not a BIR-accredited/);
    const z2 = (await z(today).expect(201)).body;
    expect(z2).toMatchObject({ zNumber: 2, businessDay: today, firstSaleNumber: 2, lastSaleNumber: 2, salesAmount: '224.00', returnsCount: 1, returnsAmount: '112.00', netAmount: '112.00', previousGrandTotal: '112.00', grandTotal: '224.00', tenders: { CASH: '112.00' } });
    // Once per day, and only forward.
    expect((await z(today).expect(409)).body.error.code).toBe('Z_READING_ORDER');
    expect((await z(yesterday).expect(409)).body.error.code).toBe('Z_READING_ORDER');
    expect((await http().get(`/v1/registers/${s.registerId}/z-readings`).set(s.manager).expect(200)).body.data.map((r: { zNumber: number }) => r.zNumber)).toEqual([2, 1]);
    expect((await http().get(`/v1/z-readings/${z1.id}`).set(s.manager).expect(200)).body).toMatchObject({ grandTotal: '112.00', register: { code: 'R1' } });
    // The record cannot be changed afterwards.
    const err = await sql(s.tenantId, `UPDATE z_readings SET grand_total = 0`).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/append-only|not allowed|forbidden/i);
    // Another business sees nothing of it.
    const other = await signup(app, 'zread-b');
    await http().get(`/v1/z-readings/${z1.id}`).set(bearer(other.access)).expect(404);
    await http().post(`/v1/registers/${s.registerId}/z-readings`).set(bearer(other.access)).send({ day: today }).expect(404);
  });
});
