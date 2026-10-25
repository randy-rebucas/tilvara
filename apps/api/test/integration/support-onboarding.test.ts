import type { INestApplication } from '@nestjs/common';
import { DevFileStorage, EXPORT_EXCLUDED_TABLES, withTenant, writeDataExport } from '@1pos/database';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordService } from '../../src/auth/password.service.js';
import { base32Decode, hotp, stepAt } from '../../src/auth/totp.js';
import { ExportLinks } from '../../src/exports/export-links.js';
import { addMember, asOwnerInTenant, bearer, createApp, ownerPool, PASSWORD, signup, uniq, type SignedUp } from './helpers.js';

/**
 * ADR-0016 slice 6: support access a business gives (time-limited, read-only, audited on both
 * sides, revocable at once), the business's data export, and the trial's sample items.
 */
let app: INestApplication;
let owner: pg.Pool;
let workerPool: pg.Pool;
let storageDir: string;
const http = () => request(app.getHttpServer());
const code = (secret: Buffer, offset = 1) => hotp(secret, stepAt(Date.now() / 1000) + offset);

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'onepos-export-test-'));
  process.env.FILE_STORAGE_DIR = storageDir;
  app = await createApp();
  owner = ownerPool();
  workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 3 });
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await workerPool.end();
  await rm(storageDir, { recursive: true, force: true });
});

async function asPlatform<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE onepos_platform');
    const { rows } = await c.query<T>(sql, params);
    await c.query('COMMIT');
    return rows;
  } finally {
    c.release();
  }
}

interface Staff {
  userId: string;
  email: string;
  secret: Buffer;
  /** a session that passed two-step sign-in */
  token: string;
  /** a session that started before two-step sign-in was set up */
  unverifiedToken: string;
}

