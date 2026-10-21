import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, PASSWORD, uniq } from './helpers.js';

/** Business types (session 17): what the business does decides which features it gets. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
const code = (res: request.Response) => res.body.error?.code as string | undefined;

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

async function business(prefix: string, businessType?: string) {
  const slug = uniq(prefix);
  const res = await http()
    .post('/v1/auth/signup')
    .send({ email: `${slug}@example.ph`, password: PASSWORD, displayName: 'Owner', businessName: `Biz ${slug}`, tenantSlug: slug, ...(businessType && { businessType }) })
    .expect(201);
  const auth = bearer(res.body.tokens.accessToken);
  const tenantId = res.body.activeTenantId as string;
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  return { tenantId, auth, branchId: br.body.id as string };
}

const typeChanges = (tenantId: string) =>
  asOwnerInTenant(owner, tenantId, async (c) =>
    (await c.query<{ metadata: unknown }>(`SELECT metadata FROM audit_logs WHERE action = 'tenant.business_type_changed' ORDER BY occurred_at`)).rows.map((r) => r.metadata),
  );

describe('business type', () => {
  it('is chosen at sign-up (every feature when left out) and shown to the screens', async () => {
    const plain = await business('bt-plain');
    expect((await http().get('/v1/me').set(plain.auth).expect(200)).body.activeTenant.businessType).toBe('HYBRID');
    const shop = await business('bt-shop', 'RETAIL');
    expect((await http().get('/v1/me').set(shop.auth).expect(200)).body.activeTenant.businessType).toBe('RETAIL');
    expect((await http().get('/v1/business').set(shop.auth).expect(200)).body).toMatchObject({ id: shop.tenantId, businessType: 'RETAIL' });
    const slug = uniq('bt-bad');
    const bad = await http()
      .post('/v1/auth/signup')
      .send({ email: `${slug}@example.ph`, password: PASSWORD, displayName: 'X', businessName: 'X', tenantSlug: slug, businessType: 'SPA' })
      .expect(400);
    expect(code(bad)).toBe('VALIDATION_FAILED');
  });

  it('a retail business is refused restaurant service, keeps reading what it had, and gets it back by changing type', async () => {
    const b = await business('bt-retail', 'HYBRID');
    await http().post('/v1/dining-areas').set(b.auth).send({ branchId: b.branchId, name: 'Hall' }).expect(201);
    await http().patch('/v1/business').set(b.auth).send({ businessType: 'RETAIL' }).expect(200);

    const refused = await http().post('/v1/dining-areas').set(b.auth).send({ branchId: b.branchId, name: 'Patio' }).expect(403);
    expect(code(refused)).toBe('BUSINESS_TYPE_EXCLUDES_FEATURE');
    expect(code(await http().post('/v1/restaurant/orders').set(b.auth).send({ branchId: b.branchId, orderType: 'TAKEAWAY' }).expect(403))).toBe('BUSINESS_TYPE_EXCLUDES_FEATURE');
    // What was set up before stays readable.
    const areas = await http().get('/v1/dining-areas').query({ branchId: b.branchId }).set(b.auth).expect(200);
    expect(areas.body.data.map((a: { name: string }) => a.name)).toEqual(['Hall']);

    await http().patch('/v1/business').set(b.auth).send({ businessType: 'RESTAURANT' }).expect(200);
    await http().post('/v1/dining-areas').set(b.auth).send({ branchId: b.branchId, name: 'Patio' }).expect(201);
    expect(await typeChanges(b.tenantId)).toEqual([{ from: 'HYBRID', to: 'RETAIL' }, { from: 'RETAIL', to: 'RESTAURANT' }]);
  });

  it('a sari-sari store or grocery (ADR-0020) gates like a retail shop and gets its own sample items', async () => {
    const store = await business('bt-sari', 'GROCERY');
    expect((await http().get('/v1/me').set(store.auth).expect(200)).body.activeTenant.businessType).toBe('GROCERY');
    const refused = await http().post('/v1/dining-areas').set(store.auth).send({ branchId: store.branchId, name: 'Hall' }).expect(403);
    expect(code(refused)).toBe('BUSINESS_TYPE_EXCLUDES_FEATURE');
    expect(refused.body.error.details).toMatchObject({ feature: 'restaurant', businessType: 'GROCERY' });
    const keys = ((await http().get('/v1/roles').set(store.auth).expect(200)).body.data as { key: string }[]).map((r) => r.key);
    expect(keys).not.toEqual(expect.arrayContaining(['restaurant_manager']));
    expect(keys).not.toContain('kitchen_crew');

    await http().post('/v1/sample-data').set(store.auth).expect(201);
    const names = ((await http().get('/v1/products').query({ limit: 50 }).set(store.auth).expect(200)).body.data as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['3-in-1 coffee sachet (sample)', 'Rice per kilo (sample)']));

    // Taking on a restaurant adds the restaurant roles, as from RETAIL.
    await http().patch('/v1/business').set(store.auth).send({ businessType: 'HYBRID' }).expect(200);
    expect(await typeChanges(store.tenantId)).toEqual([{ from: 'GROCERY', to: 'HYBRID', rolesAdded: ['restaurant_manager', 'kitchen_crew', 'front_desk', 'stylist', 'housekeeping'] }]);
    await http().post('/v1/dining-areas').set(store.auth).send({ branchId: store.branchId, name: 'Hall' }).expect(201);
    // Back to GROCERY is refused while an order is open, like RETAIL.
    await http().post('/v1/restaurant/orders').set(store.auth).send({ branchId: store.branchId, orderType: 'TAKEAWAY' }).expect(201);
    expect(code(await http().patch('/v1/business').set(store.auth).send({ businessType: 'GROCERY' }).expect(409))).toBe('OPEN_RESTAURANT_ORDERS');
  });

  it('cannot become retail while restaurant orders are open', async () => {
    const b = await business('bt-open', 'RESTAURANT');
    const order = await http().post('/v1/restaurant/orders').set(b.auth).send({ branchId: b.branchId, orderType: 'TAKEAWAY' }).expect(201);
    const res = await http().patch('/v1/business').set(b.auth).send({ businessType: 'RETAIL' }).expect(409);
    expect(code(res)).toBe('OPEN_RESTAURANT_ORDERS');
    expect(res.body.error.details).toMatchObject({ openOrders: 1 });
    expect((await http().get('/v1/business').set(b.auth)).body.businessType).toBe('RESTAURANT');

    await http().post(`/v1/restaurant/orders/${order.body.id}/cancel`).set(b.auth).send({ reason: 'Walked out' }).expect(200);
    await http().patch('/v1/business').set(b.auth).send({ businessType: 'RETAIL' }).expect(200);
  });

  it('only tenant.manage changes it; the same type again records nothing; bad input is refused', async () => {
    const b = await business('bt-acl', 'HYBRID');
    const cashier = bearer(await loginToken(app, (await addMember(owner, b.tenantId, 'cashier', { type: 'BRANCH', id: b.branchId })).email));
    // Everyone in the business may read it (the screens need it).
    expect((await http().get('/v1/business').set(cashier).expect(200)).body.businessType).toBe('HYBRID');
    expect(code(await http().patch('/v1/business').set(cashier).send({ businessType: 'RETAIL' }).expect(403))).toBe('FORBIDDEN');
    await http().patch('/v1/business').set(b.auth).send({ businessType: 'HYBRID' }).expect(200);
    expect(await typeChanges(b.tenantId)).toEqual([]);
    expect(code(await http().patch('/v1/business').set(b.auth).send({ businessType: 'retail' }).expect(400))).toBe('VALIDATION_FAILED');
    expect(code(await http().patch('/v1/business').set(b.auth).send({}).expect(400))).toBe('VALIDATION_FAILED');
  });

  it('/me carries the features the plan includes, and follows a plan change', async () => {
    const b = await business('bt-feat', 'HYBRID');
    const features = async () => ((await http().get('/v1/me').set(b.auth).expect(200)).body.activeTenant.features as string[]).sort();
    // The trial is Growth.
    expect(await features()).toEqual(['advanced_reports', 'multi_entity', 'restaurant']);
    await owner.query(`SELECT platform_set_subscription($1, 'starter', 'ACTIVE', null, null)`, [b.tenantId]);
    expect(await features()).toEqual([]);
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [b.tenantId]);
    expect(await features()).toEqual(['advanced_reports', 'api_access', 'multi_entity', 'restaurant']);
  });

  it('a retail business starts without restaurant roles and gets them when it takes on a restaurant', async () => {
    const shop = await business('bt-roles', 'RETAIL');
    const keys = async () => ((await http().get('/v1/roles').set(shop.auth).expect(200)).body.data as { key: string }[]).map((r) => r.key).sort();
    expect(await keys()).toEqual(['accountant', 'admin', 'branch_manager', 'cashier', 'inventory_officer', 'owner', 'purchasing_officer', 'senior_cashier']);
    await http().patch('/v1/business').set(shop.auth).send({ businessType: 'HYBRID' }).expect(200);
    expect(await keys()).toEqual(expect.arrayContaining(['kitchen_crew', 'restaurant_manager']));
    const crew = ((await http().get('/v1/roles').set(shop.auth)).body.data as { key: string; permissions: string[]; isSystem: boolean }[]).find((r) => r.key === 'kitchen_crew');
    expect(crew).toMatchObject({ isSystem: true, permissions: ['kitchen.operate'] });
    expect(await typeChanges(shop.tenantId)).toEqual([{ from: 'RETAIL', to: 'HYBRID', rolesAdded: ['restaurant_manager', 'kitchen_crew', 'front_desk', 'stylist', 'housekeeping'] }]);
    // Back and forth again: nothing new to add, roles kept.
    await http().patch('/v1/business').set(shop.auth).send({ businessType: 'RETAIL' }).expect(200);
    await http().patch('/v1/business').set(shop.auth).send({ businessType: 'RESTAURANT' }).expect(200);
    expect((await typeChanges(shop.tenantId)).slice(1)).toEqual([{ from: 'HYBRID', to: 'RETAIL' }, { from: 'RETAIL', to: 'RESTAURANT' }]);
    // A senior cashier may refund and give discounts; a purchasing officer may not adjust stock.
    const senior = bearer(await loginToken(app, (await addMember(owner, shop.tenantId, 'senior_cashier', { type: 'BRANCH', id: shop.branchId })).email));
    const me = (await http().get('/v1/me').set(senior).expect(200)).body.activeTenant;
    expect(me.permissions).toEqual(expect.arrayContaining(['sales.refund', 'sales.void', 'sales.discount', 'customers.manage']));
  });

  it('the name can be changed by tenant.manage (audited, trimmed, 1–200 characters) and is what /me shows', async () => {
    const b = await business('bt-name', 'HYBRID');
    const cashier = bearer(await loginToken(app, (await addMember(owner, b.tenantId, 'cashier', { type: 'BRANCH', id: b.branchId })).email));
    expect(code(await http().patch('/v1/business').set(cashier).send({ name: 'Mine' }).expect(403))).toBe('FORBIDDEN');
    const before = (await http().get('/v1/business').set(b.auth).expect(200)).body.name;
    const renamed = await http().patch('/v1/business').set(b.auth).send({ name: '  Kapehan ni Lola  ' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Kapehan ni Lola', businessType: 'HYBRID' });
    const me = (await http().get('/v1/me').set(b.auth).expect(200)).body;
    expect(me.memberships.find((m: { tenantId: string }) => m.tenantId === b.tenantId).tenantName).toBe('Kapehan ni Lola');
    // Name and type in one request: both recorded.
    await http().patch('/v1/business').set(b.auth).send({ name: 'Kapehan', businessType: 'RESTAURANT' }).expect(200);
    // The same name again records nothing.
    await http().patch('/v1/business').set(b.auth).send({ name: 'Kapehan' }).expect(200);
    const renames = await asOwnerInTenant(owner, b.tenantId, async (c) =>
      (await c.query<{ metadata: unknown }>(`SELECT metadata FROM audit_logs WHERE action = 'tenant.renamed' ORDER BY occurred_at`)).rows.map((r) => r.metadata));
    expect(renames).toEqual([{ from: before, to: 'Kapehan ni Lola' }, { from: 'Kapehan ni Lola', to: 'Kapehan' }]);
    expect(await typeChanges(b.tenantId)).toEqual([{ from: 'HYBRID', to: 'RESTAURANT' }]);
    for (const name of ['   ', 'x'.repeat(201)]) expect(code(await http().patch('/v1/business').set(b.auth).send({ name }).expect(400))).toBe('VALIDATION_FAILED');
  });

  it('one business cannot change or read another', async () => {
    const a = await business('bt-iso-a', 'HYBRID');
    const z = await business('bt-iso-z', 'HYBRID');
    await http().patch('/v1/business').set(a.auth).send({ businessType: 'RETAIL' }).expect(200);
    expect((await http().get('/v1/business').set(z.auth)).body).toMatchObject({ id: z.tenantId, businessType: 'HYBRID' });
    // The app role cannot touch the other tenant's row even by id.
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      const r = await c.query(`UPDATE tenants SET business_type = 'RETAIL' WHERE id = $1`, [z.tenantId]);
      expect(r.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await appPool.end();
    }
  });
});
