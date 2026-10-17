import type { INestApplication } from '@nestjs/common';
import { httpTransport, LocalStore, OfflineEngine } from '@1pos/pos-offline';
import { nodeSqliteDriver } from '@1pos/pos-offline/node-sqlite';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Phase 5 exit criterion drills (ADR-0015): the real offline engine (SQLite file) against the real API
 * over HTTP. Outages, restarts, lost answers, a database that is down, prices that move, a shift closed
 * elsewhere and a revoked terminal: every sale rung up offline ends up recorded exactly once or in front
 * of a manager — never lost, never twice.
 */
let app: INestApplication;
let down: INestApplication;
let owner: pg.Pool;
let base: string;
let downBase: string;
const http = () => request(app.getHttpServer());
const urlOf = (a: INestApplication) => `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`;

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  // The same API with its database unreachable: every terminal call answers 503.
  down = await createApp({ DATABASE_URL: 'postgres://onepos_app:x@127.0.0.1:1/onepos_test' });
  await down.listen(0, '127.0.0.1');
  owner = ownerPool();
  base = urlOf(app);
  downBase = urlOf(down);
});

afterAll(async () => {
  await app.close();
  await down.close();
  await owner.end();
});

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201);
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le.body.id, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const registerId = (await http().post('/v1/registers').set(auth).send({ branchId, code: 'R1', name: 'Front' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const cola = (await http().post('/v1/products').set(auth).send({ name: 'Cola', uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '22.40' }] }).expect(201)).body.variants[0].id as string;
  await http().post('/v1/stock/adjustments').set(auth).send({ branchId, reason: 'Opening', items: [{ variantId: cola, quantity: '500', unitCost: '15.00' }] }).expect(201);
  const reg = (await http().post('/v1/terminals').set(auth).send({ registerId, name: 'Till 1' }).expect(201)).body;
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  const cashier = bearer(await loginToken(app, c.email));
  const m = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: branchId });
  const manager = bearer(await loginToken(app, m.email));
  const session = (await http().post('/v1/cashier-sessions').set(cashier).send({ registerId, openingFloat: '1000.00' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, auth, cola, cashier, cashierId: c.userId, manager, session, terminalId: reg.terminal.id as string, credential: reg.credential as string };
}
type S = Awaited<ReturnType<typeof shop>>;

/** A network the drill controls: up, down (no connection), or losing every answer after the server acted. */
function network() {
  const state = { mode: 'up' as 'up' | 'down' | 'lose', requests: 0 };
  const f: typeof fetch = async (input, init) => {
    state.requests += 1;
    if (state.mode === 'down') throw new TypeError('fetch failed: connect ECONNREFUSED');
    const res = await fetch(input, init);
    if (state.mode === 'lose') {
      await res.arrayBuffer();
      throw new TypeError('fetch failed: socket hang up'); // the server committed; the till never hears
    }
    return res;
  };
  return { state, fetch: f };
}

/** A till: its own SQLite file, the engine, and a clock that moves only when the drill says so. */
async function till(s: S, path: string, net: ReturnType<typeof network>, baseUrl = base) {
  const driver = nodeSqliteDriver(path);
  const clock = { t: Date.now() };
  const engine = new OfflineEngine({
    store: new LocalStore(driver),
    transport: httpTransport({ baseUrl, terminalId: s.terminalId, credential: s.credential, fetch: net.fetch, timeoutMs: 10_000 }),
    now: () => clock.t,
    baseBackoffMs: 1_000,
  });
  await engine.open();
  return { engine, driver, clock };
}
const file = () => join(mkdtempSync(join(tmpdir(), '1pos-till-')), 'till.db');
const sql = <T = Record<string, unknown>>(s: S, q: string, params: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, params)).rows as T[]);
const ring = (e: OfflineEngine, s: S, qty = '1', tendered = '100') => e.ringUp({ cashierUserId: s.cashierId, lines: [{ variantId: s.cola, quantity: qty }], tendered });