/** A Tilvara staff account: no business, two-step sign-in on, added by the ops function. */
async function makeStaff(): Promise<Staff> {
  const email = `${uniq('staff')}@1pos.example`;
  const hash = await new PasswordService().hash(PASSWORD);
  const { rows } = await owner.query<{ id: string }>('SELECT auth_register_user($1, $2, $3) AS id', [email, 'Sam Support', hash]);
  const userId = rows[0]!.id;
  const login = () => http().post('/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const unverifiedToken = (await login()).body.tokens.accessToken as string;
  const first = (await login()).body.tokens.accessToken as string;
  const started = await http().post('/v1/auth/mfa/enroll').set(bearer(first)).send({ password: PASSWORD }).expect(200);
  const secret = base32Decode(started.body.secret);
  await http().post('/v1/auth/mfa/confirm').set(bearer(first)).send({ code: code(secret, 0) }).expect(200);
  await owner.query('SELECT support_staff_add($1, $2, $3)', [email, 'ops-test', 'joined the support team']);
  const challenge = (await login()).body.challengeToken as string;
  const verified = await http().post('/v1/auth/mfa/verify').send({ challengeToken: challenge, code: code(secret, 1) }).expect(200);
  return { userId, email, secret, token: verified.body.tokens.accessToken, unverifiedToken };
}

async function tenantAudit(tenantId: string, action: string) {
  return asOwnerInTenant(owner, tenantId, async (c) =>
    (await c.query<{ actor_type: string; actor_user_id: string | null; resource_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_type, actor_user_id, resource_id, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at, id`,
      [action],
    )).rows,
  );
}

async function setSubscription(tenantId: string, status: string) {
  await owner.query('SELECT platform_set_subscription($1, $2, $3, $4, $5)', [tenantId, 'growth', status, null, null]);
}

describe('support access (ADR-0016 slice 6)', () => {
  let a: SignedUp;
  let b: SignedUp;
  let staff: Staff;
  let grantId: string;
  let supportToken: string;
  let bProductId: string;

  beforeAll(async () => {
    a = await signup(app, 'sup-a');
    b = await signup(app, 'sup-b');
    staff = await makeStaff();
    const taxes = (await http().get('/v1/tax-categories').set(bearer(b.access))).body.data as { id: string; code: string }[];
    const uoms = (await http().get('/v1/uoms').set(bearer(b.access))).body.data as { id: string; code: string }[];
    bProductId = (await http().post('/v1/products').set(bearer(b.access)).send({
      name: 'B only', taxCategoryId: taxes.find((t) => t.code === 'VAT')!.id, uomId: uoms.find((u) => u.code === 'PC')!.id, variants: [{ sku: uniq('B') }],
    }).expect(201)).body.id;
  });

  it('only someone who manages the business gives access, for a stated purpose and at most 72 hours', async () => {
    const cashier = await addMember(owner, a.tenantId, 'cashier');
    const cashierToken = (await http().post('/v1/auth/login').send({ email: cashier.email, password: PASSWORD }).expect(200)).body.tokens.accessToken;
    await http().post('/v1/support-access').set(bearer(cashierToken)).send({ purpose: 'Look at my report', hours: 4 }).expect(403);
    await http().post('/v1/support-access').set(bearer(a.access)).send({ purpose: 'x', hours: 4 }).expect(400);
    await http().post('/v1/support-access').set(bearer(a.access)).send({ purpose: 'Look at my report', hours: 73 }).expect(400);
    const res = await http().post('/v1/support-access').set(bearer(a.access)).send({ purpose: 'Sales report looks wrong', hours: 4, ticketRef: 'T-1001' }).expect(201);
    grantId = res.body.id;
    expect([res.body.status, res.body.access, res.body.ticketRef]).toEqual(['OPEN', 'READ_ONLY', 'T-1001']);
    const hours = (new Date(res.body.expiresAt).getTime() - new Date(res.body.grantedAt).getTime()) / 3_600_000;
    expect(hours).toBe(4);
    // The database holds the window too: 72 hours at most, whoever writes.
    await expect(asOwnerInTenant(owner, a.tenantId, (c) =>
      c.query(`INSERT INTO support_grants (tenant_id, purpose, granted_by, expires_at) VALUES ($1, 'Too long a window', $2, now() + interval '73 hours')`, [a.tenantId, a.userId]),
    )).rejects.toMatchObject({ constraint: 'support_grants_window' });
    expect((await tenantAudit(a.tenantId, 'support.granted')).map((r) => r.resource_id)).toEqual([grantId]);
  });

  it('staff are added only with ops credentials, and only with two-step sign-in on', async () => {
    const runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(runtime.query('SELECT support_staff_add($1, $2, $3)', [a.email, 'me', 'let me in please'])).rejects.toThrow(/permission denied/);
      await expect(runtime.query('SELECT * FROM platform_staff')).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
    }
    await expect(owner.query('SELECT support_staff_add($1, $2, $3)', [a.email, 'ops-test', 'owner without MFA'])).rejects.toThrow(/two-step sign-in/);
    const platform = await asPlatform<{ action: string }>(`SELECT action FROM audit_logs WHERE tenant_id IS NULL AND resource_id = $1`, [staff.userId]);
    expect(platform.map((r) => r.action)).toContain('platform.staff.added');
  });

  it('a non-staff account sees nothing and cannot open a grant; staff need a session that passed two-step sign-in', async () => {
    await http().get('/v1/support/grants').set(bearer(b.access)).expect(403);
    const notStaff = await http().post(`/v1/support/grants/${grantId}/open`).set(bearer(b.access)).expect(404);
    expect(notStaff.body.error.code).toBe('NOT_FOUND');
    const unverified = await http().get('/v1/support/grants').set(bearer(staff.unverifiedToken)).expect(403);
    expect(unverified.body.error.code).toBe('MFA_REQUIRED');
    await http().post(`/v1/support/grants/${grantId}/open`).set(bearer(staff.unverifiedToken)).expect(403);
  });

  it('staff open the grant and read the business, read-only, and only that business', async () => {
    const list = (await http().get('/v1/support/grants').set(bearer(staff.token)).expect(200)).body.data as { id: string; tenant: { id: string }; purpose: string }[];
    expect(list.find((g) => g.id === grantId)).toMatchObject({ tenant: { id: a.tenantId }, purpose: 'Sales report looks wrong' });
    expect(list.some((g) => g.tenant.id === b.tenantId)).toBe(false);

    const opened = await http().post(`/v1/support/grants/${grantId}/open`).set(bearer(staff.token)).expect(200);
    supportToken = opened.body.accessToken;
    expect(opened.body.tenant).toEqual({ id: a.tenantId, name: expect.stringContaining('Biz') });
    expect(new Date(opened.body.accessTokenExpiresAt).getTime()).toBeLessThanOrEqual(new Date(opened.body.grant.expiresAt).getTime());

    const me = (await http().get('/v1/me').set(bearer(supportToken)).expect(200)).body;
    expect(me.activeTenant).toMatchObject({ tenantId: a.tenantId, membershipId: null });
    expect(me.activeTenant.permissions.every((p: string) => p.endsWith('.read'))).toBe(true);
    expect(me.support).toMatchObject({ grantId, tenantName: expect.stringContaining('Biz') });
    expect(me.staff).toBe(true);

    const products = (await http().get('/v1/products').set(bearer(supportToken)).expect(200)).body.data as { id: string }[];
    expect(products.some((p) => p.id === bProductId)).toBe(false);
    await http().get(`/v1/products/${bProductId}`).set(bearer(supportToken)).expect(404);
    await http().get('/v1/audit-logs').set(bearer(supportToken)).expect(200);
    // Service notes may hold health details: never shown to support, whatever customers.read says (decision A1).
    const customer = (await http().post('/v1/customers').set(bearer(a.access)).send({ displayName: 'Liza' }).expect(201)).body.id as string;
    await http().get(`/v1/customers/${customer}`).set(bearer(supportToken)).expect(200);
    const notes = (await http().get(`/v1/customers/${customer}/notes`).set(bearer(supportToken)).expect(403)).body.error;
    expect([notes.code, notes.details.session]).toEqual(['SERVICE_NOTES_RESTRICTED', 'SUPPORT']);
    await http().get(`/v1/customers/${customer}/notes`).set(bearer(a.access)).expect(200);

    // Every write is refused, even ones its read permissions would never reach.
    const write = await http().post('/v1/categories').set(bearer(supportToken)).send({ name: 'Support was here' }).expect(403);
    expect(write.body.error.code).toBe('SUPPORT_READ_ONLY');
    const cats = (await http().get('/v1/categories').set(bearer(a.access)).expect(200)).body.data as { name: string }[];
    expect(cats.some((c) => c.name === 'Support was here')).toBe(false);
    await http().post('/v1/support-access').set(bearer(supportToken)).send({ purpose: 'Extend my own access', hours: 72 }).expect(403);
    await http().post('/v1/data-exports').set(bearer(supportToken)).expect(403);
    // Management reads stay closed: support holds read permissions only.
    await http().get('/v1/support-access').set(bearer(supportToken)).expect(403);
    await http().get('/v1/subscription').set(bearer(supportToken)).expect(403);
    // A support token cannot be turned into a member's session.
    await http().post('/v1/auth/switch-tenant').set(bearer(supportToken)).send({ tenantId: a.tenantId }).expect(403);
  });

  it('the business sees who opened it, what was read and what was refused, in its own audit log', async () => {
    const opened = await tenantAudit(a.tenantId, 'support.session_opened');
    expect(opened).toEqual([expect.objectContaining({ actor_type: 'SUPPORT', actor_user_id: staff.userId, resource_id: grantId, metadata: expect.objectContaining({ staffName: 'Sam Support', staffEmail: staff.email }) })]);
    const reads = await tenantAudit(a.tenantId, 'support.request');
    expect(reads.map((r) => r.metadata.route)).toEqual(expect.arrayContaining(['/v1/me', '/v1/products', '/v1/products/:id', '/v1/audit-logs']));
    // Route templates only: never an id or a query string.
    expect(JSON.stringify(reads)).not.toContain(bProductId);
    // Reopening a page within the window adds no rows (two reads of /v1/products/:id above, one row);
    // every refused write is still its own row.
    expect(reads.filter((r) => r.metadata.route === '/v1/products/:id')).toHaveLength(1);
    await http().get('/v1/products').set(bearer(supportToken)).expect(200);
    await http().get('/v1/products').set(bearer(supportToken)).expect(200);
    expect((await tenantAudit(a.tenantId, 'support.request')).filter((r) => r.metadata.route === '/v1/products')).toHaveLength(1);
    await http().post('/v1/categories').set(bearer(supportToken)).send({ name: 'Again' }).expect(403);
    expect((await tenantAudit(a.tenantId, 'support.write_refused')).filter((r) => r.metadata.route === '/v1/categories')).toHaveLength(2);
    const refused = await tenantAudit(a.tenantId, 'support.write_refused');
    expect(refused.map((r) => `${r.metadata.method} ${r.metadata.route}`)).toEqual(
      expect.arrayContaining(['POST /v1/categories', 'POST /v1/support-access', 'POST /v1/data-exports', 'POST /v1/auth/switch-tenant']),
    );
    const listed = (await http().get('/v1/support-access').set(bearer(a.access)).expect(200)).body.data as { id: string; activity: Record<string, unknown> }[];
    expect(listed.find((g) => g.id === grantId)?.activity).toMatchObject({ sessions: 1, refusedWrites: 5, staff: ['Sam Support'] });
    expect(listed.find((g) => g.id === grantId)!.activity.requests).toBe(8); // me, products, products/:id, audit-logs, customers/:id, customers/:id/notes, support-access, subscription
    // And at platform level, outside every business.
    const platform = await asPlatform<{ action: string }>(`SELECT action FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1`, [staff.userId]);
    expect(platform.map((r) => r.action)).toContain('platform.support.opened');
    // The other business sees none of it.
    expect(await tenantAudit(b.tenantId, 'support.request')).toEqual([]);
  });

  it('revoking ends access at the next request; an ended grant cannot be opened or ended again', async () => {
    const revoked = await http().post(`/v1/support-access/${grantId}/revoke`).set(bearer(a.access)).send({ reason: 'Fixed, thanks' }).expect(200);
    expect(revoked.body.status).toBe('REVOKED');
    const after = await http().get('/v1/products').set(bearer(supportToken)).expect(403);
    expect(after.body.error.code).toBe('SUPPORT_ACCESS_ENDED');
    const list = (await http().get('/v1/support/grants').set(bearer(staff.token)).expect(200)).body.data as { id: string }[];
    expect(list.some((g) => g.id === grantId)).toBe(false);
    await http().post(`/v1/support/grants/${grantId}/open`).set(bearer(staff.token)).expect(404);
    expect((await http().post(`/v1/support-access/${grantId}/revoke`).set(bearer(a.access)).send({}).expect(409)).body.error.code).toBe('SUPPORT_ACCESS_ENDED');
    // A grant's terms never change, whoever writes.
    await expect(asOwnerInTenant(owner, a.tenantId, (c) => c.query(`UPDATE support_grants SET revoked_at = NULL, revoked_by = NULL WHERE id = $1`, [grantId]))).rejects.toMatchObject({
      constraint: 'support_grants_transition',
    });
  });

  it('an expired grant is not offered and cannot be opened', async () => {
    const id = await asOwnerInTenant(owner, a.tenantId, async (c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO support_grants (tenant_id, purpose, granted_by, granted_at, expires_at)
         VALUES ($1, 'Yesterday''s question', $2, now() - interval '30 hours', now() - interval '6 hours') RETURNING id`,
        [a.tenantId, a.userId],
      )).rows[0]!.id,
    );
    const list = (await http().get('/v1/support/grants').set(bearer(staff.token)).expect(200)).body.data as { id: string }[];
    expect(list.some((g) => g.id === id)).toBe(false);
    await http().post(`/v1/support/grants/${id}/open`).set(bearer(staff.token)).expect(404);
    const listed = (await http().get('/v1/support-access').set(bearer(a.access)).expect(200)).body.data as { id: string; status: string }[];
    expect(listed.find((g) => g.id === id)?.status).toBe('EXPIRED');
  });

  it('disabling a staff account ends its open sessions too', async () => {
    const g = (await http().post('/v1/support-access').set(bearer(b.access)).send({ purpose: 'Printer setup help', hours: 1 }).expect(201)).body.id;
    const token = (await http().post(`/v1/support/grants/${g}/open`).set(bearer(staff.token)).expect(200)).body.accessToken;
    await http().get('/v1/products').set(bearer(token)).expect(200);
    await owner.query('SELECT support_staff_disable($1, $2, $3)', [staff.email, 'ops-test', 'left the team']);
    expect((await http().get('/v1/products').set(bearer(token)).expect(403)).body.error.code).toBe('SUPPORT_ACCESS_ENDED');
    await http().get('/v1/support/grants').set(bearer(staff.token)).expect(403);
    await owner.query('SELECT support_staff_add($1, $2, $3)', [staff.email, 'ops-test', 'back on the team']);
  });

  it('a suspended business can still give and end support access', async () => {
    const s = await signup(app, 'sup-susp');
    await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [s.tenantId]));
    await http().post('/v1/categories').set(bearer(s.access)).send({ name: 'x' }).expect(403);
    const g = (await http().post('/v1/support-access').set(bearer(s.access)).send({ purpose: 'Help me leave', hours: 2 }).expect(201)).body.id;
    await http().post(`/v1/support-access/${g}/revoke`).set(bearer(s.access)).send({}).expect(200);
  });
});

