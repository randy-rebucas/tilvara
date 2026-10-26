import type { INestApplication } from '@nestjs/common';
import type { Snapshot } from '@1pos/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, loginToken, ownerPool, signup, type SignedUp } from './helpers.js';
import {
  createFixtureApp,
  FIXTURE,
  FIXTURE_ADDON,
  FIXTURE_PERMISSION,
  FIXTURE_WITHDRAWN,
  fixtureState,
  seedExtensionFixtures,
} from './fixtures/extension-fixture.js';

/** Extensions (ADR-0026), proven with the test-only fixture extensions. */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  owner = ownerPool();
  await seedExtensionFixtures(owner);
  app = await createFixtureApp();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const plan = (t: SignedUp, code: string) => owner.query(`SELECT platform_set_subscription($1, $2, 'ACTIVE', null, null)`, [t.tenantId, code]);
const enable = (t: SignedUp, code: string, key?: string) =>
  http().post(`/v1/extensions/${code}/enable`).set(bearer(t.access)).set(key ? { 'Idempotency-Key': key } : {});
const disable = (t: SignedUp, code: string) => http().post(`/v1/extensions/${code}/disable`).set(bearer(t.access));
const me = async (t: SignedUp) => (await http().get('/v1/me').set(bearer(t.access)).expect(200)).body.activeTenant;
const catalog = async (t: SignedUp) =>
  ((await http().get('/v1/extensions').set(bearer(t.access)).expect(200)).body as { code: string; enabled: boolean; usable: boolean; allowedByPlan: boolean; missing: string[] }[])
    .filter((e) => e.code.startsWith('test_'));
const sql = <T = Record<string, unknown>>(t: SignedUp, q: string, params: unknown[] = []) => asOwnerInTenant(owner, t.tenantId, async (c) => (await c.query(q, params)).rows as T[]);

describe('the catalog and switching an extension on', () => {
  it('a new business has none on; the catalog lists the offered ones (not the withdrawn) with what the plan allows', async () => {
    const t = await signup(app, 'ext-new');
    expect((await me(t)).extensions).toEqual([]);
    expect(await catalog(t)).toEqual([
      expect.objectContaining({ code: FIXTURE_ADDON, enabled: false, usable: false, allowedByPlan: true, missing: [FIXTURE] }),
      expect.objectContaining({ code: FIXTURE, enabled: false, usable: false, allowedByPlan: true, missing: [] }),
    ]);
    await http().post(`/v1/extensions/${FIXTURE_WITHDRAWN}/enable`).set(bearer(t.access)).expect(404);
    await http().post('/v1/extensions/no_such_thing/enable').set(bearer(t.access)).expect(404);
    await http().post('/v1/extensions/Not-A-Code/enable').set(bearer(t.access)).expect(400);
  });

  it('the plan decides: refused on Starter, allowed on Growth; switching on adds the extension’s role and codes, audits and emits an event', async () => {
    const t = await signup(app, 'ext-plan');
    await plan(t, 'starter');
    const refused = await enable(t, FIXTURE).expect(403);
    expect([refused.body.error.code, refused.body.error.details]).toEqual(['ENTITLEMENT_REQUIRED', { extension: FIXTURE, plan: 'starter' }]);
    await plan(t, 'growth');
    const runs = fixtureState.enabledHookRuns;
    const on = await enable(t, FIXTURE).expect(200);
    expect(on.body).toMatchObject({ code: FIXTURE, enabled: true, usable: true });
    expect(fixtureState.enabledHookRuns).toBe(runs + 1);
    expect((await me(t)).extensions).toEqual([FIXTURE]);
    expect(await sql(t, `SELECT r.key, array_agg(rp.permission_code ORDER BY rp.permission_code) AS codes FROM roles r
                           JOIN role_permissions rp ON rp.role_id = r.id WHERE r.key = 'fixture_clerk' GROUP BY r.key`)).toEqual([
      { key: 'fixture_clerk', codes: ['catalog.read', FIXTURE_PERMISSION] },
    ]);
    expect(await sql(t, `SELECT r.key FROM roles r JOIN role_permissions rp ON rp.role_id = r.id WHERE rp.permission_code = $1 ORDER BY 1`, [FIXTURE_PERMISSION]))
      .toEqual([{ key: 'admin' }, { key: 'fixture_clerk' }, { key: 'owner' }]);
    expect(await sql(t, `SELECT action, metadata->>'extension' AS extension FROM audit_logs WHERE action LIKE 'tenant.extension_%'`)).toEqual([
      { action: 'tenant.extension_enabled', extension: FIXTURE },
    ]);
    expect(await sql(t, `SELECT topic, payload FROM outbox_events WHERE topic LIKE 'extension.%'`)).toEqual([{ topic: 'extension.enabled', payload: { extension: FIXTURE } }]);
    // Again: nothing changes, nothing more is written.
    await enable(t, FIXTURE).expect(200);
    expect(await sql(t, `SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'tenant.extension_%'`)).toEqual([{ n: 1 }]);
    expect(await sql(t, `SELECT count(*)::int AS n FROM roles WHERE key = 'fixture_clerk'`)).toEqual([{ n: 1 }]);
  });

  it('a replay with the same Idempotency-Key answers the first result', async () => {
    const t = await signup(app, 'ext-idem');
    const key = randomUUID();
    const first = await enable(t, FIXTURE, key).expect(200);
    const again = await enable(t, FIXTURE, key).expect(200);
    expect(again.body).toEqual(first.body);
  });

  it('only tenant.manage may list or switch; a cashier is refused', async () => {
    const t = await signup(app, 'ext-perm');
    const c = await addMember(owner, t.tenantId, 'cashier');
    const cashier = bearer(await loginToken(app, c.email));
    await http().get('/v1/extensions').set(cashier).expect(403);
    await http().post(`/v1/extensions/${FIXTURE}/enable`).set(cashier).expect(403);
    expect((await http().get('/v1/me').set(cashier).expect(200)).body.activeTenant.extensions).toEqual([]);
  });
});

