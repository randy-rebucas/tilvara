import { runMigrations } from '@1pos/database';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export default async function setup(): Promise<void> {
  try {
    loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch {
    // CI provides variables directly.
  }
  const url = process.env.TEST_DATABASE_MIGRATOR_URL;
  if (!url || !url.includes('onepos_test')) throw new Error('TEST_DATABASE_MIGRATOR_URL must point at onepos_test');
  await runMigrations(url);
}