describe('an outage', () => {
  it('sales rung up while the network is down survive a restart and are recorded once, in order, on the day they happened', async () => {
    const s = await shop('drill-outage');
    const net = network();
    const path = file();
    let t = await till(s, path, net);
    await t.engine.refreshSnapshot(); // online at the start of the shift
    net.state.mode = 'down';
    // Device times inside the shift as the server's clock sees it (the host clock may run ahead of the DB's).
    t.clock.t = Date.parse((await http().get(`/v1/cashier-sessions/${s.session}`).set(s.cashier).expect(200)).body.openedAt) + 1;
    const rung = [];
    for (const q of ['1', '2', '3']) {
      rung.push((await ring(t.engine, s, q)).sale);
      t.clock.t += 1;
    }
    expect((await t.engine.syncOnce()).error).toMatchObject({ code: 'NETWORK', retryable: true });
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 0 }]);

    // The till is switched off and on again during the outage.
    await t.driver.close();
    t = await till(s, path, net);
    t.clock.t = Date.now() + 10 * 60_000; // well past the backoff
    expect(await t.engine.status()).toMatchObject({ pending: 3 });
    net.state.mode = 'up';
    const reports = await t.engine.drain();
    expect(reports.flatMap((r) => r.results).map((r) => [r.deviceSeq, r.status, r.status === 'RECORDED' && r.saleNumber])).toEqual([[1, 'RECORDED', 1], [2, 'RECORDED', 2], [3, 'RECORDED', 3]]);
    expect(await t.engine.status()).toMatchObject({ pending: 0, recorded: 3, lastError: null });

    // The server holds exactly these three, at the device's times, in its drawer and stock.
    const rows = await sql<{ offline_reference: string; completed_at: Date; amount_due: string }>(s, `SELECT offline_reference, completed_at, amount_due::text FROM sales ORDER BY sale_number`);
    expect(rows.map((r) => [r.offline_reference, r.completed_at.toISOString(), r.amount_due])).toEqual(
      rung.map((q, i) => [q.envelope.localReference, q.envelope.occurredAt, ['22.4000', '44.8000', '67.2000'][i]]),
    );
    expect((await http().get(`/v1/cashier-sessions/${s.session}`).set(s.cashier).expect(200)).body.expectedCash).toBe('1134.40');
    expect(await sql(s, `SELECT quantity::text AS q FROM stock_balances`)).toEqual([{ q: '494.0000' }]);
    await t.driver.close();
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('answers lost after the server recorded, and a database that is down: retried with the same ids until answered, never recorded twice', async () => {
    const s = await shop('drill-lost');
    const net = network();
    const path = file();
    const t = await till(s, path, net);
    await t.engine.refreshSnapshot();
    const sales = [(await ring(t.engine, s)).sale, (await ring(t.engine, s)).sale];

    net.state.mode = 'lose';
    expect((await t.engine.syncOnce()).error?.code).toBe('NETWORK');
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 2 }]); // recorded, but the till does not know
    expect(await t.engine.status()).toMatchObject({ pending: 2 });

    // Next attempt goes to a server whose database is down: 503, retryable, nothing changes.
    const outage = await till(s, path, net, downBase);
    net.state.mode = 'up';
    outage.clock.t = t.clock.t + 5_000;
    const unavailable = await outage.engine.syncOnce();
    expect(unavailable.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    await outage.driver.close();

    // Back to normal: the same envelopes replay their recorded sales.
    t.clock.t += 60_000;
    const answered = await t.engine.syncOnce();
    expect(answered.results.map((r) => [r.terminalTxnId, r.status, r.replayed])).toEqual(sales.map((q) => [q.terminalTxnId, 'RECORDED', true]));
    expect(await sql(s, `SELECT count(*)::int AS n FROM sales`)).toEqual([{ n: 2 }]);
    expect(await sql(s, `SELECT count(*)::int AS n FROM terminal_transactions`)).toEqual([{ n: 2 }]);
    const [q] = await t.engine['store'].list();
    expect(q!.attempts).toBe(2); // lost, 503, then answered
    await t.driver.close();
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });

  it('a long outage drains in batches of fifty, oldest first', async () => {
    const s = await shop('drill-long');
    const net = network();
    const t = await till(s, file(), net);
    await t.engine.refreshSnapshot();
    net.state.mode = 'down';
    for (let i = 0; i < 120; i++) await ring(t.engine, s, '1', '22.40');
    net.state.mode = 'up';
    const reports = await t.engine.drain();
    expect(reports.map((r) => r.sent)).toEqual([50, 50, 20, 0]);
    const numbers = reports.flatMap((r) => r.results).map((r) => (r.status === 'RECORDED' ? r.saleNumber : 0));
    expect(numbers).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect((await http().get(`/v1/cashier-sessions/${s.session}`).set(s.cashier).expect(200)).body.expectedCash).toBe('3688.00');
    await t.driver.close();
  });
});

