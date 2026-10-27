import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, type SignedUp } from './helpers.js';

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

interface OrgFixture {
  tenant: SignedUp;
  entityId: string;
  branchId: string;
  registerId: string;
}

async function buildOrg(prefix: string): Promise<OrgFixture> {
  const tenant = await signup(app, prefix);
  const auth = bearer(tenant.access);
  const le = await http()
    .post('/v1/legal-entities')
    .set(auth)
    .send({ registeredName: `${prefix} Trading Corp`, tin: '123-456-789', vatStatus: 'VAT' })
    .expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'mkt-01', name: 'Makati' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  return { tenant, entityId: le.body.id, branchId: br.body.id, registerId: reg.body.id };
}

describe('organization setup by the owner', () => {
  it('creates legal entity → branch → register with normalised codes and safe defaults', async () => {
    const o = await buildOrg('setup');
    const le = (await http().get('/v1/legal-entities').set(bearer(o.tenant.access)).expect(200)).body.data[0];
    expect(le.tin).toBe('123456789');
    expect(le.invoicingMode).toBe('DISABLED');
    expect(le.priceDisplay).toBe('TAX_INCLUSIVE');
    const br = (await http().get('/v1/branches').set(bearer(o.tenant.access)).expect(200)).body.data[0];
    expect(br.code).toBe('MKT-01');
    expect(br.birBranchCode).toBe('00000');
    expect(br.timezone).toBe('Asia/Manila');
  });

  it('rejects duplicate codes/TINs with specific conflict codes', async () => {
    const o = await buildOrg('dups');
    const auth = bearer(o.tenant.access);
    const dupBranch = await http().post('/v1/branches').set(auth).send({ legalEntityId: o.entityId, code: 'MKT-01', name: 'X', birBranchCode: '00001' }).expect(409);
    expect(dupBranch.body.error.code).toBe('CODE_TAKEN');
    const dupBir = await http().post('/v1/branches').set(auth).send({ legalEntityId: o.entityId, code: 'QC', name: 'QC' }).expect(409);
    expect(dupBir.body.error.code).toBe('BIR_BRANCH_CODE_TAKEN');
    const dupTin = await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Y', tin: '123456789', vatStatus: 'NON_VAT' }).expect(409);
    expect(dupTin.body.error.code).toBe('TIN_TAKEN');
  });

  it('refuses any production invoicing mode (compliance gate)', async () => {
    const o = await buildOrg('gate');
    const res = await http()
      .patch(`/v1/legal-entities/${o.entityId}`)
      .set(bearer(o.tenant.access))
      .send({ invoicingMode: 'PRODUCTION' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('validates TIN, timezone and ids', async () => {
    const o = await buildOrg('valid');
    const auth = bearer(o.tenant.access);
    await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Z', tin: '123-456-789-00000', vatStatus: 'VAT' }).expect(400);
    await http().post('/v1/branches').set(auth).send({ legalEntityId: o.entityId, code: 'TZ', name: 'TZ', timezone: 'Mars/Olympus' }).expect(400);
    await http().patch('/v1/branches/not-a-uuid').set(auth).send({ name: 'x' }).expect(400);
  });
});

describe('terminals', () => {
  it('returns the credential once, never exposes its hash, and revocation is final', async () => {
    const o = await buildOrg('term');
    const auth = bearer(o.tenant.access);
    const reg = await http().post('/v1/terminals').set(auth).send({ registerId: o.registerId, name: 'iPad 1' }).expect(201);
    expect(reg.body.credential).toMatch(/^tpk_[A-Za-z0-9_-]{43}$/);
    expect(reg.body.terminal.credentialHint).toBe(reg.body.credential.slice(-4));
    expect(reg.body.terminal).not.toHaveProperty('credentialHash');

    const list = await http().get('/v1/terminals').set(auth).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(reg.body.credential);

    // Runtime DB role cannot read credential hashes at all.
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(appPool.query('SELECT credential_hash FROM terminals')).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }

    const revoked = await http()
      .post(`/v1/terminals/${reg.body.terminal.id}/revoke`)
      .set(auth)
      .send({ reason: 'Device stolen' })
      .expect(200);
    expect(revoked.body.status).toBe('REVOKED');
    await expect(
      asOwnerInTenant(owner, o.tenant.tenantId, (c) =>
        c.query(`UPDATE terminals SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1`, [reg.body.terminal.id]),
      ),
    ).rejects.toThrow(/cannot be reactivated/);
  });

  it('enforces archive order: terminals and open shift → registers → branches → legal entities', async () => {
    const o = await buildOrg('archive');
    const auth = bearer(o.tenant.access);
    const t = await http().post('/v1/terminals').set(auth).send({ registerId: o.registerId, name: 'T' }).expect(201);
    expect((await http().post(`/v1/branches/${o.branchId}/archive`).set(auth).expect(409)).body.error.code).toBe('HAS_ACTIVE_CHILDREN');
    expect((await http().post(`/v1/registers/${o.registerId}/archive`).set(auth).expect(409)).body.error.code).toBe('HAS_ACTIVE_CHILDREN');
    await http().post(`/v1/terminals/${t.body.terminal.id}/revoke`).set(auth).send({ reason: 'Retired' }).expect(200);
    // An open drawer keeps the register until its shift is closed.
    const shift = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: o.registerId, openingFloat: '0.00' }).expect(201)).body.id as string;
    expect((await http().post(`/v1/registers/${o.registerId}/archive`).set(auth).expect(409)).body.error.code).toBe('SHIFT_OPEN');
    await http().post(`/v1/cashier-sessions/${shift}/close`).set(auth).send({ countedCash: '0.00' }).expect(200);
    await http().post(`/v1/registers/${o.registerId}/archive`).set(auth).expect(200);
    const late = await http().post('/v1/terminals').set(auth).send({ registerId: o.registerId, name: 'T2' }).expect(409);
    expect(late.body.error.code).toBe('ARCHIVED');
    await http().post(`/v1/branches/${o.branchId}/archive`).set(auth).expect(200);
    await http().post(`/v1/legal-entities/${o.entityId}/archive`).set(auth).expect(200);
  });
});

