import { createTenant, outboxEvents, withTenant } from '@1pos/database';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDead, replayDead } from '../../src/dead-letters.js';
import { HEARTBEAT_EVERY_MS, WorkerMonitor } from '../../src/monitoring.js';

/** ADR-0016 slice 3: the worker's heartbeat and metrics, and the audited DEAD-letter tool. */
const app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
const worker = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 4 });
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 2 });

let tenantId: string;

beforeAll(async () => {
  tenantId = await createTenant(app, { slug: `mon-${randomUUID().slice(0, 8)}`, name: 'Monitoring' });
});

afterAll(async () => {
  await Promise.all([app.end(), worker.end(), owner.end()]);
});

async function gauges(): Promise<Record<string, number>> {
  const { rows } = await app.query<{ metric: string; label: string; value: number }>('SELECT * FROM platform_metrics()');
  return Object.fromEntries(rows.map((r) => [r.label ? `${r.metric}{${r.label}}` : r.metric, Number(r.value)]));
}

/** As the schema owner inside the tenant (FORCE RLS applies to the owner too). */
async function inTenant<T>(fn: (c: pg.PoolClient) => Promise<T>, role?: string): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    if (role) await c.query(`SET LOCAL ROLE ${role}`);
    else await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('worker heartbeat', () => {
  it('beats through worker_heartbeat(), throttled, and the API sees the worker alive', async () => {
    const id = `test-${randomUUID()}`;
    const monitor = new WorkerMonitor(worker, id, 'test');
    const t0 = Date.now();
    expect(await monitor.beat(t0)).toBe(true);
    expect(await monitor.beat(t0 + 1_000)).toBe(false); // within HEARTBEAT_EVERY_MS
    const g = await gauges();
    expect(g.workers_alive).toBeGreaterThanOrEqual(1);
    expect(g.worker_heartbeat_age_seconds).toBeLessThan(5);
    expect(await monitor.beat(t0 + HEARTBEAT_EVERY_MS)).toBe(true);

    const row = () => inTenant((c) => c.query('SELECT worker_id, version FROM worker_heartbeats WHERE worker_id = $1', [id]), 'onepos_platform');
    expect((await row()).rows).toEqual([{ worker_id: id, version: 'test' }]);
    await monitor.stop();
    expect((await row()).rows).toEqual([]);
  });

  it('the heartbeat table is reachable only through its functions', async () => {
    await expect(worker.query('SELECT * FROM worker_heartbeats')).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('SELECT * FROM worker_heartbeats')).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("SELECT worker_heartbeat('x', now(), 'v')")).rejects.toMatchObject({ code: '42501' });
    // The gauges are the API's; the worker does not need them.
    await expect(worker.query('SELECT * FROM platform_metrics()')).rejects.toMatchObject({ code: '42501' });
  });

  it('exports batch outcomes, loop health and pool sizes', async () => {
    const monitor = new WorkerMonitor(worker, `test-${randomUUID()}`, 'test');
    monitor.recordBatch({ claimed: 4, done: 2, retried: 1, dead: 1 });
    monitor.recordBatch({ claimed: 0, done: 0, retried: 0, dead: 0 });
    const text = await monitor.registry.render();
    expect(text).toContain('onepos_worker_outbox_events_total{outcome="done"} 2');
    expect(text).toContain('onepos_worker_outbox_events_total{outcome="dead"} 1');
    expect(text).toContain('onepos_worker_batches_total 1');
    expect(text).toMatch(/^onepos_worker_last_loop_timestamp_seconds \d+(\.\d+)?$/m);
    expect(text).toMatch(/^onepos_worker_db_pool_connections\{state="total"\} \d+$/m);
  });
});

describe('DEAD-letter tool', () => {
  const topic = `monitoring.dead_${randomBytes(4).toString('hex')}`;
  let id: string;

  beforeAll(async () => {
    id = await withTenant(app, tenantId, async (db) => {
      const [row] = await db.insert(outboxEvents).values({ tenantId, topic, payload: { email: 'private@example.ph' } }).returning({ id: outboxEvents.id });
      return row!.id;
    });
    await inTenant((c) => c.query("UPDATE outbox_events SET status = 'DEAD', attempts = 10, last_error = 'Error: mailbox full' WHERE id = $1", [id]));
  });

  it('lists DEAD events without their payload, and counts them in the gauges', async () => {
    const rows = await listDead(worker, { topic });
    expect(rows).toEqual([
      { id, tenantId, topic, attempts: 10, lastError: 'Error: mailbox full', createdAt: expect.any(Date), failedAt: expect.any(Date) },
    ]);
    expect(JSON.stringify(rows)).not.toContain('private@example.ph');
    expect((await gauges())['outbox_events{DEAD}']).toBeGreaterThanOrEqual(1);
  });

  it('needs an actor and a reason, and only the worker may replay', async () => {
    await expect(replayDead(worker, id, 'ops', '')).rejects.toMatchObject({ code: '22023' });
    await expect(replayDead(worker, id, ' ', 'cause fixed')).rejects.toMatchObject({ code: '22023' });
    await expect(app.query('SELECT outbox_dead_replay($1, $2, $3)', [id, 'ops', 'cause fixed'])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('SELECT * FROM outbox_dead_list(10, NULL)')).rejects.toMatchObject({ code: '42501' });
  });

  it('replays once with fresh attempts and records who did it and why', async () => {
    const actor = `ops-${randomUUID().slice(0, 8)}`;
    expect(await replayDead(worker, id, actor, 'mail provider back up')).toBe(true);
    expect(await replayDead(worker, id, actor, 'mail provider back up')).toBe(false);
    expect(await replayDead(worker, randomUUID(), actor, 'no such event')).toBe(false);
    const { rows: [e] } = await inTenant((c) => c.query('SELECT status, attempts, locked_by, available_at <= now() AS due FROM outbox_events WHERE id = $1', [id]));
    expect(e).toEqual({ status: 'PENDING', attempts: 0, locked_by: null, due: true });
    expect(await listDead(worker, { topic })).toEqual([]);

    const { rows: audit } = await inTenant(
      (c) => c.query("SELECT tenant_id, actor_type, resource_id, metadata FROM audit_logs WHERE action = 'platform.outbox.replay' AND metadata->>'actor' = $1", [actor]),
      'onepos_platform',
    );
    expect(audit).toEqual([
      {
        tenant_id: null,
        actor_type: 'SYSTEM',
        resource_id: id,
        metadata: { actor, reason: 'mail provider back up', topic, tenantId, attempts: 10, lastError: 'Error: mailbox full' },
      },
    ]);
    // The replay is a platform event: the tenant does not see it in its own log.
    const { rows: seen } = await inTenant((c) => c.query("SELECT 1 FROM audit_logs WHERE action = 'platform.outbox.replay'"));
    expect(seen).toEqual([]);
  });
});
