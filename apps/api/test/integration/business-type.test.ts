import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, PASSWORD, uniq } from './helpers.js';

/** Business types (session 17): RETAIL is the only one since 0112 removed GROCERY, SALON, PHARMACY and HYBRID. */
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
  it('is RETAIL at sign-up (left out or named) and shown to the screens; a removed type is refused', async () => {
    const plain = await business('bt-plain');
    expect((await http().get('/v1/me').set(plain.auth).expect(200)).body.activeTenant.businessType).toBe('RETAIL');
    const shop = await business('bt-shop', 'RETAIL');
    expect((await http().get('/v1/me').set(shop.auth).expect(200)).body.activeTenant.businessType).toBe('RETAIL');
    expect((await http().get('/v1/business').set(shop.auth).expect(200)).body).toMatchObject({ id: shop.tenantId, businessType: 'RETAIL' });
    for (const businessType of ['SPA', 'SALON', 'PHARMACY', 'GROCERY', 'HYBRID']) {
      const slug = uniq('bt-bad');
      const bad = await http()
        .post('/v1/auth/signup')
        .send({ email: `${slug}@example.ph`, password: PASSWORD, displayName: 'X', businessName: 'X', tenantSlug: slug, businessType })
        .expect(400);
      expect(code(bad)).toBe('VALIDATION_FAILED');
    }
  });

  it('a business update refuses the removed types, and their routes are gone', async () => {
    const b = await business('bt-removed', 'RETAIL');
    for (const businessType of ['SALON', 'PHARMACY', 'GROCERY', 'HYBRID']) {
      expect(code(await http().patch('/v1/business').set(b.auth).send({ businessType }).expect(400))).toBe('VALIDATION_FAILED');
    }
    expect(await typeChanges(b.tenantId)).toEqual([]);
    for (const path of ['/v1/service-staff', '/v1/appointments', '/v1/prescriptions', '/v1/pharmacy/settings', '/v1/reports/tips', '/v1/reports/commissions', '/v1/catalog/equivalents']) {
      await http().get(path).query({ branchId: b.branchId }).set(b.auth).expect(404);
    }
  });

  it('sample items are the shop set', async () => {
    const store = await business('bt-sample', 'RETAIL');
    await http().post('/v1/sample-data').set(store.auth).expect(201);
    const names = ((await http().get('/v1/products').query({ limit: 50 }).set(store.auth).expect(200)).body.data as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Rice 5 kg (sample)', 'Instant noodles (sample)']));
    expect(names).toHaveLength(8);
  });

  it('only tenant.manage changes it; the same type again records nothing; bad input is refused', async () => {
    const b = await business('bt-acl', 'RETAIL');
    const cashier = bearer(await loginToken(app, (await addMember(owner, b.tenantId, 'cashier', { type: 'BRANCH', id: b.branchId })).email));
    // Everyone in the business may read it (the screens need it).
    expect((await http().get('/v1/business').set(cashier).expect(200)).body.businessType).toBe('RETAIL');
    expect(code(await http().patch('/v1/business').set(cashier).send({ businessType: 'RETAIL' }).expect(403))).toBe('FORBIDDEN');
    await http().patch('/v1/business').set(b.auth).send({ businessType: 'RETAIL' }).expect(200);
    expect(await typeChanges(b.tenantId)).toEqual([]);
    expect(code(await http().patch('/v1/business').set(b.auth).send({ businessType: 'retail' }).expect(400))).toBe('VALIDATION_FAILED');
    expect(code(await http().patch('/v1/business').set(b.auth).send({}).expect(400))).toBe('VALIDATION_FAILED');
  });

  it('/me carries the features the plan includes, and follows a plan change', async () => {
    const b = await business('bt-feat');
    const features = async () => ((await http().get('/v1/me').set(b.auth).expect(200)).body.activeTenant.features as string[]).sort();
    // The trial is Growth.
    expect(await features()).toEqual(['advanced_reports', 'multi_entity']);
    await owner.query(`SELECT platform_set_subscription($1, 'starter', 'ACTIVE', null, null)`, [b.tenantId]);
    expect(await features()).toEqual([]);
    await owner.query(`SELECT platform_set_subscription($1, 'enterprise', 'ACTIVE', null, null)`, [b.tenantId]);
    expect(await features()).toEqual(['advanced_reports', 'api_access', 'multi_entity']);
  });

  it('a retail business gets the retail roles only', async () => {
    const shop = await business('bt-roles', 'RETAIL');
    const keys = async () => ((await http().get('/v1/roles').set(shop.auth).expect(200)).body.data as { key: string }[]).map((r) => r.key).sort();
    expect(await keys()).toEqual(['accountant', 'admin', 'branch_manager', 'cashier', 'inventory_officer', 'owner', 'purchasing_officer', 'senior_cashier']);
    // A senior cashier may refund and give discounts; a purchasing officer may not adjust stock.
    const senior = bearer(await loginToken(app, (await addMember(owner, shop.tenantId, 'senior_cashier', { type: 'BRANCH', id: shop.branchId })).email));
    const me = (await http().get('/v1/me').set(senior).expect(200)).body.activeTenant;
    expect(me.permissions).toEqual(expect.arrayContaining(['sales.refund', 'sales.void', 'sales.discount', 'customers.manage']));
  });

  it('the name can be changed by tenant.manage (audited, trimmed, 1–200 characters) and is what /me shows', async () => {
    const b = await business('bt-name', 'RETAIL');
    const cashier = bearer(await loginToken(app, (await addMember(owner, b.tenantId, 'cashier', { type: 'BRANCH', id: b.branchId })).email));
    expect(code(await http().patch('/v1/business').set(cashier).send({ name: 'Mine' }).expect(403))).toBe('FORBIDDEN');
    const before = (await http().get('/v1/business').set(b.auth).expect(200)).body.name;
    const renamed = await http().patch('/v1/business').set(b.auth).send({ name: '  Kapehan ni Lola  ' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Kapehan ni Lola', businessType: 'RETAIL' });
    const me = (await http().get('/v1/me').set(b.auth).expect(200)).body;
    expect(me.memberships.find((m: { tenantId: string }) => m.tenantId === b.tenantId).tenantName).toBe('Kapehan ni Lola');
    // Name and the same type in one request: the rename is recorded, the type is not.
    await http().patch('/v1/business').set(b.auth).send({ name: 'Kapehan', businessType: 'RETAIL' }).expect(200);
    // The same name again records nothing.
    await http().patch('/v1/business').set(b.auth).send({ name: 'Kapehan' }).expect(200);
    const renames = await asOwnerInTenant(owner, b.tenantId, async (c) =>
      (await c.query<{ metadata: unknown }>(`SELECT metadata FROM audit_logs WHERE action = 'tenant.renamed' ORDER BY occurred_at`)).rows.map((r) => r.metadata));
    expect(renames).toEqual([{ from: before, to: 'Kapehan ni Lola' }, { from: 'Kapehan ni Lola', to: 'Kapehan' }]);
    expect(await typeChanges(b.tenantId)).toEqual([]);
    for (const name of ['   ', 'x'.repeat(201)]) expect(code(await http().patch('/v1/business').set(b.auth).send({ name }).expect(400))).toBe('VALIDATION_FAILED');
  });

  it('one business cannot change or read another', async () => {
    const a = await business('bt-iso-a');
    const z = await business('bt-iso-z');
    const zName = (await http().get('/v1/business').set(z.auth).expect(200)).body.name;
    await http().patch('/v1/business').set(a.auth).send({ name: 'Mine only' }).expect(200);
    expect((await http().get('/v1/business').set(z.auth)).body).toMatchObject({ id: z.tenantId, name: zName });
    // The app role cannot touch the other tenant's row even by id.
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      const r = await c.query(`UPDATE tenants SET name = 'Taken' WHERE id = $1`, [z.tenantId]);
      expect(r.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await appPool.end();
    }
  });
});
