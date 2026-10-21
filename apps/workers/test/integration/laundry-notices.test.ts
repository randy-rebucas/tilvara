import { createTenant, sql, withTenant } from '@1pos/database';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandlers, DevSmsSender, DevWorkerMailer } from '../../src/handlers.js';
import { WorkerMonitor } from '../../src/monitoring.js';
import { OutboxProcessor } from '../../src/outbox-processor.js';

/**
 * Laundry notices (ADR-0024 §6): a queued "ready for pickup" notice goes by email and (with SMS on) by
 * the SMS port, and is settled once with masked recipients; one for a job no longer due, or another
 * business's, sends nothing; the hourly pass queues reminders and the final notice once each.
 */
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
const workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 5 });
const slug = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
const silent = { info: () => undefined, error: () => undefined };

let tenantId: string;
let branchId: string;
let customerId: string;
const email = `${slug('liza')}@example.ph`;

beforeAll(async () => {
  tenantId = await createTenant(pool, { slug: slug('lnd'), name: 'Suds Laundry' });
  await withTenant(pool, tenantId, async (db) => {
    const { rows: [le] } = await db.execute<{ id: string }>(sql`INSERT INTO legal_entities (tenant_id, registered_name, trade_name) VALUES (${tenantId}, 'Suds Corp', 'Suds') RETURNING id`);
    const { rows: [b] } = await db.execute<{ id: string }>(sql`INSERT INTO branches (tenant_id, legal_entity_id, code, name) VALUES (${tenantId}, ${le!.id}, 'L1', 'Kamuning') RETURNING id`);
    const { rows: [c] } = await db.execute<{ id: string }>(sql`INSERT INTO customers (tenant_id, display_name, email, phone, created_by) VALUES (${tenantId}, 'Liza Reyes', ${email}, '0917 123 4567', ${randomUUID()}) RETURNING id`);
    await db.execute(sql`INSERT INTO laundry_settings (tenant_id, branch_id, sms_enabled, updated_by) VALUES (${tenantId}, ${b!.id}, true, ${randomUUID()})`);
    branchId = b!.id;
    customerId = c!.id;
  });
  // The shared test DB holds other suites' events: work them off first, so each test waits only for its own.
  const p = new OutboxProcessor({ pool: workerPool, workerId: slug('drain'), handlers: buildHandlers(new DevWorkerMailer(silent)), batchSize: 500, retryDelaySeconds: () => 3600 });
  while ((await p.runOnce()).claimed > 0);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await workerPool.end();
});

/** A READY job of ₱100.00 (₱40.00 paid down), ready `days` ago, with a queued notice of `kind`, and its event. */
async function queued(number: number, opts: { notify?: boolean; status?: string; days?: number } = {}) {
  return withTenant(pool, tenantId, async (db) => {
    const user = randomUUID();
    const { rows: [j] } = await db.execute<{ id: string; legal_entity_id: string }>(sql`
      INSERT INTO job_orders (tenant_id, legal_entity_id, branch_id, number, claim_code, customer_id, promised_at, status, ready_at, amount_due, notify, received_by, updated_by)
      SELECT ${tenantId}, b.legal_entity_id, b.id, ${number}, ${`Q${String(number).padStart(5, '0')}`}, ${customerId}, now(), ${opts.status ?? 'READY'},
             now() - make_interval(days => ${opts.days ?? 0}), '100.00', ${opts.notify ?? true}, ${user}, ${user}
        FROM branches b WHERE b.id = ${branchId} RETURNING id, legal_entity_id`);
    await db.execute(sql`INSERT INTO job_order_deposits (tenant_id, job_order_id, legal_entity_id, branch_id, kind, amount, method, reference, created_by)
                         VALUES (${tenantId}, ${j!.id}, ${j!.legal_entity_id}, ${branchId}, 'RECEIVED', '40.00', 'BANK_TRANSFER', 'GCASH-1', ${user})`);
    const { rows: [n] } = await db.execute<{ id: string }>(sql`INSERT INTO job_order_notices (tenant_id, job_order_id, kind) VALUES (${tenantId}, ${j!.id}, 'READY') RETURNING id`);
    const { rows: [e] } = await db.execute<{ id: string }>(sql`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (${tenantId}, 'job_order.notice', ${JSON.stringify({ noticeId: n!.id, jobOrderId: j!.id })}::jsonb) RETURNING id`);
    return { jobId: j!.id, noticeId: n!.id, eventId: e!.id };
  });
}

async function processUntilDone(eventId: string, handlers: ReturnType<typeof buildHandlers>) {
  const p = new OutboxProcessor({ pool: workerPool, workerId: slug('laundry'), handlers, batchSize: 500, retryDelaySeconds: () => 3600 });
  for (let i = 0; i < 100; i++) {
    await p.runOnce();
    const { rows } = await withTenant(pool, tenantId, (db) => db.execute<{ status: string; last_error: string | null }>(sql`SELECT status, last_error FROM outbox_events WHERE id = ${eventId}`));
    if (rows[0]!.status !== 'PENDING') return rows[0]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`event ${eventId} was never processed`);
}

