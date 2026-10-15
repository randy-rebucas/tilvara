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
