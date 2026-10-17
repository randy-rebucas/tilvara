import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabasePool } from '../../src/infrastructure/database.provider.js';
import { DevPaymentProvider } from '../../src/payments/provider.js';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Phase 2 exit review — failure drills. A checkout must reconcile when the API restarts, the
 * database connection dies mid-transaction or is unreachable, the payment provider times out,
 * or the counter submits twice: never two sales, never half a sale, never an orphan charge.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = (a: INestApplication = app) => request(a.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp({ PAYMENT_TIMEOUT_MS: 400 });
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

interface Counter {
  tenantId: string;
  branchId: string;
  cola: string;
  cashier: Auth;
  manager: Auth;
  sessionId: string;
}

async function counter(prefix: string): Promise<Counter> {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const br = await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201);
  const reg = await http().post('/v1/registers').set(auth).send({ branchId: br.body.id, code: 'R1', name: 'Counter 1' }).expect(201);
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const cola = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '22.40' }] }).expect(201)).body.variants[0].id;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: br.body.id });
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: br.body.id });
  const cashier = bearer(await loginToken(app, c.email));
  const manager = bearer(await loginToken(app, m.email));
  await http().post('/v1/stock/adjustments').set(manager).set('Idempotency-Key', randomUUID()).send({ branchId: br.body.id, reason: 'Opening', items: [{ variantId: cola, quantity: '10' }] }).expect(201);
  const session = await http().post('/v1/cashier-sessions').set(cashier).send({ registerId: reg.body.id, openingFloat: '1000.00' }).expect(201);
  return { tenantId: t.tenantId, branchId: br.body.id, cola, cashier, manager, sessionId: session.body.id };
}

const checkout = (c: Counter, extra: Record<string, unknown> = {}) => ({
  cashierSessionId: c.sessionId,
  clientTransactionId: randomUUID(),
  lines: [{ variantId: c.cola, quantity: '1' }],
  tenders: [{ method: 'CASH', tendered: '50.00' }],
  expectedAmountDue: '22.40',
  ...extra,
});
const post = (c: Counter, body: object, key: string, a: INestApplication = app) => http(a).post('/v1/sales').set(c.cashier).set('Idempotency-Key', key).send(body);

/** Everything a sale writes, so a drill can show "nothing" or "exactly once". */
async function footprint(c: Counter) {
  return asOwnerInTenant(owner, c.tenantId, async (q) => {
    const n = async (sql: string) => Number((await q.query(sql)).rows[0].n);
    return {
      sales: await n(`SELECT count(*) AS n FROM sales`),
      lines: await n(`SELECT count(*) AS n FROM sale_lines`),
      tenders: await n(`SELECT count(*) AS n FROM sale_tenders`),
      cash: await n(`SELECT count(*) AS n FROM cash_movements WHERE type = 'SALE'`),
      stock: await n(`SELECT coalesce(sum(quantity), 0) AS n FROM stock_balances`),
      numbers: await n(`SELECT coalesce(sum(next_value - 1), 0) AS n FROM sequence_counters WHERE name = 'SALE'`),
      keys: await n(`SELECT count(*) AS n FROM idempotency_records WHERE scope = 'POST /v1/sales'`),
      // The sale's journal entry commits with it or not at all (ADR-0013).
      entries: await n(`SELECT count(*) AS n FROM journal_entries WHERE source_type = 'SALE'`),
    };
  });
}
const NOTHING = { sales: 0, lines: 0, tenders: 0, cash: 0, stock: 10, numbers: 0, keys: 0, entries: 0 };
const ONCE = { sales: 1, lines: 1, tenders: 1, cash: 1, stock: 9, numbers: 1, keys: 1, entries: 1 };

describe('API restart', () => {
  it('a sale committed just before the API went down is replayed by the restarted API, never sold again', async () => {
    const c = await counter('drill-restart');
    const first = await createApp();
    const body = checkout(c);
    const key = randomUUID();
    const sold = await post(c, body, key, first).expect(201);
    await first.close(); // the response is "lost" with the process; the counter retries elsewhere
    const replay = await post(c, body, key).expect(201);
    expect([replay.body.id, replay.headers['idempotent-replayed']]).toEqual([sold.body.id, 'true']);
    // A counter that lost its key too (e.g. reloaded) resubmits the same transaction id: it is pointed at the recorded sale.
    const again = await post(c, body, randomUUID()).expect(409);
    expect(again.body.error).toMatchObject({ code: 'DUPLICATE_TRANSACTION', details: { saleId: sold.body.id, saleNumber: 1 } });
    await http().get(`/v1/sales/${sold.body.id}/receipt`).set(c.cashier).expect(200);
    expect(await footprint(c)).toEqual(ONCE);
  });
});