/** A spec-reading ZIP reader (the writer's unit test also checks it against bsdtar). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(buf.subarray(start, start + csize)));
    p += 46 + nameLen;
  }
  return out;
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('data export (ADR-0016 slice 6)', () => {
  let a: SignedUp;
  let b: SignedUp;
  let exportId: string;
  let zip: Map<string, Buffer>;
  const storage = () => new DevFileStorage(storageDir);

  /** What the worker does for `data_export.requested` (apps/workers/src/handlers.ts), as onepos_worker. */
  async function produce(tenantId: string, id: string) {
    await withTenant(workerPool, tenantId, async (_db, client) => {
      let rowCounts: Record<string, number> = {};
      const key = `exports/${tenantId}/${id}.zip`;
      const file = await storage().put(key, async (out) => {
        rowCounts = (await writeDataExport(client, out, { exportId: id, requestedBy: 'Owner' })).rowCounts;
      });
      await client.query(`SELECT data_export_finish($1, $2, $3, $4, $5, now() + interval '7 days')`, [id, key, file.sizeBytes, file.sha256, JSON.stringify(rowCounts)]);
    }, { isolation: 'REPEATABLE READ' });
  }

  beforeAll(async () => {
    a = await signup(app, 'exp-a');
    b = await signup(app, 'exp-b');
    for (const t of [a, b]) {
      const entity = (await http().post('/v1/legal-entities').set(bearer(t.access)).set('Idempotency-Key', randomUUID()).send({ registeredName: `${t.tenantId} Corp, "Inc"`, vatStatus: 'VAT' }).expect(201)).body;
      const branch = (await http().post('/v1/branches').set(bearer(t.access)).send({ legalEntityId: entity.id, code: 'B1', name: 'One' }).expect(201)).body;
      const register = (await http().post('/v1/registers').set(bearer(t.access)).send({ branchId: branch.id, code: 'R1', name: 'Counter' }).expect(201)).body;
      await http().post('/v1/terminals').set(bearer(t.access)).send({ registerId: register.id, name: 'Till' }).expect(201);
      await http().post('/v1/sample-data').set(bearer(t.access)).expect(201);
    }
  });

  it('only someone who manages the business asks; one at a time; the worker is told in the same transaction', async () => {
    const cashier = await addMember(owner, a.tenantId, 'cashier');
    const cashierToken = (await http().post('/v1/auth/login').send({ email: cashier.email, password: PASSWORD }).expect(200)).body.tokens.accessToken;
    await http().post('/v1/data-exports').set(bearer(cashierToken)).expect(403);
    const res = await http().post('/v1/data-exports').set(bearer(a.access)).expect(202);
    exportId = res.body.id;
    expect(res.body.status).toBe('REQUESTED');
    expect((await http().post('/v1/data-exports').set(bearer(a.access)).expect(409)).body.error.code).toBe('EXPORT_IN_PROGRESS');
    const events = await asOwnerInTenant(owner, a.tenantId, async (c) =>
      (await c.query<{ topic: string; payload: { exportId: string } }>(`SELECT topic, payload FROM outbox_events WHERE topic = 'data_export.requested'`)).rows,
    );
    expect(events).toEqual([{ topic: 'data_export.requested', payload: { exportId } }]);
    expect((await http().post(`/v1/data-exports/${exportId}/link`).set(bearer(a.access)).expect(409)).body.error.code).toBe('EXPORT_NOT_READY');
    // Only the worker's functions move an export on.
    const runtime = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await expect(runtime.query(`SELECT data_export_finish($1, 'x', 1, 'x', '{}', now())`, [exportId])).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
    }
  });

  it('the export is every record of the business from one snapshot, and nothing of any other', async () => {
    await produce(a.tenantId, exportId);
    const done = (await http().get(`/v1/data-exports/${exportId}`).set(bearer(a.access)).expect(200)).body;
    expect(done).toMatchObject({ status: 'READY', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const link = (await http().post(`/v1/data-exports/${exportId}/link`).set(bearer(a.access)).expect(200)).body;
    expect(link.url).toMatch(/^\/v1\/data-export-files\//);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(600_000 + 5_000);
    const file = await http().get(link.url).buffer(true).parse(binary).expect(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="tilvara-export-exp-a-[\w-]+-\d{4}-\d{2}-\d{2}\.zip"$/);
    const bytes = file.body as Buffer;
    expect([bytes.length, createHash('sha256').update(bytes).digest('hex')]).toEqual([done.sizeBytes, done.sha256]);
    zip = unzip(bytes);

    const { rows: tables } = await owner.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'
         AND NOT (table_name = ANY($1)) ORDER BY 1`,
      [Object.keys(EXPORT_EXCLUDED_TABLES)],
    );
    const names = [...zip.keys()];
    expect(names.slice(0, 3)).toEqual(['README.txt', 'manifest.json', 'members.csv']);
    expect(names.slice(3).sort()).toEqual(tables.map((t) => `tables/${t.table_name}.csv`));
    // Row counts equal the business's rows (the API's own audit rows after the snapshot excepted).
    const manifest = JSON.parse(zip.get('manifest.json')!.toString()) as { files: { name: string; table?: string; rows: number }[] };
    const counts = await asOwnerInTenant(owner, a.tenantId, async (c) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t.table_name] = Number((await c.query(`SELECT count(*) AS n FROM ${t.table_name}`)).rows[0].n);
      return out;
    });
    for (const f of manifest.files.filter((x) => x.table && x.table !== 'audit_logs' && x.table !== 'data_exports')) {
      expect([f.table, f.rows]).toEqual([f.table, counts[f.table!]]);
      const lines = zip.get(f.name)!.toString('utf8').split('\r\n').filter(Boolean);
      expect([f.table, lines.length - 1]).toEqual([f.table, f.rows]);
    }
    expect(manifest.files.find((f) => f.table === 'products')!.rows).toBe(8);

    // Nothing of business B anywhere in the archive.
    const everything = [...zip.values()].map((v) => v.toString('utf8')).join('\n');
    const bIds = await asOwnerInTenant(owner, b.tenantId, async (c) => (await c.query<{ id: string }>(`SELECT id::text FROM products UNION ALL SELECT id::text FROM branches UNION ALL SELECT id::text FROM terminals`)).rows.map((r) => r.id));
    expect(bIds.length).toBeGreaterThan(5);
    expect(bIds.filter((id) => everything.includes(id))).toEqual([]);
    expect(everything).not.toContain(b.tenantId);
    expect(everything).not.toContain(b.email);
    // No credential hashes.
    expect(zip.get('tables/terminals.csv')!.toString().split('\r\n')[0]).not.toContain('credential_hash');
    expect(zip.get('tables/member_invitations.csv')!.toString().split('\r\n')[0]).not.toContain('token_hash');
    expect(everything).not.toMatch(/argon2|password_hash/);
    // Values exact, quoted per RFC 4180, the owner listed with name and email.
    expect(zip.get('tables/product_prices.csv')!.toString()).toContain(',275.0000,');
    expect(zip.get('tables/legal_entities.csv')!.toString()).toContain(`"${a.tenantId} Corp, ""Inc"""`);
    expect(zip.get('members.csv')!.toString()).toContain(a.email);
    expect(zip.get('README.txt')!.toString()).toContain('Left out on purpose');
    expect((await tenantAudit(a.tenantId, 'data_export.downloaded')).map((r) => r.actor_user_id)).toEqual([a.userId]);
    expect((await tenantAudit(a.tenantId, 'data_export.ready')).map((r) => r.resource_id)).toEqual([exportId]);
  });

  it('a link that is forged, altered, expired or for another business opens nothing', async () => {
    const links = new ExportLinks(process.env.JWT_ACCESS_SECRET!);
    const forged = new ExportLinks('another secret of at least thirty-two characters').sign({ e: exportId, t: a.tenantId, u: a.userId, x: Math.floor(Date.now() / 1000) + 600 });
    const expired = links.sign({ e: exportId, t: a.tenantId, u: a.userId, x: Math.floor(Date.now() / 1000) - 1 });
    const crossed = links.sign({ e: exportId, t: b.tenantId, u: b.userId, x: Math.floor(Date.now() / 1000) + 600 });
    const good = links.sign({ e: exportId, t: a.tenantId, u: a.userId, x: Math.floor(Date.now() / 1000) + 600 });
    const [body, sig] = good.split('.');
    const altered = `${Buffer.from(JSON.stringify({ e: exportId, t: a.tenantId, u: b.userId, x: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.${sig}`;
    for (const token of [forged, expired, crossed, altered, `${body}.`, 'nonsense']) {
      const res = await http().get(`/v1/data-export-files/${token}`);
      expect([token.slice(0, 12), res.status, res.body.error?.code]).toEqual([token.slice(0, 12), 404, 'NOT_FOUND']);
    }
    await http().get(`/v1/data-export-files/${good}`).buffer(true).parse(binary).expect(200);
    await http().post(`/v1/data-exports/${exportId}/link`).set(bearer(b.access)).expect(404);
  });

  it('a business whose subscription lapsed can still take its records', async () => {
    await setSubscription(a.tenantId, 'CANCELED');
    expect((await http().post('/v1/categories').set(bearer(a.access)).send({ name: 'x' }).expect(402)).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    const again = (await http().post('/v1/data-exports').set(bearer(a.access)).expect(202)).body.id;
    await produce(a.tenantId, again);
    const link = (await http().post(`/v1/data-exports/${again}/link`).set(bearer(a.access)).expect(200)).body;
    await http().get(link.url).buffer(true).parse(binary).expect(200);
    await setSubscription(a.tenantId, 'TRIALING');
  });

  it('at most five a day', async () => {
    const t = await signup(app, 'exp-lim');
    await asOwnerInTenant(owner, t.tenantId, (c) =>
      c.query(`INSERT INTO data_exports (tenant_id, requested_by, status, completed_at, error)
               SELECT $1, $2, 'FAILED', now(), 'fixture' FROM generate_series(1, 5)`, [t.tenantId, t.userId]),
    );
    expect((await http().post('/v1/data-exports').set(bearer(t.access)).expect(429)).body.error.code).toBe('EXPORT_LIMIT');
  });

  it('an export past its date gives no link and no file', async () => {
    await asOwnerInTenant(owner, a.tenantId, async (c) => {
      await c.query('ALTER TABLE data_exports DISABLE TRIGGER data_exports_transition');
      try {
        await c.query(`UPDATE data_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exportId]);
      } finally {
        await c.query('ALTER TABLE data_exports ENABLE TRIGGER data_exports_transition');
      }
    });
    expect((await http().post(`/v1/data-exports/${exportId}/link`).set(bearer(a.access)).expect(410)).body.error.code).toBe('EXPORT_EXPIRED');
    const listed = (await http().get('/v1/data-exports').set(bearer(a.access)).expect(200)).body.data as { id: string; status: string }[];
    expect(listed.find((e) => e.id === exportId)?.status).toBe('EXPIRED');
  });
});

