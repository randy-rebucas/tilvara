import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq } from './helpers.js';

/**
 * Audit 2026-10-27 (session 45) #43, the API half: taking a Z-reading and opening a count sheet honour the
 * Idempotency-Key the admin sends, so a request whose answer was lost and is sent again gets the first
 * answer back instead of "already taken" or SHEET_OPEN.
 */
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

async function shop() {
  const t = await signup(app, 'a45-idem');
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Idem Corp', vatStatus: 'VAT' }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const variantId = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, trackInventory: true, variants: [{ sku: uniq('SKU'), price: '20.00' }] }).expect(201)).body.variants[0].id as string;
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId, reason: 'Opening', items: [{ variantId, quantity: '5', unitCost: '10.00' }] }).expect(201);
  return { tenantId: t.tenantId, auth, branchId, registerId };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

describe('Idempotency-Key on Z-readings and count sheets (#43)', () => {
  it('a Z-reading sent again with its key replays the first reading; a new key is refused as already taken', async () => {
    const s = await shop();
    const key = randomUUID();
    const take = (k: string) => http().post(`/v1/registers/${s.registerId}/z-readings`).set(s.auth).set('Idempotency-Key', k).send({ day: today() });
    const first = (await take(key).expect(201)).body;
    const again = await take(key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first);
    expect((await take(randomUUID()).expect(409)).body.error.code).toBe('Z_READING_ORDER');
    const rows = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM z_readings`)).rows);
    expect(rows).toEqual([{ n: 1 }]);
    // Without a key, as before: refused as already taken.
    expect((await http().post(`/v1/registers/${s.registerId}/z-readings`).set(s.auth).send({ day: today() }).expect(409)).body.error.code).toBe('Z_READING_ORDER');
  });

  it('a count sheet opened again with its key replays the first sheet; a new key is refused SHEET_OPEN', async () => {
    const s = await shop();
    const key = randomUUID();
    const open = (k: string) => http().post('/v1/stock/count-sheets').set(s.auth).set('Idempotency-Key', k).send({ branchId: s.branchId, notes: 'Month end' });
    const first = (await open(key).expect(201)).body;
    const again = await open(key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.id);
    expect((await open(randomUUID()).expect(409)).body.error.code).toBe('SHEET_OPEN');
    // The same key with another body is a different request.
    expect((await http().post('/v1/stock/count-sheets').set(s.auth).set('Idempotency-Key', key).send({ branchId: s.branchId, notes: 'Other' }).expect(422)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const rows = await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM stock_count_sheets`)).rows);
    expect(rows).toEqual([{ n: 1 }]);
  });
});