describe('gating the extension’s routes', () => {
  it('writes are refused while it is off or not on the plan; reads stay open', async () => {
    const t = await signup(app, 'ext-gate');
    const auth = bearer(t.access);
    const off = await http().post('/v1/test-fixture').set(auth).expect(403);
    expect([off.body.error.code, off.body.error.details]).toEqual(['EXTENSION_NOT_ENABLED', { extension: FIXTURE }]);
    await http().get('/v1/test-fixture').set(auth).expect(200);
    await enable(t, FIXTURE).expect(200);
    await http().post('/v1/test-fixture').set(auth).expect(200);
    // A downgrade to a plan without it: still on, no longer usable.
    await plan(t, 'starter');
    expect((await me(t)).extensions).toEqual([]);
    expect((await catalog(t)).find((e) => e.code === FIXTURE)).toMatchObject({ enabled: true, usable: false, allowedByPlan: false });
    await http().post('/v1/test-fixture').set(auth).expect(403);
    await http().get('/v1/test-fixture').set(auth).expect(200);
    await plan(t, 'growth');
    await http().post('/v1/test-fixture').set(auth).expect(200);
  });

  it('an extension withdrawn from the catalog stops being usable where it is on, and can still be switched off', async () => {
    const t = await signup(app, 'ext-gone');
    const member = (await me(t)).membershipId as string;
    await sql(t, `INSERT INTO tenant_extensions (tenant_id, extension_code, enabled, changed_by) VALUES ($1, $2, true, $3)`, [t.tenantId, FIXTURE_WITHDRAWN, member]);
    expect((await me(t)).extensions).toEqual([]);
    expect((await catalog(t)).map((e) => [e.code, e.enabled, e.usable])).toContainEqual([FIXTURE_WITHDRAWN, true, false]);
    await disable(t, FIXTURE_WITHDRAWN).expect(200);
    expect((await catalog(t)).map((e) => e.code)).not.toContain(FIXTURE_WITHDRAWN);
  });

  it('one business’s extensions never show in another’s', async () => {
    const [x, y] = [await signup(app, 'ext-x'), await signup(app, 'ext-y')];
    await enable(x, FIXTURE).expect(200);
    expect((await me(y)).extensions).toEqual([]);
    await http().post('/v1/test-fixture').set(bearer(y.access)).expect(403);
    expect(await sql(y, 'SELECT count(*)::int AS n FROM tenant_extensions')).toEqual([{ n: 0 }]);
  });
});