describe('sample items for a trial (ADR-0016 slice 6)', () => {
  it('load, sell, remove: labelled, priced, scannable, removed by archiving, history kept', async () => {
    const t = await signup(app, 'sample');
    const auth = bearer(t.access);
    expect((await http().get('/v1/sample-data').set(auth).expect(200)).body).toEqual({ loaded: 0, canLoad: true, reason: null, items: 8 });
    const cashier = await addMember(owner, t.tenantId, 'cashier');
    const cashierToken = (await http().post('/v1/auth/login').send({ email: cashier.email, password: PASSWORD }).expect(200)).body.tokens.accessToken;
    await http().post('/v1/sample-data').set(bearer(cashierToken)).expect(403);

    const loaded = (await http().post('/v1/sample-data').set(auth).expect(201)).body;
    expect(loaded.loaded).toBe(8);
    expect((await http().post('/v1/sample-data').set(auth).expect(409)).body.error.code).toBe('SAMPLE_DATA_LOADED');
    const products = (await http().get('/v1/products').set(auth).expect(200)).body.data as { name: string; isSample: boolean; trackInventory: boolean; variants: { sku: string; barcodes: string[] }[] }[];
    expect(products).toHaveLength(8);
    expect(products.every((p) => p.isSample && p.name.endsWith('(sample)') && !p.trackInventory)).toBe(true);
    expect(products[0]!.variants[0]).toMatchObject({ sku: 'SAMPLE-01', barcodes: ['2000000000015'] });

    // Ring one up on a real shift: it sells like any item.
    const entity = (await http().post('/v1/legal-entities').set(auth).set('Idempotency-Key', randomUUID()).send({ registeredName: 'Sample Corp', vatStatus: 'VAT' }).expect(201)).body;
    const branch = (await http().post('/v1/branches').set(auth).send({ legalEntityId: entity.id, code: 'B1', name: 'One' }).expect(201)).body;
    const register = (await http().post('/v1/registers').set(auth).send({ branchId: branch.id, code: 'R1', name: 'Counter' }).expect(201)).body;
    const found = (await http().get('/v1/catalog/lookup').query({ code: '2000000000015', branchId: branch.id }).set(auth).expect(200)).body;
    expect(found).toMatchObject({ sku: 'SAMPLE-01', price: { amount: '275.0000' } });
    const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: register.id, openingFloat: '0' }).expect(201)).body;
    const sale = (await http().post('/v1/sales').set(auth).set('Idempotency-Key', randomUUID()).send({
      cashierSessionId: session.id, clientTransactionId: randomUUID(), lines: [{ variantId: found.variantId, quantity: '1' }], tenders: [{ method: 'CASH', tendered: '300.00' }],
    }).expect(201)).body;

    const removed = (await http().post('/v1/sample-data/remove').set(auth).expect(200)).body;
    expect(removed.removed).toBe(8);
    expect((await http().get('/v1/products').set(auth).expect(200)).body.data).toEqual([]);
    expect((await http().get('/v1/catalog/lookup').query({ code: '2000000000015', branchId: branch.id }).set(auth)).status).toBe(404);
    // The sale keeps what was sold, and the codes are free for real products.
    const kept = (await http().get(`/v1/sales/${sale.id}`).set(auth).expect(200)).body;
    expect(kept.lines[0].name).toBe('Rice 5 kg (sample)');
    const taxes = (await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[];
    const uoms = (await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[];
    await http().post('/v1/products').set(auth).send({ name: 'Real rice', taxCategoryId: taxes.find((x) => x.code === 'VAT')!.id, uomId: uoms.find((u) => u.code === 'PC')!.id, variants: [{ sku: 'SAMPLE-01' }] }).expect(201);
    // After the first sale the set is not offered again.
    expect((await http().get('/v1/sample-data').set(auth).expect(200)).body).toMatchObject({ canLoad: false, reason: 'HAS_SALES' });
    expect((await http().post('/v1/sample-data').set(auth).expect(409)).body.error.code).toBe('HAS_SALES');
    expect((await tenantAudit(t.tenantId, 'sample_data.loaded')).length + (await tenantAudit(t.tenantId, 'sample_data.removed')).length).toBe(2);
  });

  it('a salon gets its own set, not the shop set (ADR-0022)', async () => {
    const t = await signup(app, 'sample-salon');
    const auth = bearer(t.access);
    await http().patch('/v1/business').set(auth).send({ businessType: 'SALON' }).expect(200);
    await http().post('/v1/sample-data').set(auth).expect(201);
    const names = ((await http().get('/v1/products').query({ limit: 50 }).set(auth).expect(200)).body.data as { name: string }[]).map((p) => p.name);
    expect(names).not.toContain('Rice 5 kg (sample)');
    expect(names.length).toBeGreaterThan(0);
  });

  it('is for trials only', async () => {
    const t = await signup(app, 'sample-paid');
    await setSubscription(t.tenantId, 'ACTIVE');
    expect((await http().post('/v1/sample-data').set(bearer(t.access)).expect(409)).body.error.code).toBe('NOT_TRIAL');
  });
});
