import { runMigrations } from '@1pos/database';
import './setup-env.js';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_MIGRATOR_URL;
  if (!url || !url.includes('onepos_test')) throw new Error('TEST_DATABASE_MIGRATOR_URL must point at onepos_test');
  await runMigrations(url);
}