describe('database failures', () => {
  it('connection killed mid-checkout: 503, nothing written, the same key then sells exactly once', async () => {
    const c = await counter('drill-kill');
    const body = checkout(c);
    const key = randomUUID();
    // Hold the session row so the checkout transaction is provably in flight, then kill its connection.
    const blocker = await owner.connect();
    const killer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await killer.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [c.tenantId]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM cashier_sessions WHERE id = $1 FOR UPDATE', [c.sessionId]);
      const pending = post(c, body, key).then((r) => r);
      let victim: number | undefined;
      for (let i = 0; i < 100 && !victim; i++) {
        victim = (await killer.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blockerPid])).rows[0]?.pid;
        if (!victim) await new Promise((r) => setTimeout(r, 50));
      }
      expect(victim).toBeDefined();
      expect((await killer.query('SELECT pg_terminate_backend($1) AS ok', [victim])).rows[0].ok).toBe(true);
      const res = await pending;
      expect([res.status, res.body.error?.code, res.headers['retry-after']]).toEqual([503, 'SERVICE_UNAVAILABLE', '2']);
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
      await killer.end();
    }
    expect(await footprint(c)).toEqual(NOTHING);
    const retry = await post(c, body, key).expect(201);
    expect(retry.body.saleNumber).toBe(1);
    expect(await footprint(c)).toEqual(ONCE);
  });

  it('database unreachable: quote, payment and sale answer 503 with nothing written; the same key works once it is back', async () => {
    const c = await counter('drill-down');
    const down = await createApp({ DATABASE_URL: 'postgres://onepos_app:x@127.0.0.1:1/onepos_test' });
    try {
      const body = checkout(c);
      const key = randomUUID();
      const quote = await http(down).post('/v1/tax/quote').set(c.cashier).send({ branchId: c.branchId, lines: body.lines });
      const pay = await http(down).post('/v1/payment-intents').set(c.cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: c.sessionId, clientTransactionId: randomUUID(), method: 'CARD', amount: '22.40' });
      const sale = await post(c, body, key, down);
      for (const r of [quote, pay, sale]) expect([r.status, r.body.error?.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
      expect(await footprint(c)).toEqual(NOTHING);
      expect(await asOwnerInTenant(owner, c.tenantId, async (q) => Number((await q.query('SELECT count(*) AS n FROM payment_intents')).rows[0].n))).toBe(0);
      await post(c, body, key).expect(201);
      expect(await footprint(c)).toEqual(ONCE);
    } finally {
      await down.close();
    }
  });

  it('database restart while the API is idle: dropped pool connections are discarded and the next checkout works', async () => {
    const c = await counter('drill-idle');
    const { pool } = app.get(DatabasePool);
    expect(pool.listenerCount('error')).toBeGreaterThan(0); // without it, the dropped idle client crashes the process
    const clients = await Promise.all(Array.from({ length: 3 }, () => pool.connect()));
    const pids = await Promise.all(clients.map(async (cl) => (await cl.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number));
    for (const cl of clients) cl.release();
    const killer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await killer.connect();
    try {
      await killer.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);
    } finally {
      await killer.end();
    }
    await new Promise((r) => setTimeout(r, 200));
    await post(c, checkout(c), randomUUID()).expect(201);
    expect(await footprint(c)).toEqual(ONCE);
  });
});

