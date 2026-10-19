import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

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

async function catalogRefs(t: SignedUp) {
  const uoms = (await http().get('/v1/uoms').set(bearer(t.access)).expect(200)).body.data as { id: string; code: string }[];
  const taxes = (await http().get('/v1/tax-categories').set(bearer(t.access)).expect(200)).body.data as { id: string; code: string }[];
  return { uomId: uoms.find((u) => u.code === 'PC')!.id, taxCategoryId: taxes.find((x) => x.code === 'VAT')!.id };
}

async function productCount(t: SignedUp): Promise<number> {
  return (await http().get('/v1/products').query({ limit: 200 }).set(bearer(t.access)).expect(200)).body.data.length;
}

describe('idempotency keys', () => {
  let t: SignedUp;
  let refs: { uomId: string; taxCategoryId: string };
  const body = () => ({ name: 'Idem item', ...refs, variants: [{ sku: uniq('IDEM'), price: '10.00' }] });

  beforeAll(async () => {
    t = await signup(app, 'idem');
    refs = await catalogRefs(t);
  });

  it('replays the original response for a retried request and creates nothing new', async () => {
    const key = randomUUID();
    const payload = body();
    const first = await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(payload).expect(201);
    const before = await productCount(t);
    const retry = await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(payload).expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body).toEqual(first.body);
    expect(await productCount(t)).toBe(before);
  });

  it('collapses concurrent duplicates into exactly one creation', async () => {
    const key = randomUUID();
    const payload = body();
    const before = await productCount(t);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(payload)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await productCount(t)).toBe(before + 1);
  });

  it('rejects reuse of a key with a different payload or by a different user', async () => {
    const key = randomUUID();
    await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(body()).expect(201);
    const changed = await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(body()).expect(422);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const admin = await loginToken(app, (await addMember(owner, t.tenantId, 'admin')).email);
    const other = await http().post('/v1/products').set(bearer(admin)).set('Idempotency-Key', key).send(body()).expect(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not record failed attempts, so a corrected retry with the same key succeeds', async () => {
    const key = randomUUID();
    const bad = { ...body(), taxCategoryId: randomUUID() };
    await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(bad).expect(404);
    await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(body()).expect(201);
  });

  it('validates the key format and scopes keys per tenant', async () => {
    await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', 'not-a-uuid').send(body()).expect(400);
    const key = randomUUID();
    await http().post('/v1/products').set(bearer(t.access)).set('Idempotency-Key', key).send(body()).expect(201);
    const other = await signup(app, 'idem-other');
    const otherRefs = await catalogRefs(other);
    const res = await http()
      .post('/v1/products')
      .set(bearer(other.access))
      .set('Idempotency-Key', key)
      .send({ name: 'Other', ...otherRefs, variants: [{ sku: uniq('O') }] })
      .expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('transactional outbox (emission)', () => {
  it('records domain events in the same transaction as the change, visible only to that tenant', async () => {
    const t = await signup(app, 'outbox');
    const refs = await catalogRefs(t);
    const p = await http().post('/v1/products').set(bearer(t.access)).send({ name: 'Evented', ...refs, variants: [{ sku: uniq('EV') }] }).expect(201);

    const events = await asOwnerInTenant(owner, t.tenantId, async (c) =>
      (await c.query<{ topic: string; payload: Record<string, string>; status: string }>('SELECT topic, payload, status FROM outbox_events ORDER BY topic')).rows,
    );
    // By topic, not created_at: two transactions' clock readings can come back out of order after a
    // VM clock step (seen once in the session-12 gate).
    expect(events.map((e) => e.topic)).toEqual(['catalog.product_created', 'tenant.onboarded']);
    expect(events[0]!.payload).toEqual({ productId: p.body.id });
    // Sign-up without a type makes a HYBRID business (session 17); the event names the type.
    expect(events[1]!.payload).toEqual({ ownerUserId: t.userId, businessType: 'HYBRID' });
    expect(events.every((e) => e.status === 'PENDING')).toBe(true);
  });

  it('emits nothing when the business transaction rolls back', async () => {
    const t = await signup(app, 'outbox-rb');
    const refs = await catalogRefs(t);
    const sku = uniq('DUP');
    await http().post('/v1/products').set(bearer(t.access)).send({ name: 'A', ...refs, variants: [{ sku }] }).expect(201);
    await http().post('/v1/products').set(bearer(t.access)).send({ name: 'B', ...refs, variants: [{ sku }] }).expect(409);
    const n = await asOwnerInTenant(owner, t.tenantId, async (c) =>
      (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'catalog.product_created'`)).rows[0]!.n,
    );
    expect(n).toBe(1);
  });
});