const notice = (id: string) =>
  withTenant(pool, tenantId, async (db) => (await db.execute<Record<string, unknown>>(sql`SELECT status, email_status, email_to, sms_status, sms_to FROM job_order_notices WHERE id = ${id}`)).rows[0]!);

describe('laundry notices', () => {
  it('a ready notice goes by email and SMS, without items or the claim code, and is settled once with masked recipients', async () => {
    const { noticeId, eventId } = await queued(1);
    const mailer = new DevWorkerMailer(silent);
    const sms = new DevSmsSender(silent);
    const monitor = new WorkerMonitor(workerPool, 'x', 'x');
    const done = await processUntilDone(eventId, buildHandlers(mailer, undefined, sms, monitor));
    expect(done.status).toBe('DONE');
    // Counted per channel and outcome (fixed label sets), for the LaundryNoticesFailing alert.
    expect([monitor.laundryNotices.get({ channel: 'email', outcome: 'sent' }), monitor.laundryNotices.get({ channel: 'sms', outcome: 'sent' })]).toEqual([1, 1]);
    const mail = mailer.sent.filter((m) => m.to === email);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ template: 'job_order.ready', subject: 'Your laundry J-000001 is ready' });
    expect(mail[0]!.text).toBe('Suds: your laundry J-000001 is ready for pickup at Kamuning. Balance ₱60.00. Please bring your claim stub.');
    expect(mail[0]!.text).not.toContain('Q00001');
    expect(sms.sent.filter((m) => m.to === '0917 123 4567').map((m) => m.text)).toEqual([mail[0]!.text]);
    expect(await notice(noticeId)).toEqual({ status: 'SENT', email_status: 'SENT', email_to: expect.stringMatching(/^l\*\*\*@example\.ph$/), sms_status: 'SENT', sms_to: '***4567' });
    // Settled once: the worker cannot settle it again, and the app cannot settle it at all.
    const again = await withTenant(workerPool, tenantId, async (_db, c) => (await c.query<{ ok: boolean }>(`SELECT laundry_notice_settle($1, 'SKIPPED', null, 'SKIPPED', null, null) AS ok`, [noticeId])).rows[0]!.ok);
    expect(again).toBe(false);
    await expect(pool.query(`SELECT laundry_notice_settle($1, 'SENT', null, 'SENT', null, null)`, [noticeId])).rejects.toThrow(/permission denied/);
  });

  it('a notice for a job no longer due, or with notices off, is skipped; nothing is sent', async () => {
    const claimed = await queued(2, { notify: false });
    const mailer = new DevWorkerMailer(silent);
    const sms = new DevSmsSender(silent);
    const monitor = new WorkerMonitor(workerPool, 'x', 'x');
    await processUntilDone(claimed.eventId, buildHandlers(mailer, undefined, sms, monitor));
    expect(await notice(claimed.noticeId)).toMatchObject({ status: 'SKIPPED', email_status: 'SKIPPED', sms_status: 'SKIPPED' });
    expect(monitor.laundryNotices.get({ channel: 'email', outcome: 'skipped' })).toBe(1);
    expect(mailer.sent.filter((m) => m.text.includes('J-000002'))).toEqual([]);
    expect(sms.sent.filter((m) => m.text.includes('J-000002'))).toEqual([]);
  });

  it('a channel that fails is settled FAILED and counted as failed', async () => {
    const { noticeId, eventId } = await queued(4);
    const monitor = new WorkerMonitor(workerPool, 'x', 'x');
    const broken = { send: async () => { throw new Error('provider down'); } };
    expect((await processUntilDone(eventId, buildHandlers(new DevWorkerMailer(silent), undefined, broken, monitor))).status).toBe('DONE');
    expect(await notice(noticeId)).toMatchObject({ email_status: 'SENT', sms_status: 'FAILED' });
    expect([monitor.laundryNotices.get({ channel: 'email', outcome: 'sent' }), monitor.laundryNotices.get({ channel: 'sms', outcome: 'failed' })]).toEqual([1, 1]);
  });

  it('the hourly pass queues each reminder day and the final notice once, with one event each', async () => {
    const { jobId } = await queued(3, { days: 28 });
    const first = (await workerPool.query<{ n: number }>('SELECT platform_flag_laundry_notices() AS n')).rows[0]!.n;
    expect(first).toBeGreaterThanOrEqual(3);
    await workerPool.query('SELECT platform_flag_laundry_notices()');
    const rows = await withTenant(pool, tenantId, async (db) => (await db.execute<{ kind: string; step: number }>(sql`SELECT kind, step FROM job_order_notices WHERE job_order_id = ${jobId} ORDER BY kind, step`)).rows);
    expect(rows).toEqual([{ kind: 'FINAL', step: 0 }, { kind: 'READY', step: 0 }, { kind: 'REMINDER', step: 3 }, { kind: 'REMINDER', step: 7 }]);
    const events = await withTenant(pool, tenantId, async (db) => (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'job_order.notice' AND payload->>'jobOrderId' = ${jobId}`)).rows[0]!.n);
    expect(events).toBe(4);
    await expect(pool.query('SELECT platform_flag_laundry_notices()')).rejects.toThrow(/permission denied/);
  });
});
