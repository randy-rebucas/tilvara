import { createTenant, DevFileStorage, sql, withTenant } from '@1pos/database';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandlers, DevWorkerMailer, expireDataExports, exportKey } from '../../src/handlers.js';
import { OutboxProcessor, type Logger } from '../../src/outbox-processor.js';

/** ADR-0016 slice 6: the worker makes a business's export, gives up cleanly, and deletes old files. */
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
const workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 5 });
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 2 });
const silent: Logger = { info: () => undefined, error: () => undefined };
let dir: string;
let storage: DevFileStorage;
let tenantId: string;

/** Ask for an export the way the API does: the row and its event in one transaction. */
async function request(t: string): Promise<string> {
  return withTenant(pool, t, async (db) => {
    const { rows } = await db.execute<{ id: string }>(sql`INSERT INTO data_exports (tenant_id, requested_by) VALUES (${t}, ${randomUUID()}) RETURNING id`);
    const id = rows[0]!.id;
    await db.execute(sql`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (${t}, 'data_export.requested', ${JSON.stringify({ exportId: id })}::jsonb)`);
    return id;
  });
}

const status = (t: string, id: string) =>
  withTenant(pool, t, async (db) => (await db.execute<{ status: string; error: string | null; file_key: string | null }>(sql`SELECT status, error, file_key FROM data_exports WHERE id = ${id}`)).rows[0]!);

/** Process only this tenant's export events: other suites' events are left alone. */
async function processExports(handlers: ReturnType<typeof buildHandlers>, retryDelay = 0) {
  const p = new OutboxProcessor({ pool: workerPool, workerId: `exp-${randomUUID().slice(0, 6)}`, handlers, batchSize: 500, retryDelaySeconds: () => retryDelay });
  return p.runOnce();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'onepos-worker-export-'));
  storage = new DevFileStorage(dir);
  tenantId = await createTenant(pool, { slug: `exp-${randomUUID().slice(0, 8)}`, name: 'Export Worker' });
});

afterAll(async () => {
  await pool.end();
  await workerPool.end();
  await owner.end();
  await rm(dir, { recursive: true, force: true });
});

describe('data export handler', () => {
  it('writes the file and marks the export READY; a repeat delivery changes nothing', async () => {
    const id = await request(tenantId);
    const handlers = buildHandlers(new DevWorkerMailer(silent), { storage, retentionDays: 7 });
    const r = await processExports(handlers);
    expect(r.done).toBeGreaterThanOrEqual(1);
    const s = await status(tenantId, id);
    expect([s.status, s.file_key]).toEqual(['READY', exportKey(tenantId, id)]);
    expect(await readdir(join(dir, 'exports', tenantId))).toEqual([`${id}.zip`]);
    // At-least-once delivery: the same event again is a no-op.
    await withTenant(pool, tenantId, (db) => db.execute(sql`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (${tenantId}, 'data_export.requested', ${JSON.stringify({ exportId: id })}::jsonb)`));
    await processExports(handlers);
    expect((await status(tenantId, id)).status).toBe('READY');
  });

  it('retries a failure, then after three tries marks it FAILED so the owner can ask again', async () => {
    const id = await request(tenantId);
    const broken = { put: async () => Promise.reject(new Error('disk full')), open: async () => null, remove: async () => undefined };
    const handlers = buildHandlers(new DevWorkerMailer(silent), { storage: broken, retentionDays: 7 });
    for (let i = 0; i < 3; i++) await processExports(handlers);
    const s = await status(tenantId, id);
    expect([s.status, s.error]).toEqual(['FAILED', 'disk full']);
    const audit = await withTenant(pool, tenantId, async (db) => (await db.execute<{ action: string }>(sql`SELECT action FROM audit_logs WHERE resource_id = ${id} ORDER BY occurred_at`)).rows.map((x) => x.action));
    expect(audit).toEqual(['data_export.failed']);
    // A new request is accepted again (only one REQUESTED at a time).
    await request(tenantId);
  });

  it('deletes files past their date and marks them EXPIRED', async () => {
    const [ready] = await withTenant(pool, tenantId, async (db) => (await db.execute<{ id: string }>(sql`SELECT id FROM data_exports WHERE status = 'READY'`)).rows);
    await withTenant(owner, tenantId, async (_db, c) => {
      await c.query('ALTER TABLE data_exports DISABLE TRIGGER data_exports_transition');
      try {
        await c.query(`UPDATE data_exports SET expires_at = now() - interval '1 second' WHERE id = $1`, [ready!.id]);
      } finally {
        await c.query('ALTER TABLE data_exports ENABLE TRIGGER data_exports_transition');
      }
    });
    expect(await expireDataExports(workerPool, storage, silent)).toBeGreaterThanOrEqual(1);
    expect((await status(tenantId, ready!.id)).status).toBe('EXPIRED');
    expect(await storage.open(exportKey(tenantId, ready!.id))).toBeNull();
  });
});
