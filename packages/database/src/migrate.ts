import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface MigrationHead {
  /** Number of migrations. */
  count: number;
  /** `when` of the newest one; drizzle stores it as `created_at` in `drizzle.__drizzle_migrations`. */
  lastWhen: number;
}

/** The migration head this build expects, read from the journal shipped with the package. */
export function expectedMigrationHead(folder = MIGRATIONS_FOLDER): MigrationHead {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] };
  return { count: journal.entries.length, lastWhen: Math.max(...journal.entries.map((e) => e.when)) };
}

/** Apply all pending migrations. Must connect as the schema owner (onepos_migrator). */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied'))
    .catch((err: unknown) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
