import { createTenant, newSigningSalt, outboxEvents, sql, verifySignature, webhookEndpoints, webhookSecret, withTenant } from '@1pos/database';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHandlers, DevWorkerMailer } from '../../src/handlers.js';
import { OutboxProcessor, type Logger } from '../../src/outbox-processor.js';
import { postPinned, WebhookDispatcher } from '../../src/webhook-dispatcher.js';

/** Outbound webhooks (session 20, ADR-0019): fan-out from the outbox, signed delivery, retries, refusals. */
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
const workerPool = new pg.Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 5 });
const KEY = 'test-webhook-signing-key-0123456789abcdef';
const silent: Logger = { info: () => undefined, error: () => undefined };
const slug = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

interface Received { headers: IncomingMessage['headers']; body: string; path: string }
let server: Server;
let base: string;
const received: Received[] = [];
/** /ok answers 204, /fail 500, /slow never answers in time. */
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, path: req.url ?? '' });
      if (req.url?.startsWith('/slow')) return setTimeout(() => res.end(), 3000);
      res.statusCode = req.url?.startsWith('/fail') ? 500 : 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await pool.end();
  await workerPool.end();
});

/** A business on a plan with API access (webhooks are part of it); `plan` another one. */
async function business(input: { slug: string; name: string }, plan = 'enterprise') {
  const id = await createTenant(pool, input);
  await withTenant(pool, id, (_db, client) => client.query('SELECT platform_start_trial($1, $2, 14)', [id, plan]));
  return id;
}

async function endpoint(tenantId: string, path: string, topics: string[], enabled = true) {
  return withTenant(pool, tenantId, async (db) => {
    const salt = newSigningSalt();
    const url = path.startsWith('https://') ? path : `${base}${path}`;
    const [row] = await db.insert(webhookEndpoints).values({ tenantId, url, topics, enabled, signingSalt: salt, createdBy: randomUUID() }).returning();
    return { id: row!.id, secret: webhookSecret(KEY, row!.id, salt) };
  });
}

async function emit(tenantId: string, topic: string, payload: Record<string, unknown>) {
  return withTenant(pool, tenantId, async (db) => (await db.insert(outboxEvents).values({ tenantId, topic, payload }).returning({ id: outboxEvents.id }))[0]!.id);
}

/** Process the outbox until this event was handled (the fan-out runs in its handler). */
async function processed(tenantId: string, eventId: string) {
  const p = new OutboxProcessor({ pool: workerPool, workerId: 'webhooks-test', handlers: buildHandlers(new DevWorkerMailer(silent)), batchSize: 200, retryDelaySeconds: () => 3600 });
  for (let i = 0; i < 100; i++) {
    await p.runOnce();
    const { rows } = await withTenant(pool, tenantId, (db) => db.execute<{ status: string }>(sql`SELECT status FROM outbox_events WHERE id = ${eventId}`));
    if (rows[0]?.status === 'DONE') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`event ${eventId} was never processed`);
}

const deliveries = (tenantId: string, endpointId: string) =>
  withTenant(pool, tenantId, async (db) => (await db.execute<{ id: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; event_id: string | null }>(
    sql`SELECT id, status, attempts, last_status_code, last_error, event_id FROM webhook_deliveries WHERE endpoint_id = ${endpointId} ORDER BY created_at`,
  )).rows);

const dispatcher = (o: Partial<ConstructorParameters<typeof WebhookDispatcher>[0]> = {}) =>
  new WebhookDispatcher({ pool: workerPool, workerId: 'webhooks-test', signingKey: KEY, allowInsecure: true, timeoutMs: 1000, logger: silent, retryDelaySeconds: () => 0, ...o });

async function dispatchUntil(d: WebhookDispatcher, done: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) {
    await d.runOnce();
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('dispatch did not finish');
}