describe('scoped administration', () => {
  let o: OrgFixture;
  let otherBranchId: string;
  let scopedToken: string;

  beforeAll(async () => {
    o = await buildOrg('scoped');
    const other = await http()
      .post('/v1/branches')
      .set(bearer(o.tenant.access))
      .send({ legalEntityId: o.entityId, code: 'CEBU', name: 'Cebu', birBranchCode: '00002' })
      .expect(201);
    otherBranchId = other.body.id;
    const admin = await addMember(owner, o.tenant.tenantId, 'admin', { type: 'BRANCH', id: o.branchId });
    scopedToken = await loginToken(app, admin.email);
  });

  it('sees only its own branch', async () => {
    const res = await http().get('/v1/branches').set(bearer(scopedToken)).expect(200);
    expect(res.body.data.map((b: { id: string }) => b.id)).toEqual([o.branchId]);
    const les = await http().get('/v1/legal-entities').set(bearer(scopedToken)).expect(200);
    expect(les.body.data).toEqual([]);
  });

  it('manages its own branch but not a sibling branch or the legal entity', async () => {
    await http().patch(`/v1/branches/${o.branchId}`).set(bearer(scopedToken)).send({ name: 'Makati Main' }).expect(200);
    await http().post('/v1/registers').set(bearer(scopedToken)).send({ branchId: o.branchId, code: 'R2', name: 'Counter 2' }).expect(201);
    await http().patch(`/v1/branches/${otherBranchId}`).set(bearer(scopedToken)).send({ name: 'hijack' }).expect(403);
    await http().post('/v1/registers').set(bearer(scopedToken)).send({ branchId: otherBranchId, code: 'R9', name: 'X' }).expect(403);
    await http().post('/v1/branches').set(bearer(scopedToken)).send({ legalEntityId: o.entityId, code: 'NEW', name: 'N', birBranchCode: '00009' }).expect(403);
    await http().post('/v1/legal-entities').set(bearer(scopedToken)).send({ registeredName: 'X', vatStatus: 'VAT' }).expect(403);
  });

  it('cannot reference a non-existent or foreign org node in a role scope (DB trigger)', async () => {
    const foreign = await buildOrg('foreign-scope');
    await expect(addMember(owner, o.tenant.tenantId, 'cashier', { type: 'BRANCH', id: foreign.branchId })).rejects.toThrow(/does not exist/);
    await expect(addMember(owner, o.tenant.tenantId, 'cashier', { type: 'REGISTER', id: o.branchId })).rejects.toThrow(/does not exist/);
  });

  it('a role with terminals.manage alone sees the registers of its branch and can pair a till there', async () => {
    await http()
      .post('/v1/roles')
      .set(bearer(o.tenant.access))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ key: 'till_setup', name: 'Till set-up', permissions: ['terminals.manage'] })
      .expect(201);
    await http().post('/v1/registers').set(bearer(o.tenant.access)).send({ branchId: otherBranchId, code: 'C1', name: 'Cebu 1' }).expect(201);
    const setup = await addMember(owner, o.tenant.tenantId, 'till_setup', { type: 'BRANCH', id: o.branchId });
    const token = await loginToken(app, setup.email);
    const regs = await http().get('/v1/registers').set(bearer(token)).expect(200);
    const branchIds = new Set(regs.body.data.map((r: { branchId: string }) => r.branchId));
    expect(regs.body.data.map((r: { id: string }) => r.id)).toContain(o.registerId);
    expect([...branchIds]).toEqual([o.branchId]);
    await http().post('/v1/terminals').set(bearer(token)).send({ registerId: o.registerId, name: 'Till A' }).expect(201);
  });

  it('report, drawer and books readers see the branches, registers and entity they work on, no others', async () => {
    const role = (key: string, permissions: string[]) =>
      http().post('/v1/roles').set(bearer(o.tenant.access)).set('Idempotency-Key', crypto.randomUUID()).send({ key, name: key, permissions }).expect(201);
    await role('report_reader', ['reports.read']);
    await role('drawer_checker', ['cash.reconcile']);
    await role('bookkeeper', ['accounting.read']);
    const as = async (key: string, scope: { type: 'BRANCH' | 'LEGAL_ENTITY'; id: string }) => bearer(await loginToken(app, (await addMember(owner, o.tenant.tenantId, key, scope)).email));
    const ids = (body: { data: { id: string }[] }) => body.data.map((x) => x.id);
    for (const key of ['report_reader', 'drawer_checker']) {
      const who = await as(key, { type: 'BRANCH', id: o.branchId });
      expect(ids((await http().get('/v1/branches').set(who).expect(200)).body)).toEqual([o.branchId]);
      const regs = (await http().get('/v1/registers').set(who).expect(200)).body.data as { id: string; branchId: string }[];
      expect(regs.map((r) => r.id)).toContain(o.registerId);
      expect(new Set(regs.map((r) => r.branchId))).toEqual(new Set([o.branchId]));
      expect((await http().get('/v1/legal-entities').set(who).expect(200)).body.data).toEqual([]);
    }
    const books = await as('bookkeeper', { type: 'LEGAL_ENTITY', id: o.entityId });
    expect(ids((await http().get('/v1/legal-entities').set(books).expect(200)).body)).toEqual([o.entityId]);
    expect(ids((await http().get('/v1/branches').set(books).expect(200)).body).sort()).toEqual([o.branchId, otherBranchId].sort());
    // Reading only: none of them may change the organisation.
    await http().patch(`/v1/branches/${o.branchId}`).set(books).send({ name: 'x' }).expect(403);
  });
});

