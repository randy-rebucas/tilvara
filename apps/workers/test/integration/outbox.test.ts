import { createTenant, outboxEvents, sql, tenantMemberships, tenants, transaction, withTenant } from '@1pos/database';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandlers, DevWorkerMailer } from '../../src/handlers.js';
import { OutboxProcessor, type OutboxEvent, type OutboxHandler } from '../../src/outbox-processor.js';

/** The API's runtime role: emits events (in its business transactions) and reads them back. */
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
/** The worker's own role (ADR-0016): processes the outbox. */
const workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 10 });
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 2 });
const slug = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
const noDelay = () => 0;

async function emit(tenantId: string, topic: string, payload: Record<string, unknown> = {}): Promise<string> {
  return withTenant(pool, tenantId, async (db) => {
    const [row] = await db.insert(outboxEvents).values({ tenantId, topic, payload }).returning({ id: outboxEvents.id });
    return row!.id;
  });
}

async function eventRow(tenantId: string, id: string) {
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.execute<{ status: string; attempts: number; last_error: string | null; available_at: Date }>(
      sql`SELECT status, attempts, last_error, available_at FROM outbox_events WHERE id = ${id}`,
    );
    return rows[0]!;
  });
}

/** Process everything currently due so tests start from a clean queue. */
async function drain(handlers: Record<string, OutboxHandler> = {}): Promise<void> {
  const p = new OutboxProcessor({ pool: workerPool, workerId: 'drain', handlers, batchSize: 500, retryDelaySeconds: () => 3600 });
  while ((await p.runOnce()).claimed > 0);
}

let tA: string;
let tB: string;

beforeAll(async () => {
  tA = await createTenant(pool, { slug: slug('wa'), name: 'Worker A' });
  tB = await createTenant(pool, { slug: slug('wb'), name: 'Worker B' });
  await drain();
});

afterAll(async () => {
  await pool.end();
  await workerPool.end();
  await owner.end();
});

