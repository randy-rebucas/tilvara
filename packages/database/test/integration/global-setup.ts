import { runMigrations } from '../../src/migrate.js';
import { TEST_DATABASE_MIGRATOR_URL } from './env.js';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_MIGRATOR_URL);
}