describe('the world moved while the till was offline', () => {
  it('a price rise is flagged and the sale stands at the price charged; a shift closed elsewhere quarantines for a manager; a revoked till stops', async () => {
    const s = await shop('drill-moved');
    const net = network();
    const t = await till(s, file(), net);
    await t.engine.refreshSnapshot();
    net.state.mode = 'down';
    // Dated by the server's clock, well before the rise below (the host clock may run ahead of the DB's).
    t.clock.t = Date.parse((await http().get(`/v1/cashier-sessions/${s.session}`).set(s.cashier).expect(200)).body.openedAt) + 1;
    const before = (await ring(t.engine, s)).sale;
    const lists = (await http().get('/v1/price-lists').set(s.auth).expect(200)).body.data;
    await http().post(`/v1/price-lists/${lists[0].id}/prices`).set(s.auth).send({ items: [{ variantId: s.cola, amount: '25.00' }] });
    t.clock.t = Date.now() + 2_000;
    const after = (await ring(t.engine, s)).sale; // the till still sells at ₱22.40
    expect(after.envelope.amountDue).toBe('22.40');
    net.state.mode = 'up';
    const r = (await t.engine.syncOnce()).results;
    expect(r.map((x) => [x.status, x.status === 'RECORDED' && x.flags])).toEqual([['RECORDED', []], ['RECORDED', ['PRICE_CHANGED']]]);
    expect(before.deviceSeq).toBe(1);

    // The cashier closes the shift from another device while this till is offline with one more sale.
    net.state.mode = 'down';
    const third = (await ring(t.engine, s)).sale;
    await http().post(`/v1/cashier-sessions/${s.session}/close`).set(s.cashier).send({ countedCash: '1044.80' }).expect(200);
    net.state.mode = 'up';
    t.clock.t += 60_000;
    const late = (await t.engine.syncOnce()).results[0]!;
    expect(late).toMatchObject({ status: 'QUARANTINED', code: 'SESSION_NOT_OPEN' });
    expect(await t.engine.status()).toMatchObject({ pending: 0, needsReview: 1 });
    const review = (await http().get('/v1/sync/transactions?status=QUARANTINED').set(s.manager).expect(200)).body.data;
    expect(review.map((x: { localReference: string; amountDue: string }) => [x.localReference, x.amountDue])).toEqual([[third.envelope.localReference, '22.40']]);

    // The terminal is revoked (stolen): the next sync is refused and the till stops selling.
    await http().post(`/v1/terminals/${s.terminalId}/revoke`).set(s.auth).send({ reason: 'Stolen' }).expect(200);
    await expect(t.engine.refreshSnapshot()).rejects.toMatchObject({ status: 401, code: 'TERMINAL_REVOKED' });
    expect(await t.engine.status()).toMatchObject({ authState: 'REVOKED' });
    await expect(ring(t.engine, s)).rejects.toMatchObject({ code: 'TERMINAL_REVOKED' });
    await t.driver.close();
    expect(await asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
  });
});
