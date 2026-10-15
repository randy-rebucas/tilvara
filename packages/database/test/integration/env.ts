import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
} catch {
  // CI provides variables directly.
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for integration tests (see .env.example)`);
  if (!/onepos_test/.test(v)) throw new Error(`${name} must point at the onepos_test database`);
  return v;
}

export const TEST_DATABASE_URL = required('TEST_DATABASE_URL');
export const TEST_DATABASE_MIGRATOR_URL = required('TEST_DATABASE_MIGRATOR_URL');
