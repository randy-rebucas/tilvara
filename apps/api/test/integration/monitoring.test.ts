import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiMetrics, BUSINESS_GAUGES } from '../../src/infrastructure/metrics.js';
import { MonitoringService } from '../../src/infrastructure/monitoring.service.js';
import { addMember, bearer, createApp, loginToken, ownerPool, signup, uniq, type SignedUp } from './helpers.js';

/**
 * ADR-0016 slice 3: the API's internal metrics. Real requests move the counters; the business
 * gauges equal independent counts and carry no tenant data; the port is separate from the API;
 * readiness checks the migration head; every alert rule names exported metrics and a runbook.
 */
let app: INestApplication;
let owner: pg.Pool;
let metrics: ApiMetrics;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  // A short provider timeout, so a hanging card authorization becomes UNKNOWN quickly.
  app = await createApp({ PAYMENT_TIMEOUT_MS: 300 });
  owner = ownerPool();
  metrics = app.get(ApiMetrics);
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

/** Render with the business gauges re-queried (they are otherwise cached for 10 s). */
async function scrape(a: INestApplication = app): Promise<string> {
  (a.get(MonitoringService) as unknown as { gaugesAt: number }).gaugesAt = 0;
  return a.get(ApiMetrics).registry.render();
}

function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1).replace('+Inf', 'Infinity'));
}

async function platformCount(sql: string, params: unknown[] = []): Promise<number> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE onepos_platform');
    const n = Number((await c.query(sql, params)).rows[0].n);
    await c.query('COMMIT');
    return n;
  } finally {
    c.release();
  }
}

interface Shop {
  t: SignedUp;
  auth: Auth;
  registerId: string;
  cola: string;
  cashier: Auth;
  manager: Auth;
}