describe('requirements and switching off', () => {
  it('an add-on needs its base on first, and holds the base on while it is on', async () => {
    const t = await signup(app, 'ext-req');
    const needs = await enable(t, FIXTURE_ADDON).expect(409);
    expect([needs.body.error.code, needs.body.error.details]).toEqual(['EXTENSION_REQUIRES', { extension: FIXTURE_ADDON, missing: [FIXTURE] }]);
    await enable(t, FIXTURE).expect(200);
    await enable(t, FIXTURE_ADDON).expect(200);
    expect((await me(t)).extensions).toEqual([FIXTURE_ADDON, FIXTURE]);
    const held = await disable(t, FIXTURE).expect(409);
    expect([held.body.error.code, held.body.error.details]).toEqual(['EXTENSION_REQUIRED_BY', { extension: FIXTURE, dependents: [FIXTURE_ADDON] }]);
    await disable(t, FIXTURE_ADDON).expect(200);
    await disable(t, FIXTURE).expect(200);
    expect((await me(t)).extensions).toEqual([]);
  });

  it('open records block switching off; switching off keeps roles and grants, and switching on again restores the extension', async () => {
    const t = await signup(app, 'ext-off');
    await enable(t, FIXTURE).expect(200);
    fixtureState.openRecords = 2;
    try {
      const blocked = await disable(t, FIXTURE).expect(409);
      expect([blocked.body.error.code, blocked.body.error.details]).toEqual(['EXTENSION_IN_USE', { extension: FIXTURE, blockers: [{ code: 'OPEN_FIXTURE_RECORDS', count: 2 }] }]);
    } finally {
      fixtureState.openRecords = 0;
    }
    const off = await disable(t, FIXTURE).expect(200);
    expect(off.body).toMatchObject({ enabled: false, usable: false });
    await disable(t, FIXTURE).expect(200);
    expect(await sql(t, `SELECT count(*)::int AS n FROM roles WHERE key = 'fixture_clerk'`)).toEqual([{ n: 1 }]);
    expect(await sql(t, `SELECT action FROM audit_logs WHERE action LIKE 'tenant.extension_%' ORDER BY occurred_at, id`)).toEqual([
      { action: 'tenant.extension_enabled' }, { action: 'tenant.extension_disabled' },
    ]);
    await enable(t, FIXTURE).expect(200);
    expect(await sql(t, 'SELECT enabled FROM tenant_extensions')).toEqual([{ enabled: true }]);
    // The state row is never deleted, even by the schema owner.
    await expect(sql(t, 'DELETE FROM tenant_extensions')).rejects.toThrow();
  });

  it('the runtime role cannot switch extensions behind the API: no deleting, no writing another tenant’s row, no catalog writes', async () => {
    const t = await signup(app, 'ext-db');
    const runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(runtime.query(`INSERT INTO extensions (code, name, description) VALUES ('evil', 'x', 'x')`)).rejects.toThrow(/permission denied/);
      await expect(runtime.query(`UPDATE plans SET extensions = '["${FIXTURE}"]'`)).rejects.toThrow(/permission denied/);
      const c = await runtime.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [randomUUID()]);
        await expect(c.query(`INSERT INTO tenant_extensions (tenant_id, extension_code, enabled, changed_by) VALUES ($1, $2, true, $3)`, [t.tenantId, FIXTURE, randomUUID()])).rejects.toThrow();
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    } finally {
      await runtime.end();
    }
  });
});

describe('the till', () => {
  it('the snapshot carries the usable extensions, and switching one bumps the catalog version', async () => {
    const t = await signup(app, 'ext-till');
    const auth = bearer(t.access);
    const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Ext Corp', vatStatus: 'VAT' }).expect(201);
    const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
    const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'R1' }).expect(201)).body.id as string;
    const reg = (await http().post('/v1/terminals').set(auth).send({ registerId, name: 'Till' }).expect(201)).body;
    const headers = { 'x-terminal-id': reg.terminal.id, Authorization: `Terminal ${reg.credential}` };
    const snapshot = async () => (await http().get('/v1/terminal/snapshot').set(headers).expect(200)).body as Snapshot;
    const before = await snapshot();
    expect(before.extensions).toEqual([]);
    await enable(t, FIXTURE).expect(200);
    const version = (await http().get('/v1/terminal/catalog-version').set(headers).expect(200)).body.version as number;
    expect(version).toBeGreaterThan(before.catalogVersion!);
    expect((await snapshot()).extensions).toEqual([FIXTURE]);
  });
});
