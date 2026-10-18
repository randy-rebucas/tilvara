/**
 * Load harness (ADR-0016 slice 5). Needs `pnpm load:seed` first and `pnpm build`.
 *
 *   pnpm load:run [--duration 120] [--busy 60] [--rate 30] [--tills 6] [--retry 0.05]
 *
 * Starts the built API on onepos_load and, at once:
 * - `busy` registers (spread over the businesses), each a cashier ringing up `rate` sales a minute:
 *   lookup every item by barcode → quote the cart → checkout with an Idempotency-Key. A share
 *   (`retry`) of checkouts is sent twice with the same key, as a till does after a lost answer,
 *   and must replay the same sale;
 * - `tills` desktop tills (the real @1pos/pos-offline engine over HTTP), each fetching a snapshot,
 *   ringing up 50 sales offline, then syncing them;
 * then reports for 31 days at every branch of the busiest businesses.
 * Afterwards it counts in the database: every recorded checkout exactly once, no duplicate client
 * transaction, no sale missing. Prints p50/p95/p99 per operation against the ADR targets, and writes
 * .load/onepos_load.run-<time>.json. The numbers are for THIS machine and this dataset only.
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { adminUrl, client, cpuProfiler, HttpError, PASSWORD, ROOT, SEED_FILE, startApi, summarize, type SeedFile } from './common.js';

const { values } = parseArgs({
  options: {
    duration: { type: 'string', default: '120' },
    warmup: { type: 'string', default: '15' },
    busy: { type: 'string', default: '60' },
    rate: { type: 'string', default: '30' },
    tills: { type: 'string', default: '6' },
    retry: { type: 'string', default: '0.05' },
    instances: { type: 'string', default: '1' },
    profile: { type: 'boolean', default: false },
  },
});
const DURATION_MS = Number(values.duration) * 1000;
/** Samples from the first seconds after the API starts (cold JIT, new pool connections) are discarded. */
const WARMUP_MS = Math.min(Number(values.warmup) * 1000, DURATION_MS / 2);
const RATE = Number(values.rate);
const RETRY = Number(values.retry);
const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as SeedFile;

/** ADR-0016 slice 5 targets (a hypothesis until the pilot measures them). */
const TARGETS: Record<string, { p95?: number; p99?: number; max?: number }> = {
  lookup: { p95: 150 },
  checkout: { p95: 500, p99: 1000 },
  sync50: { max: 5000 },
  report31d: { max: 3000 },
};

const samples: Record<string, number[]> = {};
const errors: Record<string, Record<string, number>> = {};
const slow: { atS: number; op: string; ms: number }[] = [];
let warmUntil = Infinity; // set when selling starts
const timed = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  try {
    const r = await fn();
    const ms = performance.now() - start;
    if (start >= warmUntil) (samples[op] ??= []).push(ms);
    // When the tail happens tells whether it is one stall for everyone or slow requests of one kind.
    if (ms > 1000 && slow.length < 200) slow.push({ atS: Math.round((start - t0) / 100) / 10, op, ms: Math.round(ms) });
    return r;
  } catch (e) {
    const code = e instanceof HttpError ? `${e.status} ${(e.body as { error?: { code?: string } })?.error?.code ?? ''}`.trim() : (e as Error).message.slice(0, 80);
    (errors[op] ??= {})[code] = (errors[op]![code] ?? 0) + 1;
    throw e;
  }
};
const t0 = performance.now();
const log = (m: string) => console.log(`[load ${((performance.now() - t0) / 1000).toFixed(0).padStart(5)} s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = new Date();
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// `instances` API processes on the same database, as replicas behind a load balancer would be:
// each register talks to one of them (round-robin), like a sticky connection.
const INSTANCES = Number(values.instances);
const inspectPort = values.profile ? 9300 + Math.floor(Math.random() * 500) : 0;
const apis = await Promise.all(Array.from({ length: INSTANCES }, (_, i) => startApi({}, i === 0 && inspectPort ? [`--inspect=127.0.0.1:${inspectPort}`] : [])));
const api = apis[0]!;
const call = client(api.base);
const profiler = inspectPort ? await cpuProfiler(inspectPort) : null;

// Stalls on either side distort latencies: the harness's own event loop (the tills' SQLite is
// synchronous), and the APIs' (scraped from their metrics ports every 2 s, worst p99 kept).
const harnessLoop = monitorEventLoopDelay({ resolution: 10 });
harnessLoop.enable();
const apiLoop = { worstP99Ms: 0, poolWaitingMax: 0 };
const scraper = setInterval(() => {
  for (const a of apis) {
    void fetch(`http://127.0.0.1:${a.metricsPort}/metrics`).then((r) => r.text(), () => '').then((text) => {
      const lag = Number(/^nodejs_eventloop_lag_p99_seconds (\S+)/m.exec(text)?.[1] ?? 0) * 1000;
      const waiting = Number(/^onepos_db_pool_connections\{state="waiting"\} (\S+)/m.exec(text)?.[1] ?? 0);
      apiLoop.worstP99Ms = Math.max(apiLoop.worstP99Ms, Math.round(lag));
      apiLoop.poolWaitingMax = Math.max(apiLoop.poolWaitingMax, waiting);
    });
  }
}, 2000);
log(`${INSTANCES} API instance(s) on onepos_load (${seed.tenants.length} businesses, ${seed.scale.items} items each)`);