describe('least-privilege roles (ADR-0016)', () => {
  it('the worker logs in as onepos_worker, without RLS bypass', async () => {
    const { rows } = await workerPool.query<{ who: string; bypass: boolean; super: boolean }>(
      `SELECT current_user AS who, rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ who: 'onepos_worker', bypass: false, super: false });
  });

  it('the API role can no longer claim, complete or purge', async () => {
    for (const q of ["SELECT * FROM outbox_claim('x', 1, 1)", `SELECT outbox_complete('${randomUUID()}', 'x')`, 'SELECT platform_purge_expired_idempotency()']) {
      await expect(pool.query(q)).rejects.toThrow(/permission denied/);
    }
  });

  it('the worker writes nothing directly, sees no credentials, and sees nothing outside a tenant', async () => {
    // Drizzle wraps the Postgres error; insufficient_privilege (42501) is on its cause.
    const denied = { cause: { code: '42501' } };
    const id = await emit(tA, 'test.role');
    try {
      await expect(withTenant(workerPool, tA, (db) => db.execute(sql`UPDATE outbox_events SET status = 'DONE' WHERE id = ${id}`))).rejects.toMatchObject(denied);
      await expect(withTenant(workerPool, tA, (db) => db.execute(sql`INSERT INTO audit_logs (tenant_id, actor_type, action, resource_type) VALUES (${tA}, 'SYSTEM', 'x', 'x')`))).rejects.toMatchObject(denied);
      await expect(workerPool.query('SELECT password_hash FROM users LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(workerPool.query('SELECT * FROM user_sessions LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(workerPool.query('SELECT id FROM sales LIMIT 1')).rejects.toThrow(/permission denied/);
      // Outside a tenant context the worker sees no tenant at all (RLS).
      expect((await workerPool.query('SELECT id FROM tenants')).rows).toEqual([]);
      expect((await workerPool.query('SELECT platform_purge_expired_idempotency() AS purged')).rows).toHaveLength(1);
    } finally {
      await drain();
    }
  });
});

describe('outbox processing', () => {
  it('delivers each event once, inside the event tenant’s RLS context', async () => {
    const seen: { tenantId: string; visibleTenants: string[] }[] = [];
    const handlers: Record<string, OutboxHandler> = {
      'test.ping': async (e, db) => {
        const rows = await db.select({ id: tenants.id }).from(tenants);
        seen.push({ tenantId: e.tenantId, visibleTenants: rows.map((r) => r.id) });
      },
    };
    const idA = await emit(tA, 'test.ping');
    const idB = await emit(tB, 'test.ping');
    const p = new OutboxProcessor({ pool: workerPool, workerId: 'w1', handlers });
    const r = await p.runOnce();
    expect(r).toMatchObject({ claimed: 2, done: 2, retried: 0, dead: 0 });
    expect(seen).toEqual(
      expect.arrayContaining([
        { tenantId: tA, visibleTenants: [tA] },
        { tenantId: tB, visibleTenants: [tB] },
      ]),
    );
    expect((await eventRow(tA, idA)).status).toBe('DONE');
    expect((await eventRow(tB, idB)).status).toBe('DONE');
    expect((await p.runOnce()).claimed).toBe(0);
  });

  it('retries failures with backoff and dead-letters after max attempts', async () => {
    let calls = 0;
    const handlers: Record<string, OutboxHandler> = {
      'test.flaky': async () => {
        calls++;
        throw new Error('provider unavailable');
      },
    };
    const id = await emit(tA, 'test.flaky');
    const backoff = new OutboxProcessor({ pool: workerPool, workerId: 'w2', handlers });
    expect(await backoff.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    const row = await eventRow(tA, id);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'Error: provider unavailable' });
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now()); // backoff scheduled
    expect((await backoff.runOnce()).claimed).toBe(0); // not due yet

    // Make it due again and lower the cap to observe dead-lettering.
    await owner.query(
      `BEGIN; SELECT set_config('app.tenant_id', '${tA}', true);
       UPDATE outbox_events SET available_at = now(), max_attempts = 3 WHERE id = '${id}'; COMMIT;`,
    );
    const fast = new OutboxProcessor({ pool: workerPool, workerId: 'w2', handlers, retryDelaySeconds: noDelay });
    await fast.runOnce();
    const last = await fast.runOnce();
    expect(last.dead).toBe(1);
    expect((await eventRow(tA, id)).status).toBe('DEAD');
    expect(calls).toBe(3);
    expect((await fast.runOnce()).claimed).toBe(0);
  });

  it('reclaims events whose worker died (expired lease) and ignores the dead worker’s late ack', async () => {
    const id = await emit(tA, 'test.crash');
    const claimed = await workerPool.query('SELECT * FROM outbox_claim($1, 10, 1)', ['crashed-worker']);
    expect(claimed.rows.map((r: { id: string }) => r.id)).toContain(id);

    const survivor = new OutboxProcessor({ pool: workerPool, workerId: 'survivor', handlers: {} });
    expect((await survivor.runOnce()).claimed).toBe(0); // lease still valid
    await new Promise((r) => setTimeout(r, 1200));
    expect(await survivor.runOnce()).toMatchObject({ claimed: 1, done: 1 });

    const late = await workerPool.query<{ ok: boolean }>('SELECT outbox_complete($1, $2) AS ok', [id, 'crashed-worker']);
    expect(late.rows[0]!.ok).toBe(false);
    expect((await eventRow(tA, id)).attempts).toBe(2);
  });

  it('competing workers never process the same event twice', async () => {
    const counts = new Map<string, number>();
    const handlers: Record<string, OutboxHandler> = {
      'test.race': async (e: OutboxEvent) => {
        await new Promise((r) => setTimeout(r, 5));
        counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      },
    };
    const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => emit(i % 2 ? tA : tB, 'test.race', { i })));
    const workers = [1, 2, 3].map((n) => new OutboxProcessor({ pool: workerPool, workerId: `racer-${n}`, handlers, batchSize: 4 }));
    for (;;) {
      const rs = await Promise.all(workers.map((w) => w.runOnce()));
      if (rs.every((r) => r.claimed === 0)) break;
    }
    expect(ids.every((id) => counts.get(id) === 1)).toBe(true);
  });

  it('acknowledges events that have no consumer yet (kept for future replay)', async () => {
    const id = await emit(tA, 'catalog.something_new');
    await new OutboxProcessor({ pool: workerPool, workerId: 'w3', handlers: {} }).runOnce();
    expect((await eventRow(tA, id)).status).toBe('DONE');
  });

  it('runtime role cannot tamper with the outbox directly', async () => {
    const id = await emit(tA, 'test.tamper');
    await expect(withTenant(pool, tA, (db) => db.execute(sql`UPDATE outbox_events SET status = 'DONE' WHERE id = ${id}`))).rejects.toThrow();
    await expect(withTenant(pool, tA, (db) => db.execute(sql`DELETE FROM outbox_events WHERE id = ${id}`))).rejects.toThrow();
    await drain();
  });
});

describe('handlers', () => {
  it('tenant.onboarded sends the welcome email to that tenant’s owner', async () => {
    const tenantId = await createTenant(pool, { slug: slug('welcome'), name: 'Welcome Shop' });
    const email = `${slug('owner')}@example.ph`;
    const userId = await transaction(pool, async (tx) => {
      const { rows } = await tx.client.query<{ id: string }>('SELECT auth_register_user($1, $2, $3) AS id', [
        email,
        'Ana',
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
      ]);
      await tx.setTenant(tenantId);
      await tx.db.insert(tenantMemberships).values({ tenantId, userId: rows[0]!.id });
      return rows[0]!.id;
    });
    await emit(tenantId, 'tenant.onboarded', { ownerUserId: userId });

    const mailer = new DevWorkerMailer({ info: () => undefined, error: () => undefined });
    const p = new OutboxProcessor({ pool: workerPool, workerId: 'mail', handlers: buildHandlers(mailer), batchSize: 500 });
    while ((await p.runOnce()).claimed > 0);
    const mine = mailer.sent.filter((m) => m.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ template: 'tenant.welcome' });
    expect(mine[0]!.text).toContain('Ana');
  });

  it('a payload pointing at another tenant’s user fails safely (RLS) instead of leaking', async () => {
    const other = await createTenant(pool, { slug: slug('victim'), name: 'Victim' });
    const victimUser = await transaction(pool, async (tx) => {
      const { rows } = await tx.client.query<{ id: string }>('SELECT auth_register_user($1, $2, $3) AS id', [
        `${slug('victim')}@example.ph`,
        'Victim',
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
      ]);
      await tx.setTenant(other);
      await tx.db.insert(tenantMemberships).values({ tenantId: other, userId: rows[0]!.id });
      return rows[0]!.id;
    });
    const id = await emit(tA, 'tenant.onboarded', { ownerUserId: victimUser });
    const mailer = new DevWorkerMailer({ info: () => undefined, error: () => undefined });
    await new OutboxProcessor({ pool: workerPool, workerId: 'mail2', handlers: buildHandlers(mailer), retryDelaySeconds: () => 3600 }).runOnce();
    expect(mailer.sent).toHaveLength(0);
    expect((await eventRow(tA, id)).last_error).toContain('not visible');
  });
});