async function shop(prefix: string): Promise<Shop> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = await http()
    .post('/v1/products')
    .set(auth)
    .send({ name: 'Cola 290ml', uomId: pc, taxCategoryId: taxes.VAT, variants: [{ sku: uniq('SKU'), price: '22.40' }] })
    .expect(201);
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  return {
    t,
    auth,
    registerId: reg.body.id,
    cola: product.body.variants[0].id,
    cashier: bearer(await loginToken(app, c.email)),
    manager: bearer(await loginToken(app, m.email)),
  };
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe('the metrics port', () => {
  it('is its own listener: the public API never serves /metrics', async () => {
    await http().get('/metrics').expect(404);
    await http().get('/v1/metrics').expect(404);
    const port = await freePort();
    const withPort = await createApp({ API_METRICS_PORT: port, METRICS_HOST: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      const text = await res.text();
      expect(text).toContain('# TYPE onepos_checkout_total counter');
      expect(text).toMatch(/^onepos_db_up 1$/m);
      expect((await fetch(`http://127.0.0.1:${port}/v1/health/ready`)).status).toBe(404);
    } finally {
      await withPort.close();
    }
    // Closed with the app.
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });
});

describe('request counters', () => {
  let s: Shop;
  let sessionId: string;

  beforeAll(async () => {
    s = await shop('mon');
    sessionId = (await http().post('/v1/cashier-sessions').set(s.cashier).send({ registerId: s.registerId, openingFloat: '1000.00' }).expect(201)).body.id;
  });

  const sale = (lines = [{ variantId: s.cola, quantity: '1' }]) => ({
    cashierSessionId: sessionId,
    clientTransactionId: randomUUID(),
    lines,
    tenders: [{ method: 'CASH', tendered: '100.00' }],
  });

  it('counts checkouts by outcome, replays and duplicates apart, and times them', async () => {
    const before = {
      recorded: metrics.checkouts.get({ channel: 'retail', outcome: 'recorded' }),
      replayed: metrics.checkouts.get({ channel: 'retail', outcome: 'replayed' }),
      refused: metrics.checkouts.get({ channel: 'retail', outcome: 'refused' }),
      timed: metrics.checkoutDuration.count({ channel: 'retail' }),
      idemReplayed: metrics.idempotency.get({ outcome: 'replayed' }),
      reused: metrics.idempotency.get({ outcome: 'key_reused' }),
      duplicate: metrics.idempotency.get({ outcome: 'duplicate_transaction' }),
    };
    const key = randomUUID();
    const body = sale();
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', key).send(body).expect(201);
    const again = await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', key).send(body).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    // Same key, another body: refused as a client defect.
    await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', key).send(sale()).expect(422);
    // Same client transaction under a new key: the sale exists already.
    const dup = await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID()).send(body);
    expect(dup.body.error.code).toBe('DUPLICATE_TRANSACTION');

    expect(metrics.checkouts.get({ channel: 'retail', outcome: 'recorded' })).toBe(before.recorded + 1);
    expect(metrics.checkouts.get({ channel: 'retail', outcome: 'replayed' })).toBe(before.replayed + 1);
    expect(metrics.checkouts.get({ channel: 'retail', outcome: 'refused' })).toBe(before.refused + 2);
    expect(metrics.checkoutDuration.count({ channel: 'retail' })).toBe(before.timed + 3); // replays are not timed
    expect(metrics.idempotency.get({ outcome: 'replayed' })).toBe(before.idemReplayed + 1);
    expect(metrics.idempotency.get({ outcome: 'key_reused' })).toBe(before.reused + 1);
    expect(metrics.idempotency.get({ outcome: 'duplicate_transaction' })).toBe(before.duplicate + 1);
  });

  it('labels routes by template, so ids and query strings never become label values', async () => {
    const sold = await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID()).send(sale()).expect(201);
    const before = metrics.httpRequests.get({ method: 'GET', route: '/v1/sales/:id', status: '200' });
    await http().get(`/v1/sales/${sold.body.id}`).query({ x: 'secret-ish' }).set(s.manager).expect(200);
    await http().get(`/v1/no-such-thing/${sold.body.id}`).set(s.manager).expect(404);
    expect(metrics.httpRequests.get({ method: 'GET', route: '/v1/sales/:id', status: '200' })).toBe(before + 1);
    expect(metrics.httpRequests.get({ method: 'GET', route: 'unmatched', status: '404' })).toBeGreaterThanOrEqual(1);
    const text = await scrape();
    for (const leak of [sold.body.id, 'secret-ish', s.t.tenantId, s.t.email]) expect(text).not.toContain(leak);
  });

  it('counts refused returns by code', async () => {
    const sold = await http().post('/v1/sales').set(s.cashier).set('Idempotency-Key', randomUUID()).send(sale()).expect(201);
    const res = await http()
      .post(`/v1/sales/${sold.body.id}/returns`)
      .set(s.manager)
      .set('Idempotency-Key', randomUUID())
      .send({ cashierSessionId: sessionId, kind: 'RETURN', reason: 'Too many', lines: [{ saleLineId: sold.body.lines[0].id, quantity: '5', disposition: 'RESTOCK' }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(metrics.refundRefusals.get({ code: res.body.error.code })).toBeGreaterThanOrEqual(1);
  });

  it('counts provider outcomes, exports unresolved payments and shifts awaiting approval', async () => {
    const intent = (amount: string) =>
      http().post('/v1/payment-intents').set(s.cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: sessionId, clientTransactionId: randomUUID(), method: 'CARD', amount });
    const out = (step: string, outcome: string) => metrics.payments.get({ provider: 'dev', step, outcome });
    const before = { ok: out('authorize', 'succeeded'), declined: out('authorize', 'failed'), unknown: out('authorize', 'unknown'), rec: out('reconcile', 'failed') };
    const unknownBefore = sample(await scrape(), 'onepos_payment_intents_unresolved{status="UNKNOWN"}')!;

    const ok = (await intent('10.00').expect(201)).body;
    expect((await intent('10.51').expect(201)).body.status).toBe('FAILED'); // dev provider: declined
    const hung = (await intent('10.53').expect(201)).body; // dev provider: never answers
    expect(hung.status).toBe('UNKNOWN');
    expect(out('authorize', 'succeeded')).toBe(before.ok + 1);
    expect(out('authorize', 'failed')).toBe(before.declined + 1);
    expect(out('authorize', 'unknown')).toBe(before.unknown + 1);

    let text = await scrape();
    expect(sample(text, 'onepos_payment_intents_unresolved{status="UNKNOWN"}')).toBe(unknownBefore + 1);
    expect(sample(text, 'onepos_payment_intents_unresolved_oldest_age_seconds')).toBeGreaterThan(0);

    // Settle both, then close the shift short by 5.00: it waits for a manager's approval.
    await new Promise((r) => setTimeout(r, 700)); // reconcile is allowed after 2 × the provider timeout
    expect((await http().post(`/v1/payment-intents/${hung.id}/reconcile`).set(s.cashier).expect(200)).body.status).toBe('FAILED');
    expect(out('reconcile', 'failed')).toBe(before.rec + 1);
    await http().post(`/v1/payment-intents/${ok.id}/cancel`).set(s.cashier).expect(200);
    const awaitingBefore = sample(text, 'onepos_cashier_sessions_awaiting_approval')!;
    const closed = await http().post(`/v1/cashier-sessions/${sessionId}/close`).set(s.cashier).send({ countedCash: '1000.00' }).expect(200);
    expect(closed.body.status).toBe('CLOSED');
    text = await scrape();
    expect(sample(text, 'onepos_payment_intents_unresolved{status="UNKNOWN"}')).toBe(unknownBefore);
    expect(sample(text, 'onepos_cashier_sessions_awaiting_approval')).toBe(awaitingBefore + 1);
    expect(sample(text, 'onepos_cashier_sessions_awaiting_approval_oldest_age_seconds')).toBeGreaterThan(0);
  });

  it('counts sign-ups by outcome', async () => {
    const ok = metrics.provisioning.get({ outcome: 'ok' });
    const refused = metrics.provisioning.get({ outcome: 'refused' });
    await signup(app, 'monprov');
    await http().post('/v1/auth/signup').send({}).expect(400);
    expect(metrics.provisioning.get({ outcome: 'ok' })).toBe(ok + 1);
    expect(metrics.provisioning.get({ outcome: 'refused' })).toBe(refused + 1);
  });
});

describe('business gauges', () => {
  it('equal independent counts, as fixed label sets with no tenant data', async () => {
    const text = await scrape();
    expect(sample(text, 'onepos_db_up')).toBe(1);
    for (const status of ['PENDING', 'PROCESSING', 'DEAD']) {
      expect([status, sample(text, `onepos_outbox_events{status="${status}"}`)]).toEqual([
        status,
        await platformCount('SELECT count(*) AS n FROM outbox_events WHERE status = $1', [status]),
      ]);
    }
    expect(sample(text, 'onepos_offline_sales_quarantined')).toBe(await platformCount("SELECT count(*) AS n FROM terminal_transactions WHERE status = 'QUARANTINED'"));
    expect(sample(text, 'onepos_cashier_sessions_awaiting_approval')).toBe(await platformCount("SELECT count(*) AS n FROM cashier_sessions WHERE status = 'CLOSED'"));

    // Every business gauge is exported, and its only label values are statuses.
    for (const [name, def] of Object.entries(BUSINESS_GAUGES)) {
      const lines = text.split('\n').filter((l) => l.startsWith(`onepos_${name}{`) || l.startsWith(`onepos_${name} `));
      expect([name, lines.length > 0]).toEqual([name, true]);
      for (const l of lines) {
        const labels = l.match(/\{(.*)\}/)?.[1];
        if ('label' in def) expect(labels).toMatch(/^status="(PENDING|PROCESSING|DEAD|UNKNOWN)"$/);
        else expect(labels).toBeUndefined();
      }
    }
  });

  it('are computed by a SECURITY DEFINER function the app may run but cannot change', async () => {
    const { rows: [fn] } = await owner.query(`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
             has_function_privilege('onepos_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('onepos_readonly', p.oid, 'EXECUTE') AS readonly,
             has_function_privilege('onepos_worker', p.oid, 'EXECUTE') AS worker
        FROM pg_proc p WHERE p.proname = 'platform_metrics'`);
    expect(fn).toEqual({ owner: 'onepos_platform', secdef: true, app: true, readonly: false, worker: false });
  });
});

describe('readiness', () => {
  it('checks the database, the migration head and Redis', async () => {
    const res = await http().get('/v1/health/ready').expect(200);
    // Integration tests run without REDIS_URL (setup-env), so Redis is disabled here.
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', migrations: 'up', redis: 'disabled' } });
    expect(sample(await scrape(), 'onepos_schema_migrations_behind')).toBe(0);
  });

  it('a build that expects a newer migration than the database has is not ready', async () => {
    const other = await createApp();
    try {
      const svc = other.get(MonitoringService) as unknown as { expected: { count: number; lastWhen: number } };
      svc.expected = { count: svc.expected.count + 1, lastWhen: Number.MAX_SAFE_INTEGER };
      const res = await request(other.getHttpServer()).get('/v1/health/ready').expect(503);
      expect(res.body.error).toMatchObject({ code: 'NOT_READY', details: { checks: { database: 'up', migrations: 'behind' } } });
      expect(sample(await scrape(other), 'onepos_schema_migrations_behind')).toBeGreaterThanOrEqual(1);
    } finally {
      await other.close();
    }
  });
});

describe('alert rules (infra/monitoring/alerts.yml)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const rulesText = read('../../../../infra/monitoring/alerts.yml');
  const runbook = read('../../../../docs/operations/monitoring.md');
  const rules = [
    ...rulesText.matchAll(
      /- alert: (\w+)\n\s+expr: (.+)\n(?:\s+for: \d+[smh]\n)?\s+labels:\n\s+severity: (\w+)\n\s+annotations:\n\s+summary: .+\n\s+runbook_url: docs\/operations\/monitoring\.md#([\w-]+)\n/g,
    ),
  ].map(([, name, expr, severity, anchor]) => ({ name: name!, expr: expr!, severity: severity!, anchor: anchor! }));

  it('every rule has the expected shape, a unique name and a known severity', () => {
    expect(rules.length).toBe(rulesText.match(/- alert: /g)!.length);
    expect(rules.length).toBeGreaterThanOrEqual(20);
    expect(new Set(rules.map((r) => r.name)).size).toBe(rules.length);
    for (const r of rules) expect([r.name, ['critical', 'warning', 'info'].includes(r.severity)]).toEqual([r.name, true]);
  });

  it('every metric a rule names is exported by the API (onepos_worker_*: apps/workers alerts test)', async () => {
    const exported = new Set([...metrics.registry.names(), 'up' /* Prometheus' own scrape-health series */]);
    const missing: string[] = [];
    for (const r of rules) {
      for (const [m] of r.expr.matchAll(/\b(?:onepos|nodejs|process)_[a-z0-9_]+\b|\bup(?=\{)/g)) {
        if (m.startsWith('onepos_worker_') && m !== 'onepos_worker_heartbeat_age_seconds') continue;
        if (!exported.has(m) && !exported.has(m.replace(/_(bucket|sum|count)$/, ''))) missing.push(`${r.name}: ${m}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every rule links to a section of the monitoring runbook', () => {
    const slug = (h: string) => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const anchors = new Set([...runbook.matchAll(/^#{2,4} (.+)$/gm)].map(([, h]) => slug(h!)));
    expect(rules.filter((r) => !anchors.has(r.anchor)).map((r) => `${r.name} → #${r.anchor}`)).toEqual([]);
  });
});