const recorded = new Map<string, { saleId: string; tenantId: string }>(); // clientTransactionId → sale
let replays = 0;
let replayMismatches = 0;
let tillSales = 0;
const tillAttempts: number[] = [];
let cpu: unknown = null;
// The window starts by the DB clock (sales are stamped by it; the host clock may differ).
const startedAt = await (async () => {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  const { rows: [r] } = await c.query<{ now: Date }>('SELECT now()');
  await c.end();
  return r!.now;
})();

try {
  // ---- sign in, one shift per busy register (reused if a previous run left it open)
  const owners = await Promise.all(
    seed.tenants.map(async (t) => ({ t, token: (await call('POST', '/v1/auth/login', null, { email: t.email, password: PASSWORD, tenantId: t.tenantId })).tokens.accessToken as string })),
  );
  const allRegisters = owners.flatMap((o) => o.t.branches.flatMap((b) => b.registers.map((registerId) => ({ ...o, branchId: b.id, registerId }))));
  // Spread busy registers round-robin over businesses so every business sees load.
  const byTenant = owners.map((o) => allRegisters.filter((r) => r.t === o.t));
  const busy: typeof allRegisters = [];
  for (let i = 0; busy.length < Math.min(Number(values.busy), allRegisters.length); i++) {
    const list = byTenant[i % byTenant.length]!;
    const r = list[Math.floor(i / byTenant.length)];
    if (r) busy.push(r);
  }
  const tillCount = Math.min(Number(values.tills), allRegisters.length - busy.length);
  const tillRegs = allRegisters.filter((r) => !busy.includes(r)).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / tillCount)) === 0).slice(0, tillCount);
  const shift = async (r: (typeof allRegisters)[number]) => {
    const open = (await call('GET', `/v1/cashier-sessions?registerId=${r.registerId}&status=OPEN`, r.token)).data as { id: string }[];
    if (open[0]) return open[0].id;
    return (await call('POST', '/v1/cashier-sessions', r.token, { registerId: r.registerId, openingFloat: '1000.00' }, { 'idempotency-key': randomUUID() })).id as string;
  };
  const registers = await Promise.all(busy.map(async (r, i) => ({ ...r, session: await shift(r), call: client(apis[i % INSTANCES]!.base) })));
  log(`${registers.length} busy registers with open shifts; ${tillRegs.length} offline tills`);

  // ---- a cashier at one register
  const deadline = performance.now() + DURATION_MS;
  warmUntil = performance.now() + WARMUP_MS;
  const intervalMs = 60_000 / RATE;
  const cashier = async (r: (typeof registers)[number]) => {
    const hot = r.t.hot;
    const call = r.call;
    await sleep(Math.random() * intervalMs); // registers do not start in step
    while (performance.now() < deadline) {
      const next = performance.now() + intervalMs * (0.8 + Math.random() * 0.4);
      try {
        const lines = Array.from({ length: 1 + Math.floor(Math.random() * 5) }, () => hot[Math.floor(Math.random() * hot.length)]!);
        for (const l of lines) await timed('lookup', () => call('GET', `/v1/catalog/lookup?code=${l.barcode}&branchId=${r.branchId}`, r.token));
        const cart = lines.map((l) => ({ variantId: l.variantId, quantity: String(1 + Math.floor(Math.random() * 3)) }));
        const quote = await timed('quote', () => call('POST', '/v1/tax/quote', r.token, { branchId: r.branchId, lines: cart }));
        const body = { cashierSessionId: r.session, clientTransactionId: randomUUID(), lines: cart, tenders: [{ method: 'CASH', tendered: '100000.00' }] };
        const headers = { 'idempotency-key': randomUUID() };
        const sale = await timed('checkout', () => call('POST', '/v1/sales', r.token, body, headers));
        if (!quote.totals?.amountDue || quote.totals.amountDue !== sale.amountDue) (errors.quoteVsSale ??= {})[`${quote.totals?.amountDue} vs ${sale.amountDue}`] = 1;
        recorded.set(body.clientTransactionId, { saleId: sale.id, tenantId: r.t.tenantId });
        if (Math.random() < RETRY) {
          const again = await timed('checkoutReplay', () => call('POST', '/v1/sales', r.token, body, headers));
          replays++;
          if (again.id !== sale.id) replayMismatches++;
        }
      } catch {
        // counted in errors; the cashier carries on
      }
      await sleep(Math.max(0, next - performance.now()));
    }
  };

  // ---- a desktop till that was offline: snapshot, 50 sales on board, then sync (own process, till.ts)
  const till = async (r: (typeof allRegisters)[number], i: number) => {
    await sleep(WARMUP_MS + ((DURATION_MS - WARMUP_MS) / 2) * (i / Math.max(1, tillRegs.length))); // spread over the first half
    await shift(r); // offline sales are recorded on the register's open shift
    const reg = await call('POST', '/v1/terminals', r.token, { registerId: r.registerId, name: `Load till ${i}` });
    const me = await call('GET', '/v1/me', r.token);
    const cfg = { base: apis[i % INSTANCES]!.base, terminalId: reg.terminal.id, credential: reg.credential, cashierUserId: me.userId, sales: 50, variants: r.t.hot.slice(i * 7 % r.t.hot.length).map((h) => h.variantId) };
    const out = await new Promise<string>((ok, fail) => {
      const child = fork(fileURLToPath(new URL('./till.ts', import.meta.url)), [JSON.stringify(cfg)], { execArgv: process.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let text = '';
      child.stdout!.on('data', (d) => (text += d));
      child.stderr!.on('data', (d) => (text += d));
      child.on('error', fail);
      child.on('exit', (code) => (code === 0 ? ok(text) : fail(new Error(`till exited ${code}: ${text.slice(-500)}`))));
    });
    const res = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!) as { snapshotMs: number; syncMs: number; attempts: number; recorded: number; errors: string[] };
    (samples.snapshot ??= []).push(res.snapshotMs);
    tillAttempts.push(res.attempts);
    for (const e of res.errors) (errors.tillAttempt ??= {})[e] = (errors.tillAttempt![e] ?? 0) + 1;
    if (res.recorded !== 50) throw new Error(`sync of 50: ${res.recorded} recorded after ${res.attempts} attempts`);
    (samples.sync50 ??= []).push(res.syncMs);
    tillSales += 50;
  };

  log(`selling for ${DURATION_MS / 1000} s at ${RATE}/min per busy register (${((registers.length * RATE) / 60).toFixed(1)} checkouts/s offered)`);
  const profiling = profiler ? sleep(WARMUP_MS).then(() => profiler.start()) : null;
  await Promise.all([
    ...registers.map(cashier),
    ...tillRegs.map((r, i) => till(r, i).catch((e) => {
      const k = (e as Error).message.slice(0, 120);
      (errors.till ??= {})[k] = (errors.till![k] ?? 0) + 1;
    })),
  ]);
  log(`selling done: ${recorded.size} checkouts, ${replays} replays, ${tillSales} till sales synced`);
  if (profiler) {
    await profiling;
    const p = await profiler.stop();
    const file = join(ROOT, '.load', `api-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.cpuprofile`);
    writeFileSync(file, JSON.stringify(p.profile));
    cpu = { file, packages: p.packages, hottest: p.hottest };
    log(`CPU profile of instance 1: ${file}`);
  }

  // ---- reports for 31 days, every branch of the first five businesses
  const from = ymd(new Date(today.getTime() - 30 * 86_400_000));
  const to = ymd(today);
  for (const o of owners.slice(0, 5)) {
    for (const b of o.t.branches) {
      for (const rep of ['sales-summary', 'by-product', 'by-cashier', 'by-tender', 'tax-summary']) {
        await timed('report31d', () => call('GET', `/v1/reports/${rep}?branchId=${b.id}&from=${from}&to=${to}`, o.token)).catch(() => undefined);
      }
    }
  }
  log('reports done');
} finally {
  clearInterval(scraper);
  harnessLoop.disable();
  await Promise.all(apis.map((a) => a.stop()));
}

