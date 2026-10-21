import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// One connection runs one query at a time. pg 8 queues a second one (deprecated) and pg 9 refuses it,
// so any code that issues a query while another is running on the same client (e.g. Promise.all over
// a transaction's queries; use inSequence) fails here, every time, naming the query.
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function guardedQuery(this: pg.Client & { _activeQuery?: unknown; _queryQueue?: unknown[] }, ...args: unknown[]) {
  if (this._activeQuery || (this._queryQueue?.length ?? 0) > 0) {
    const first = args[0] as string | { text?: string } | undefined;
    const text = (typeof first === 'string' ? first : (first?.text ?? '')).replace(/\s+/g, ' ').slice(0, 120);
    // Rejected like a failed query (not thrown), so the caller's ROLLBACK path runs as it would in pg 9;
    // printed too, because the API turns it into a plain 500.
    const err = new Error(`concurrent query on one pg client (pg 9 refuses it): ${text}`);
    console.error(err.message);
    return Promise.reject(err);
  }
  return (query as (...a: unknown[]) => unknown).apply(this, args);
} as typeof query;

try {
  loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
} catch {
  // CI provides variables directly.
}

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.includes('onepos_test')) {
  throw new Error('TEST_DATABASE_URL must point at the onepos_test database');
}
// The app under test must never touch the dev database.
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.RATE_LIMITS_ENABLED = 'false';
// Many apps run at once in the suites: none binds the metrics port (monitoring.test.ts uses an ephemeral one).
process.env.API_METRICS_PORT = '0';
// The night audit (ADR-0023 §7) runs only when a test calls it.
process.env.NIGHT_AUDIT_INTERVAL_MS = '0';
// Apps under test count rate limits in memory unless a test opts into Redis (with its own prefix),
// so leftover counters from an earlier run can never change a result.
if (process.env.REDIS_URL && !process.env.TEST_REDIS_URL) process.env.TEST_REDIS_URL = process.env.REDIS_URL;
delete process.env.REDIS_URL;