describe('outbound webhooks', () => {
  it('an event becomes one signed delivery per listening endpoint of its business; nothing for others', async () => {
    const a = await business({ slug: slug('wh-a'), name: 'Hooks A' });
    const b = await business({ slug: slug('wh-b'), name: 'Hooks B' });
    const listening = await endpoint(a, '/ok/a', ['sale.completed']);
    const otherTopic = await endpoint(a, '/ok/a2', ['stock.low']);
    const disabled = await endpoint(a, '/ok/a3', ['sale.completed'], false);
    const otherBusiness = await endpoint(b, '/ok/b', ['sale.completed']);

    const saleId = randomUUID();
    const eventId = await emit(a, 'sale.completed', { saleId, saleNumber: 7 });
    await processed(a, eventId);
    expect((await deliveries(a, listening.id)).map((d) => [d.status, d.event_id])).toEqual([['PENDING', eventId]]);
    for (const e of [otherTopic, disabled]) expect(await deliveries(a, e.id)).toEqual([]);
    expect(await deliveries(b, otherBusiness.id)).toEqual([]);

    await dispatchUntil(dispatcher(), async () => (await deliveries(a, listening.id))[0]!.status === 'DELIVERED');
    const got = received.find((r) => r.path === '/ok/a')!;
    expect(got.headers['tilvara-event']).toBe('sale.completed');
    expect(got.headers['content-type']).toBe('application/json');
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({ id: got.headers['tilvara-delivery'], type: 'sale.completed', data: { saleId, saleNumber: 7 } });
    // The receiver verifies the signature with the secret it was shown; a wrong secret fails.
    expect(verifySignature(listening.secret, String(got.headers['tilvara-signature']), got.body)).toBe(true);
    expect(verifySignature(otherBusiness.secret, String(got.headers['tilvara-signature']), got.body)).toBe(false);
    expect((await deliveries(a, listening.id))[0]).toMatchObject({ status: 'DELIVERED', attempts: 1, last_status_code: 204 });
  });

  it('a failing receiver is retried, then given up on (DEAD); a slow one times out', async () => {
    const t = await business({ slug: slug('wh-f'), name: 'Hooks F' });
    const failing = await endpoint(t, '/fail', ['sale.returned']);
    const slow = await endpoint(t, '/slow', ['sale.voided']);
    await processed(t, await emit(t, 'sale.returned', { saleId: randomUUID() }));
    await processed(t, await emit(t, 'sale.voided', { saleId: randomUUID() }));
    // Seven of the eight attempts already spent (the API role may set attempts, as its retry does): the next one is the last.
    await withTenant(pool, t, (db) => db.execute(sql`UPDATE webhook_deliveries SET attempts = 7 WHERE endpoint_id IN (${failing.id}, ${slow.id})`));
    const d = dispatcher({ timeoutMs: 1000 });
    await dispatchUntil(d, async () => (await deliveries(t, failing.id))[0]!.status === 'DEAD' && (await deliveries(t, slow.id))[0]!.status === 'DEAD');
    expect((await deliveries(t, failing.id))[0]).toMatchObject({ status: 'DEAD', attempts: 8, last_status_code: 500, last_error: 'HTTP 500' });
    expect((await deliveries(t, slow.id))[0]).toMatchObject({ status: 'DEAD', last_status_code: null, last_error: 'timed out' });
  }, 120_000);

  it('without the insecure allowance, http and private addresses are refused and nothing is sent', async () => {
    const t = await business({ slug: slug('wh-s'), name: 'Hooks S' });
    const local = await endpoint(t, '/ok/secure', ['sale.completed']);
    await processed(t, await emit(t, 'sale.completed', { saleId: randomUUID() }));
    const before = received.length;
    const d = dispatcher({ allowInsecure: false, retryDelaySeconds: () => 3600 });
    await dispatchUntil(d, async () => (await deliveries(t, local.id))[0]!.attempts === 1);
    expect((await deliveries(t, local.id))[0]).toMatchObject({ status: 'PENDING', last_error: 'not https' });
    expect(received.slice(before).some((r) => r.path === '/ok/secure')).toBe(false);
  });

  it('an https host that resolves to any private address is refused before connecting', async () => {
    const t = await business({ slug: slug('wh-p'), name: 'Hooks P' });
    const hook = await endpoint(t, 'https://hooks.example.test/in', ['sale.completed']);
    await processed(t, await emit(t, 'sale.completed', { saleId: randomUUID() }));
    const asked: string[] = [];
    // One public and one private answer: a single private address is enough to refuse.
    const d = dispatcher({ allowInsecure: false, retryDelaySeconds: () => 3600, resolve: async (h) => (asked.push(h), ['93.184.216.34', '10.1.2.3']) });
    await dispatchUntil(d, async () => (await deliveries(t, hook.id))[0]!.attempts === 1);
    expect((await deliveries(t, hook.id))[0]).toMatchObject({ status: 'PENDING', last_error: 'address not public' });
    expect(asked).toEqual(['hooks.example.test']);
  });

  it('the connection goes to the checked address, not to a fresh DNS answer (rebinding)', async () => {
    // `.invalid` never resolves: the request can only arrive if the socket uses the pinned address.
    const port = (server.address() as AddressInfo).port;
    const status = await postPinned(`http://rebind.invalid:${port}/ok/pinned`, '127.0.0.1', 1000, { 'content-type': 'application/json' }, '{}');
    expect(status).toBe(204);
    const got = received.find((r) => r.path === '/ok/pinned')!;
    expect(got.headers.host).toBe(`rebind.invalid:${port}`);
    // Without a pinned address the name is looked up, and fails.
    await expect(postPinned(`http://rebind.invalid:${port}/ok/unpinned`, null, 1000, {}, '{}')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('nothing is sent for a business whose plan has no API access (its endpoints are kept)', async () => {
    const t = await business({ slug: slug('wh-g'), name: 'Hooks G' }, 'growth');
    const kept = await endpoint(t, '/ok/g', ['sale.completed']);
    const eventId = await emit(t, 'sale.completed', { saleId: randomUUID(), saleNumber: 1 });
    await processed(t, eventId);
    expect(await deliveries(t, kept.id)).toEqual([]);
  });

  it('the worker reaches deliveries only through its functions; the API role cannot claim them', async () => {
    expect(String(await workerPool.query('SELECT * FROM webhook_deliveries').catch((e: Error) => e))).toMatch(/permission denied/);
    expect(String(await pool.query(`SELECT * FROM webhook_claim('x', 1, 1)`).catch((e: Error) => e))).toMatch(/permission denied/);
  });
});