describe('cross-tenant isolation (org)', () => {
  let a: OrgFixture;
  let b: OrgFixture;
  let aTerminalId: string;

  beforeAll(async () => {
    a = await buildOrg('iso-a');
    b = await buildOrg('iso-b');
    const t = await http().post('/v1/terminals').set(bearer(a.tenant.access)).send({ registerId: a.registerId, name: 'A1' }).expect(201);
    aTerminalId = t.body.terminal.id;
  });

  it('lists never include the other tenant', async () => {
    for (const path of ['/v1/legal-entities', '/v1/branches', '/v1/registers', '/v1/terminals']) {
      const res = await http().get(path).set(bearer(b.tenant.access)).expect(200);
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(a.entityId);
      expect(ids).not.toContain(a.branchId);
      expect(ids).not.toContain(a.registerId);
      expect(ids).not.toContain(aTerminalId);
    }
  });

  it("cannot modify or attach to the other tenant's records (404, no existence oracle)", async () => {
    const auth = bearer(b.tenant.access);
    const attempts = [
      http().patch(`/v1/legal-entities/${a.entityId}`).set(auth).send({ registeredName: 'pwned' }),
      http().post(`/v1/legal-entities/${a.entityId}/archive`).set(auth),
      http().patch(`/v1/branches/${a.branchId}`).set(auth).send({ name: 'pwned' }),
      http().post('/v1/branches').set(auth).send({ legalEntityId: a.entityId, code: 'HACK', name: 'x', birBranchCode: '00007' }),
      http().post('/v1/registers').set(auth).send({ branchId: a.branchId, code: 'HACK', name: 'x' }),
      http().post('/v1/terminals').set(auth).send({ registerId: a.registerId, name: 'x' }),
      http().post(`/v1/terminals/${aTerminalId}/revoke`).set(auth).send({ reason: 'sabotage' }),
      http().post(`/v1/registers/${a.registerId}/archive`).set(auth),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const still = await http().get('/v1/terminals').set(bearer(a.tenant.access)).expect(200);
    expect(still.body.data[0].status).toBe('ACTIVE');
  });

  it('a cashier cannot manage org or terminals', async () => {
    const cashier = await addMember(owner, a.tenant.tenantId, 'cashier');
    const token = await loginToken(app, cashier.email);
    await http().post('/v1/registers').set(bearer(token)).send({ branchId: a.branchId, code: 'C9', name: 'x' }).expect(403);
    await http().post('/v1/terminals').set(bearer(token)).send({ registerId: a.registerId, name: 'x' }).expect(403);
    expect((await http().get('/v1/terminals').set(bearer(token)).expect(200)).body.data).toEqual([]);
  });
});
