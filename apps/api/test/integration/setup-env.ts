import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

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
// Apps under test count rate limits in memory unless a test opts into Redis (with its own prefix),
// so leftover counters from an earlier run can never change a result.
if (process.env.REDIS_URL && !process.env.TEST_REDIS_URL) process.env.TEST_REDIS_URL = process.env.REDIS_URL;
delete process.env.REDIS_URL;