// ---- what the database holds
const db = new pg.Client({ connectionString: adminUrl() });
await db.connect();
const { rows: [check] } = await db.query<{ online: number; offline: number; dup: number }>(
  `SELECT count(*) FILTER (WHERE origin = 'ONLINE')::int AS online, count(*) FILTER (WHERE origin = 'OFFLINE')::int AS offline,
          (SELECT count(*)::int FROM (SELECT tenant_id, client_transaction_id FROM sales GROUP BY 1, 2 HAVING count(*) > 1) d) AS dup
     FROM sales WHERE completed_at >= $1`,
  [startedAt],
);
const ids = [...recorded.values()].map((r) => r.saleId);
const { rows: [found] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sales WHERE id = ANY ($1::uuid[])', [ids]);
const { rows: [size] } = await db.query<{ sales: number; products: number; movements: number }>(
  `SELECT (SELECT count(*)::int FROM sales) AS sales, (SELECT count(*)::int FROM product_variants) AS products, (SELECT count(*)::int FROM stock_movements) AS movements`,
);
await db.end();

const results = Object.fromEntries(Object.entries(samples).map(([op, s]) => [op, summarize(s)]));
const verdicts = Object.entries(TARGETS).map(([op, t]) => {
  const r = results[op];
  if (!r) return { op, verdict: 'not measured' };
  const fails = (['p95', 'p99', 'max'] as const).filter((k) => t[k] !== undefined && r[k] > t[k]!).map((k) => `${k} ${r[k]} > ${t[k]}`);
  return { op, verdict: fails.length ? `MISSED (${fails.join(', ')})` : 'met', target: t };
});
const integrity = {
  checkoutsRecorded: recorded.size,
  foundInDatabase: found!.n,
  onlineSalesInWindow: check!.online,
  offlineSalesInWindow: check!.offline,
  tillSalesSynced: tillSales,
  duplicateClientTransactions: check!.dup,
  replays,
  replayMismatches,
  ok: found!.n === recorded.size && check!.dup === 0 && replayMismatches === 0 && check!.online === recorded.size && check!.offline === tillSales,
};
const report = {
  machine: { note: 'measured on this machine (developer laptop, Docker Postgres), not a production figure', cpus: cpus().length, cpu: cpus()[0]?.model, memGb: Math.round(totalmem() / 1e9) },
  dataset: { ...seed.scale, databaseRows: size },
  run: { instances: INSTANCES, durationS: DURATION_MS / 1000, warmupS: WARMUP_MS / 1000, tills: Number(values.tills), busyRegisters: Number(values.busy), ratePerMin: RATE, offeredPerS: (Number(values.busy) * RATE) / 60, achievedCheckoutsPerS: recorded.size / (DURATION_MS / 1000) },
  latencyMs: results,
  tillSyncAttempts: tillAttempts,
  slowRequests: { count: slow.length, bySecond: Object.entries(slow.reduce<Record<string, number>>((m, s) => ((m[Math.floor(s.atS)] = (m[Math.floor(s.atS)] ?? 0) + 1), m), {})) },
  cpuProfile: cpu,
  stalls: { apiEventLoopWorstP99Ms: apiLoop.worstP99Ms, apiDbPoolWaitingMax: apiLoop.poolWaitingMax, harnessEventLoopMaxMs: Math.round(harnessLoop.max / 1e6) },
  errors,
  targets: verdicts,
  integrity,
};
const out = join(ROOT, '.load', `onepos_load.run-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
log(`report: ${out}`);
process.exit(integrity.ok ? 0 : 1);