describe('payment provider failures during checkout', () => {
  const intent = (c: Counter, clientTransactionId: string, amount: string) =>
    http().post('/v1/payment-intents').set(c.cashier).set('Idempotency-Key', randomUUID()).send({ cashierSessionId: c.sessionId, clientTransactionId, method: 'CARD', amount }).expect(201).then((r) => r.body);
  const closeShift = (c: Counter, countedCash: string) => http().post(`/v1/cashier-sessions/${c.sessionId}/close`).set(c.cashier).send({ countedCash });

  it('a provider timeout blocks the sale and the shift close until reconciled; then one charge, one sale, a balanced drawer', async () => {
    const c = await counter('drill-timeout');
    const tx = randomUUID();
    // ₱22.52 in the dev simulator: the provider charges but the answer is lost.
    const p = await intent(c, tx, '22.52');
    expect(p.status).toBe('UNKNOWN');
    const body = { cashierSessionId: c.sessionId, clientTransactionId: tx, lines: [{ variantId: c.cola, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: p.id }] };
    expect((await post(c, body, randomUUID()).expect(409)).body.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
    expect(await footprint(c)).toEqual(NOTHING);

    const blocked = await closeShift(c, '1000.00').expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'PAYMENTS_OUTSTANDING', details: { payments: [{ id: p.id, status: 'UNKNOWN', method: 'CARD', amount: '22.52' }] } });

    const settled = (await http().post(`/v1/payment-intents/${p.id}/reconcile`).set(c.cashier).expect(200)).body;
    expect(settled.status).toBe('SUCCEEDED');
    // Authorized but not yet attached to a sale: still blocks the close.
    expect((await closeShift(c, '1000.00').expect(409)).body.error.details.payments).toMatchObject([{ id: p.id, status: 'SUCCEEDED' }]);
    // 22.52 ≠ 22.40: the over-authorized card cannot pay this cart; the cashier cancels it and takes cash.
    expect((await post(c, body, randomUUID()).expect(422)).body.error.code).toBe('OVERPAYMENT');
    await http().post(`/v1/payment-intents/${p.id}/cancel`).set(c.cashier).expect(200);
    await post(c, { ...body, tenders: [{ method: 'CASH', tendered: '22.40' }] }, randomUUID()).expect(201);
    expect(app.get(DevPaymentProvider).chargeCount(p.id)).toBe(1);
    expect((await closeShift(c, '1022.40').expect(200)).body).toMatchObject({ status: 'RECONCILED' });
  });

  it('the database itself refuses a close with a charge in no sale, and a new charge on a closed shift', async () => {
    const c = await counter('drill-dbguard');
    const p = await intent(c, randomUUID(), '22.52'); // UNKNOWN in the dev simulator
    // As the runtime role, past the service's check; always rolled back.
    const asApp = async (sql: string, params: unknown[]) => {
      const cl = await app.get(DatabasePool).pool.connect();
      try {
        await cl.query('BEGIN');
        await cl.query("SELECT set_config('app.tenant_id', $1, true)", [c.tenantId]);
        await cl.query(sql, params);
        return null;
      } catch (e) {
        return (e as { constraint?: string }).constraint ?? String(e);
      } finally {
        await cl.query('ROLLBACK').catch(() => undefined);
        cl.release();
      }
    };
    const close = `UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), closed_by = opened_by WHERE id = $1`;
    expect(await asApp(close, [c.sessionId])).toBe('payments_outstanding');

    await http().post(`/v1/payment-intents/${p.id}/reconcile`).set(c.cashier).expect(200);
    expect(await asApp(close, [c.sessionId])).toBe('payments_outstanding'); // SUCCEEDED, in no sale
    await http().post(`/v1/payment-intents/${p.id}/cancel`).set(c.cashier).expect(200);
    expect(await asApp(close, [c.sessionId])).toBeNull();

    expect((await closeShift(c, '1000.00').expect(200)).body).toMatchObject({ status: 'RECONCILED' });
    const late = `INSERT INTO payment_intents (tenant_id, branch_id, register_id, cashier_session_id, client_transaction_id, request_key, provider, method, amount, currency, created_by)
                  SELECT tenant_id, branch_id, register_id, cashier_session_id, 'late', uuidv7(), provider, method, amount, currency, created_by FROM payment_intents WHERE id = $1`;
    expect(await asApp(late, [p.id])).toBe('session_not_open');
  });

  it('an authorized card whose sale failed keeps the shift open until the sale is retried', async () => {
    const c = await counter('drill-orphan');
    const tx = randomUUID();
    const p = await intent(c, tx, '22.40');
    expect(p.status).toBe('SUCCEEDED');
    const body = { cashierSessionId: c.sessionId, clientTransactionId: tx, lines: [{ variantId: c.cola, quantity: '1' }], tenders: [{ method: 'INTENT', paymentIntentId: p.id }] };
    // The sale fails after the card went through (the counter showed a stale total).
    await post(c, { ...body, expectedAmountDue: '20.00' }, randomUUID()).expect(409);
    expect(await footprint(c)).toEqual(NOTHING);
    await closeShift(c, '1000.00').expect(409);
    const sold = await post(c, body, randomUUID()).expect(201);
    expect(sold.body.tenders).toMatchObject([{ method: 'CARD', amount: '22.40', paymentIntentId: p.id }]);
    expect((await closeShift(c, '1000.00').expect(200)).body).toMatchObject({ status: 'RECONCILED', reconciliation: { variance: '0.00' } });
  });

  it('a request the provider never received settles as FAILED and does not block the close', async () => {
    const c = await counter('drill-never');
    const p = await intent(c, randomUUID(), '22.53');
    expect(p.status).toBe('UNKNOWN');
    await closeShift(c, '1000.00').expect(409);
    expect((await http().post(`/v1/payment-intents/${p.id}/reconcile`).set(c.cashier).expect(200)).body.status).toBe('FAILED');
    expect(app.get(DevPaymentProvider).chargeCount(p.id)).toBe(0);
    await closeShift(c, '1000.00').expect(200);
  });
});

describe('duplicate submits from the counter', () => {
  it('double-click (same key, concurrent), retry after a lost answer (same key) and resubmit under a new key: one sale', async () => {
    const c = await counter('drill-dup');
    const body = checkout(c);
    const key = randomUUID();
    const burst = await Promise.all([post(c, body, key), post(c, body, key), post(c, body, key)]);
    const ids = new Set(burst.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    for (const r of burst) expect([201, 409]).toContain(r.status);
    const [id] = [...ids];
    expect((await post(c, body, key).expect(201)).body.id).toBe(id);
    const fresh = await post(c, body, randomUUID()).expect(409);
    expect(fresh.body.error.details).toMatchObject({ saleId: id });
    expect(await footprint(c)).toEqual(ONCE);
  });
});
