/**
 * One desktop till for the load harness, in its own process (its SQLite is synchronous and would
 * stall the harness's event loop). Fetches a snapshot, rings up `sales` sales on board, then syncs
 * the way the real till does: one batch, and after no answer or a 5xx the same envelopes again
 * (the server replays what it already recorded) until every sale has a final answer or 2 minutes
 * pass. Prints one JSON line: snapshot time, time until all were recorded, attempts, errors seen.
 * Started by run.ts with argv[2] = JSON config.
 */
import { httpTransport, LocalStore, OfflineEngine } from '@1pos/pos-offline';
import { nodeSqliteDriver } from '@1pos/pos-offline/node-sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = JSON.parse(process.argv[2]!) as {
  base: string;
  terminalId: string;
  credential: string;
  cashierUserId: string;
  variants: string[];
  sales: number;
};

const engine = new OfflineEngine({
  store: new LocalStore(nodeSqliteDriver(join(mkdtempSync(join(tmpdir(), '1pos-load-till-')), 'till.db'))),
  // The desktop till's own timeout (httpTransport default 15 s).
  transport: httpTransport({ baseUrl: cfg.base, terminalId: cfg.terminalId, credential: cfg.credential }),
  batchSize: cfg.sales,
  baseBackoffMs: 500,
});
await engine.open();
let t = performance.now();
await engine.refreshSnapshot();
const snapshotMs = performance.now() - t;
for (let n = 0; n < cfg.sales; n++) {
  await engine.ringUp({ cashierUserId: cfg.cashierUserId, lines: [{ variantId: cfg.variants[n % cfg.variants.length]!, quantity: '1' }], tendered: '1000' });
}
t = performance.now();
const recorded = new Set<string>(); // a retry also answers (replayed) for sales recorded the first time
let attempts = 0;
const errors: string[] = [];
while (recorded.size < cfg.sales && performance.now() - t < 120_000) {
  const res = await engine.syncOnce();
  if (res.sent === 0) {
    await new Promise((r) => setTimeout(r, 200)); // backing off: nothing due yet
    continue;
  }
  attempts++;
  if (res.error) errors.push(`${res.error.code}`);
  for (const x of res.results) if (x.status === 'RECORDED') recorded.add(x.terminalTxnId);
}
console.log(JSON.stringify({ snapshotMs, syncMs: performance.now() - t, attempts, recorded: recorded.size, errors }));
